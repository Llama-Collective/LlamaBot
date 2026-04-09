import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import Path from 'path';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';
import yauzl from 'yauzl';
import nbt from 'prismarine-nbt';
import { safeJoinPath, safeResolvePath, safeWorkspacePath } from './SafePath.js';

const MAX_ENTRY_UNCOMPRESSED_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB per entry
const MAX_TOTAL_UNCOMPRESSED_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB overall
const MAX_ENTRIES = 20000;

const MC_SELECTOR_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_LEVEL_DAT_BYTES = 64 * 1024 * 1024; // 64 MB

const ARTIFICIAL_BLOCKS = [
    "slime_block",
    "sponge",
    "netherite_block",
    "powered_rail",
    "note_block",
    "detector_rail",
    "piston",
    "iron_block",
    "diamond_block",
    "emerald_block",
    "beacon",
    "activator_rail",
    "redstone_lamp",
    "redstone_block",
    "enchanting_table",
    "anvil",
    "chipped_anvil",
    "damaged_anvil",
    "comparator",
    "trapped_chest",
    "daylight_detector",
    "quartz_block",
    "quartz_pillar",
    "chiseled_quartz_block",
    "iron_trapdoor",
    "coal_block",
    "shulker_box",
    "observer",
    "white_concrete",
    "orange_concrete",
    "magenta_concrete",
    "light_blue_concrete",
    "yellow_concrete",
    "lime_concrete",
    "pink_concrete",
    "gray_concrete",
    "light_gray_concrete",
    "cyan_concrete",
    "purple_concrete",
    "blue_concrete",
    "brown_concrete",
    "green_concrete",
    "red_concrete",
    "black_concrete",
    "white_concrete_powder",
    "orange_concrete_powder",
    "light_blue_concrete_powder",
    "yellow_concrete_powder",
    "lime_concrete_powder",
    "pink_concrete_powder",
    "gray_concrete_powder",
    "light_gray_concrete_powder",
    "cyan_concrete_powder",
    "purple_concrete_powder",
    "blue_concrete_powder",
    "brown_concrete_powder",
    "green_concrete_powder",
    "red_concrete_powder",
    "black_concrete_powder",
    "dragon_egg",
    "honey_block",
    "white_stained_glass",
    "orange_stained_glass",
    "magenta_stained_glass",
    "light_blue_stained_glass",
    "yellow_stained_glass",
    "lime_stained_glass",
    "pink_stained_glass",
    "gray_stained_glass",
    "light_gray_stained_glass",
    "cyan_stained_glass",
    "purple_stained_glass",
    "blue_stained_glass",
    "brown_stained_glass",
    "green_stained_glass",
    "red_stained_glass",
    "black_stained_glass",
    "tinted_glass",
    "orange_stained_glass_pane",
    "magenta_stained_glass_pane",
    "light_blue_stained_glass_pane",
    "lime_stained_glass_pane",
    "pink_stained_glass_pane",
    "gray_stained_glass_pane",
    "light_gray_stained_glass_pane",
    "cyan_stained_glass_pane",
    "purple_stained_glass_pane",
    "blue_stained_glass_pane",
    "brown_stained_glass_pane",
    "green_stained_glass_pane",
    "red_stained_glass_pane",
    "black_stained_glass_pane",
    "nether_portal",
    "conduit",
    "honeycomb_block",
    "hopper",
    "waxed_copper_block",
    "waxed_cut_copper",
    "waxed_cut_copper_slab",
    "waxed_cut_copper_stairs",
    "waxed_exposed_copper",
    "waxed_exposed_cut_copper",
    "waxed_exposed_cut_copper_slab",
    "waxed_exposed_cut_copper_stairs",
    "waxed_weathered_copper",
    "waxed_weathered_cut_copper",
    "waxed_weathered_cut_copper_slab",
    "waxed_weathered_cut_copper_stairs",
    "waxed_oxidized_copper",
    "waxed_oxidized_cut_copper",
    "waxed_oxidized_cut_copper_slab",
    "waxed_oxidized_cut_copper_stairs",
    "copper_block",
    "cut_copper",
    "cut_copper_slab",
    "cut_copper_stairs",
    "exposed_copper",
    "exposed_cut_copper",
    "exposed_cut_copper_slab",
    "exposed_cut_copper_stairs",
    "weathered_copper",
    "weathered_cut_copper",
    "weathered_cut_copper_slab",
    "weathered_cut_copper_stairs",
    "oxidized_copper",
    "oxidized_cut_copper",
    "oxidized_cut_copper_slab",
    "oxidized_cut_copper_stairs",
    "target",
    "repeater",
    "sticky_piston",
    "redstone_torch",
    "redstone_wire",
    "redstone_wall_torch",
    "dispenser",
    "dropper",
    "crafter"
];

const MC_SELECTOR_QUERY = `InhabitedTime = 0 AND !(Palette intersects "${ARTIFICIAL_BLOCKS.join(',')}")`;
const MC_SELECTOR_JAR = safeJoinPath(process.cwd(), 'java', 'mcaselector-2.7.jar');

export type WorldMetadata = {
    path: string; // always relative to root zip; nested zips separated by '/'
    version?: string;
    levelName?: string;
    error?: string;
};

type ExtractionBudget = {
    remainingBytes: number;
    perEntryLimit: number;
};

type ZipSource = { zipPath?: string; buffer?: Buffer };

type ArchiveContext = {
    relPath: string;           // '' for root, 'foo.zip', 'foo.zip/bar.zip', etc.
    extractDir: string;        // directory containing extracted contents
    zipOutputPath?: string;    // where to write the zipped file for this archive inside its parent; undefined for root
};

/**
 * Optimize a WDL zip: extract (including nested zips), analyze worlds, run MCSelector on each world, and repackage.
 * Returns metadata for all worlds with paths relative to the input zip.
 */
export async function optimizeWorldsInZip(zipPath: string, tempDir: string, outputFile?: string): Promise<{ zipPath: string; worlds: WorldMetadata[] }> {
    const tempRoot = safeWorkspacePath(tempDir);
    const sourceZipPath = safeWorkspacePath(zipPath);
    await fs.mkdir(tempRoot, { recursive: true });

    const sessionRoot = tempRoot;
    const rootExtractDir = safeJoinPath(sessionRoot, 'root');
    await fs.mkdir(rootExtractDir, { recursive: true });

    const outputZipPath = outputFile
        ? (Path.isAbsolute(outputFile) ? safeWorkspacePath(outputFile) : safeResolvePath(tempRoot, outputFile))
        : safeJoinPath(
            tempRoot,
            `${Path.basename(zipPath, Path.extname(zipPath)) || 'world'}-optimized-${Date.now().toString(36)}.zip`
        );

    await fs.mkdir(Path.dirname(outputZipPath), { recursive: true }).catch(() => { });

    await fs.access(MC_SELECTOR_JAR).catch(() => {
        throw new Error(`MCSelector jar not found at ${MC_SELECTOR_JAR}`);
    });

    const budget: ExtractionBudget = {
        remainingBytes: MAX_TOTAL_UNCOMPRESSED_BYTES,
        perEntryLimit: MAX_ENTRY_UNCOMPRESSED_BYTES
    };
    const contexts: ArchiveContext[] = [];
    let nestedCounter = 0;
    await extractArchiveRecursive({
        source: { zipPath: sourceZipPath },
        relPath: '',
        extractDir: rootExtractDir,
        getNextExtractDir: (suffix: string) => safeJoinPath(sessionRoot, `nested-${nestedCounter++}-${suffix}`),
        budget,
        contexts
    });

    const worlds = await analyzeExtractedWorlds(contexts);
    if (worlds.length === 0) {
        throw new Error('No Minecraft world folders (containing level.dat) found in the archive');
    }

    await optimizeWorlds(worlds, contexts);
    await repackageArchives(contexts, outputZipPath);

    const orderedWorlds = orderWorlds(worlds);
    return { zipPath: outputZipPath, worlds: orderedWorlds };
}

/**
 * Analyze a WDL zip (file path or buffer) without writing to disk. Returns metadata with paths relative to the zip root.
 */
export async function findWorldsInZip(zipSource: string | Buffer, budget?: ExtractionBudget): Promise<WorldMetadata[]> {
    const sessionBudget: ExtractionBudget = budget ?? {
        remainingBytes: MAX_TOTAL_UNCOMPRESSED_BYTES,
        perEntryLimit: MAX_ENTRY_UNCOMPRESSED_BYTES
    };
    const source: ZipSource = typeof zipSource === 'string' ? { zipPath: safeWorkspacePath(zipSource) } : { buffer: zipSource };
    const worlds = await analyzeZipRecursive(source, '', sessionBudget);
    return orderWorlds(worlds);
}

// -------- Extraction --------

async function extractArchiveRecursive(params: {
    source: ZipSource;
    relPath: string;
    extractDir: string;
    getNextExtractDir: (suffix: string) => string;
    budget: ExtractionBudget;
    contexts: ArchiveContext[];
}): Promise<void> {
    const { source, relPath, extractDir, getNextExtractDir, budget, contexts } = params;
    contexts.push({ relPath, extractDir, zipOutputPath: relPath ? extractDir.replace(/\/$/, '') : undefined });

    await extractArchiveContents({
        source,
        relPath,
        extractDir,
        getNextExtractDir,
        budget,
        contexts
    });
}

async function extractArchiveContents(params: {
    source: ZipSource;
    relPath: string;
    extractDir: string;
    getNextExtractDir: (suffix: string) => string;
    budget: ExtractionBudget;
    contexts: ArchiveContext[];
}): Promise<void> {
    const { source, relPath, extractDir, getNextExtractDir, budget, contexts } = params;
    await fs.mkdir(extractDir, { recursive: true });

    const zipfile = await openZipSource(source);

    await new Promise<void>((resolve, reject) => {
        let finished = false;
        let entryCount = 0;
        const rootWithSep = extractDir.endsWith(Path.sep) ? extractDir : `${extractDir}${Path.sep}`;
        const takenPaths = new Map<string, 'file' | 'dir'>(); // avoid collisions


        const fail = (error: unknown) => {
            if (finished) return;
            finished = true;
            zipfile.close();
            reject(error instanceof Error ? error : new Error(String(error)));
        };

        const succeed = () => {
            if (finished) return;
            finished = true;
            zipfile.close();
            resolve();
        };

        const uniquePath = (desired: string, isDir: boolean): string => {
            let candidate = desired;
            let counter = 1;
            while (takenPaths.has(candidate)) {
                const dir = Path.dirname(desired);
                const base = Path.basename(desired);
                const ext = isDir ? '' : Path.extname(base);
                const name = isDir ? base : Path.basename(base, ext);
                candidate = safeJoinPath(dir, `${name}__dup${counter}${ext}`);
                counter += 1;
            }
            return candidate;
        };

        const handleEntry = async (entry: yauzl.Entry) => {
            entryCount += 1;
            if (entryCount > MAX_ENTRIES) {
                throw new Error(`Zip archive has too many entries (>${MAX_ENTRIES})`);
            }

            const normalized = normalizeEntryPath(entry.fileName);
            if (normalized.startsWith('../') || Path.posix.isAbsolute(normalized)) {
                throw new Error(`Path traversal detected for entry ${entry.fileName}`);
            }

            if (normalized === '__MACOSX' || normalized.startsWith('__MACOSX/')) {
                zipfile.readEntry();
                return;
            }

            const targetPath = safeJoinPath(extractDir, normalized);
            const resolvedTarget = Path.resolve(targetPath);
            if (resolvedTarget !== extractDir && !resolvedTarget.startsWith(rootWithSep)) {
                throw new Error(`Entry resolves outside extraction root: ${entry.fileName}`);
            }

            const mode = entry.externalFileAttributes >>> 16;
            const isSymlink = (mode & 0o170000) === 0o120000;
            if (isSymlink) {
                throw new Error(`Symlink entries are not allowed (${entry.fileName})`);
            }

            if (entry.uncompressedSize > budget.perEntryLimit) {
                throw new Error(`Entry ${entry.fileName} exceeds per-file size limit (${entry.uncompressedSize} bytes)`);
            }
            if (entry.uncompressedSize > budget.remainingBytes) {
                throw new Error('Archive uncompressed size exceeds safety limit');
            }

            const isDirectory = normalized.endsWith('/');
            if (isDirectory) {
                const target = uniquePath(resolvedTarget, true);
                takenPaths.set(target, 'dir');
                await fs.mkdir(target, { recursive: true });
                zipfile.readEntry();
                return;
            }

            const target = uniquePath(resolvedTarget, false);
            takenPaths.set(target, 'file');
            await fs.mkdir(Path.dirname(target), { recursive: true });

            await new Promise<void>((res, rej) => {
                zipfile.openReadStream(entry, (openErr, readStream) => {
                    if (openErr || !readStream) {
                        rej(openErr ?? new Error(`Failed to read entry ${entry.fileName}`));
                        return;
                    }

                    pipeline(readStream, createWriteStream(target, { flags: 'wx' }))
                        .then(() => {
                            budget.remainingBytes -= entry.uncompressedSize;
                            res();
                        })
                        .catch(rej);
                });
            });

            const isZip = normalized.toLowerCase().endsWith('.zip');
            if (isZip) {
                const nestedRel = combineRelPath(relPath, normalized);
                const folderName = Path.basename(normalized);
                const nestedDir = getNextExtractDir(folderName);
                await extractArchiveRecursive({
                    source: { zipPath: target },
                    relPath: nestedRel,
                    extractDir: nestedDir,
                    getNextExtractDir,
                    budget,
                    contexts
                });
                // The nested archive will be rezipped back to target path later
                const ctx = contexts.find((c) => c.relPath === nestedRel);
                if (ctx) {
                    ctx.zipOutputPath = target;
                }
            }

            zipfile.readEntry();
        };

        zipfile.on('entry', (entry) => {
            handleEntry(entry).catch(fail);
        });
        zipfile.on('end', () => succeed());
        zipfile.on('error', (error) => fail(error));
        zipfile.readEntry();
    });
}

// -------- Analysis over extracted data --------

async function analyzeExtractedWorlds(contexts: ArchiveContext[]): Promise<WorldMetadata[]> {
    const worlds: WorldMetadata[] = [];
    for (const ctx of contexts) {
        const worldDirs = await findWorldFolders(ctx.extractDir);
        for (const dir of worldDirs) {
            const relInside = Path.relative(ctx.extractDir, dir).split(Path.sep).join(Path.posix.sep) || '.';
            const worldPath = ctx.relPath ? `${ctx.relPath}/${relInside}` : relInside;
            const meta = await parseWorldMetadataFromDisk(dir, worldPath);
            worlds.push(meta);
        }
    }
    return worlds;
}

async function parseWorldMetadataFromDisk(worldDir: string, relativePath: string): Promise<WorldMetadata> {
    const meta: WorldMetadata = { path: relativePath };
    const levelDatPath = safeJoinPath(worldDir, 'level.dat');
    try {
        const stats = await fs.stat(levelDatPath);
        if (stats.size > MAX_LEVEL_DAT_BYTES) {
            meta.error = `level.dat exceeds size limit (${stats.size} bytes)`;
            return meta;
        }
        const buffer = await fs.readFile(levelDatPath);
        return await parseWorldMetadataFromBuffer(relativePath, buffer);
    } catch (error: any) {
        meta.error = error?.message || 'Failed to parse level.dat';
        return meta;
    }
}

async function parseWorldMetadataFromBuffer(worldPath: string, buffer: Buffer): Promise<WorldMetadata> {
    const meta: WorldMetadata = { path: worldPath };
    try {
        const parsed = await nbt.parse(buffer);
        const data = parsed.parsed as any;
        const dataTag = data?.value?.Data;
        const versionTag = dataTag?.value?.Version;
        const versionName = versionTag?.value?.Name;
        const versionValue = versionName?.value;
        if (typeof versionValue === 'string' && versionValue.trim().length > 0) {
            meta.version = versionValue;
        } else {
            meta.error = 'Invalid version';
        }

        const levelNameTag = dataTag?.value?.LevelName;
        const levelNameValue = levelNameTag?.value;
        if (typeof levelNameValue === 'string' && levelNameValue.trim().length > 0) {
            meta.levelName = levelNameValue;
        }
    } catch (error: any) {
        meta.error = error?.message || 'Failed to parse level.dat';
    }
    return meta;
}

// -------- Optimization --------
async function optimizeWorlds(worlds: WorldMetadata[], contexts: ArchiveContext[]): Promise<void> {
    const worldPathsByRelative = new Map<string, string>(); // relative -> absolute world dir
    for (const ctx of contexts) {
        const worldDirs = await findWorldFolders(ctx.extractDir);
        for (const dir of worldDirs) {
            const relInside = Path.relative(ctx.extractDir, dir).split(Path.sep).join(Path.posix.sep) || '.';
            const key = ctx.relPath ? `${ctx.relPath}/${relInside}` : relInside;
            worldPathsByRelative.set(key, dir);
        }
    }

    const concurrency = 4;
    let index = 0;

    const runNext = async (): Promise<void> => {
        while (index < worlds.length) {
            const current = index++;
            const world = worlds[current];
            const abs = worldPathsByRelative.get(world.path);
            if (!abs) continue;
            await optimizeWorld(abs);
        }
    };

    const workers = Array.from({ length: Math.min(concurrency, worlds.length) }, () => runNext());
    await Promise.all(workers);
}

async function optimizeWorld(worldDir: string): Promise<void> {
    // New wdl formats (26.1+) have a "dimensions" folder instead of separate DIM-1/DIM1 folders
    const dimensionsPath = safeJoinPath(worldDir, 'dimensions', 'minecraft');
    const hasDimensionsFolder = await fs.stat(dimensionsPath).then((s) => s.isDirectory()).catch(() => false);
    if (hasDimensionsFolder) {
        for (const dim of ['overworld', 'the_nether', 'the_end']) {
            const dimPath = safeJoinPath(dimensionsPath, dim);
            const stat = await fs.stat(dimPath).catch(() => null);
            if (stat && stat.isDirectory()) {
                await runMcSelector(dimPath);
            }
        }
    }

    // Legacy handling
    // If there is a region folder, run it on world root
    const regionPath = safeJoinPath(worldDir, 'region');
    const hasRegion = await fs.stat(regionPath).then((s) => s.isDirectory()).catch(() => false);
    if (hasRegion) {
        await runMcSelector(worldDir);
    }

    // if DIM-1, or DIM1 folder, run runMcSelector on those as well (legacy)
    for (const dim of ['DIM-1', 'DIM1']) {
        const dimPath = safeJoinPath(worldDir, dim);
        const stat = await fs.stat(dimPath).catch(() => null);
        if (stat && stat.isDirectory()) {
            await runMcSelector(dimPath);
        }
    }



    const pathsToKeep = [
        'region',
        'level.dat',
        'DIM-1',
        'DIM1',
        'dimensions',
        'icon.png',
        'entities'
    ]

    const entries = await fs.readdir(worldDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!pathsToKeep.includes(entry.name)) {
            const targetPath = safeJoinPath(worldDir, entry.name);
            await fs.rm(targetPath, { recursive: true, force: true }).catch(() => null);
        }
    }
}

async function runMcSelector(worldPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const args = ['-jar', MC_SELECTOR_JAR, '--mode', 'delete', '--query', MC_SELECTOR_QUERY, '--world', Path.resolve(worldPath)];
        const proc = spawn('java', args, { stdio: ['ignore', 'pipe', 'pipe'] });

        let stderr = '';
        let stdout = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            proc.kill('SIGKILL');
        }, MC_SELECTOR_TIMEOUT_MS);

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        proc.on('error', (error) => { clearTimeout(timer); reject(error); });
        proc.on('close', (code) => {
            clearTimeout(timer);
            if (timedOut) return reject(new Error(`Failed to optimize world at ${worldPath}: MCSelector timed out after ${MC_SELECTOR_TIMEOUT_MS}ms`));
            if (code === 0) return resolve();
            const message = stderr.trim() || stdout.trim() || `java exited with code ${code ?? 'unknown'}`;
            reject(new Error(`Failed to optimize world at ${worldPath}: ${message}`));
        });
    });
}

// -------- Repackaging --------

async function repackageArchives(contexts: ArchiveContext[], outputZipPath: string): Promise<void> {
    // Rezip nested archives first (deepest first), then root
    const depth = (relPath: string) => (relPath === '' ? 0 : relPath.split('/').length);
    const sorted = [...contexts].sort((a, b) => depth(b.relPath) - depth(a.relPath));
    for (const ctx of sorted) {
        const targetZip = ctx.relPath === '' ? outputZipPath : ctx.zipOutputPath;
        if (!targetZip) continue;
        await createZipFromDirectory(ctx.extractDir, targetZip);
    }
}

async function createZipFromDirectory(rootDir: string, outputZipPath: string): Promise<void> {
    const rootResolved = Path.resolve(rootDir);
    const entries = await fs.readdir(rootResolved);
    const relativePaths = entries.length === 0 ? ['.'] : entries;

    await fs.mkdir(Path.dirname(outputZipPath), { recursive: true });
    await fs.rm(outputZipPath, { force: true });

    try {
        const zipped = await tryZipBinary(rootResolved, relativePaths, outputZipPath);
        if (!zipped) {
            throw new Error('Unable to create zip: "zip" binary not available in PATH.');
        }
    } catch (error) {
        await fs.rm(outputZipPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

async function tryZipBinary(cwd: string, relativePaths: string[], outputZipPath: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const args = ['-r', '-9', outputZipPath, '--', ...relativePaths];
        const proc = spawn('zip', args, { cwd });
        let stderr = '';
        let stdout = '';
        let handled = false;

        const finish = (fn: () => void) => {
            if (handled) return;
            handled = true;
            fn();
        };

        proc.stdout.on('data', (data) => { stdout += data.toString(); });
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        proc.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return finish(() => resolve(false));
            finish(() => reject(error));
        });
        proc.on('close', (code) => {
            if (code === 0) return finish(() => resolve(true));
            const msg = stderr.trim() || stdout.trim() || `zip exited with code ${code ?? 'unknown'}`;
            finish(() => reject(new Error(msg)));
        });
    });
}

// -------- Read-only analysis (no writes) --------

async function analyzeZipRecursive(source: ZipSource, relPath: string, budget: ExtractionBudget): Promise<WorldMetadata[]> {
    const zipfile = await openZipSource(source);
    const results: WorldMetadata[] = [];

    await new Promise<void>((resolve, reject) => {
        let finished = false;
        let entryCount = 0;

        const fail = (error: unknown) => {
            if (finished) return;
            finished = true;
            zipfile.close();
            reject(error instanceof Error ? error : new Error(String(error)));
        };

        const succeed = () => {
            if (finished) return;
            finished = true;
            zipfile.close();
            resolve();
        };

        const handleEntry = async (entry: yauzl.Entry) => {
            entryCount += 1;
            if (entryCount > MAX_ENTRIES) throw new Error(`Zip archive has too many entries (>${MAX_ENTRIES})`);

            const normalized = normalizeEntryPath(entry.fileName);
            if (normalized.startsWith('../') || Path.posix.isAbsolute(normalized)) {
                throw new Error(`Path traversal detected for entry ${entry.fileName}`);
            }
            if (normalized === '__MACOSX' || normalized.startsWith('__MACOSX/')) {
                zipfile.readEntry();
                return;
            }

            const mode = entry.externalFileAttributes >>> 16;
            const isSymlink = (mode & 0o170000) === 0o120000;
            if (isSymlink) throw new Error(`Symlink entries are not allowed (${entry.fileName})`);

            const isDirectory = normalized.endsWith('/');
            if (isDirectory) {
                zipfile.readEntry();
                return;
            }

            const baseName = Path.posix.basename(normalized).toLowerCase();
            if (baseName === 'level.dat') {
                if (entry.uncompressedSize > budget.perEntryLimit || entry.uncompressedSize > MAX_LEVEL_DAT_BYTES) {
                    throw new Error(`Entry ${entry.fileName} exceeds per-file size limit (${entry.uncompressedSize} bytes)`);
                }
                if (entry.uncompressedSize > budget.remainingBytes) {
                    throw new Error('Archive uncompressed size exceeds safety limit');
                }
                const buffer = await readEntryToBuffer(zipfile, entry, budget);
                const worldDir = Path.posix.dirname(normalized);
                const worldPath = relPath ? `${relPath}/${worldDir || '.'}` : (worldDir || '.');
                const meta = await parseWorldMetadataFromBuffer(worldPath, buffer);
                results.push(meta);
                zipfile.readEntry();
                return;
            }

            if (normalized.toLowerCase().endsWith('.zip')) {
                if (entry.uncompressedSize > budget.perEntryLimit) {
                    throw new Error(`Entry ${entry.fileName} exceeds per-file size limit (${entry.uncompressedSize} bytes)`);
                }
                if (entry.uncompressedSize > budget.remainingBytes) {
                    throw new Error('Archive uncompressed size exceeds safety limit');
                }
                const buffer = await readEntryToBuffer(zipfile, entry, budget);
                const nestedRel = combineRelPath(relPath, normalized);
                const nestedResults = await analyzeZipRecursive({ buffer }, nestedRel, budget);
                results.push(...nestedResults);
                zipfile.readEntry();
                return;
            }

            zipfile.readEntry();
        };

        zipfile.on('entry', (entry) => { handleEntry(entry).catch(fail); });
        zipfile.on('end', () => succeed());
        zipfile.on('error', (error) => fail(error));
        zipfile.readEntry();
    });

    return results;
}

// -------- Shared helpers --------

function combineRelPath(parent: string, child: string): string {
    const cleanChild = child.replace(/\/$/, '');
    return parent ? `${parent}/${cleanChild}` : cleanChild;
}

function orderWorlds(worlds: WorldMetadata[]): WorldMetadata[] {
    const depth = (path: string) => (path === '' ? 0 : path.split('/').length);
    return [...worlds].sort((a, b) => {
        const da = depth(a.path);
        const db = depth(b.path);
        if (da !== db) return da - db;
        return a.path.localeCompare(b.path);
    });
}

function normalizeEntryPath(name: string): string {
    // Convert any backslashes to POSIX-style separators before normalizing
    return Path.posix.normalize(name.replace(/\\/g, '/'));
}

function openZipSource(source: ZipSource): Promise<yauzl.ZipFile> {
    const options = { lazyEntries: true, validateEntrySizes: true } as const;
    if (source.zipPath) {
        return new Promise((resolve, reject) => {
            yauzl.open(source.zipPath as string, options, (err, zipfile) => {
                if (err || !zipfile) return reject(err ?? new Error('Unable to open zip file'));
                resolve(zipfile);
            });
        });
    }

    if (source.buffer) {
        return new Promise((resolve, reject) => {
            yauzl.fromBuffer(source.buffer as Buffer, options, (err, zipfile) => {
                if (err || !zipfile) return reject(err ?? new Error('Unable to open zip buffer'));
                resolve(zipfile);
            });
        });
    }

    return Promise.reject(new Error('No zip source provided'));
}

function readEntryToBuffer(zipfile: yauzl.ZipFile, entry: yauzl.Entry, budget: ExtractionBudget): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        zipfile.openReadStream(entry, (openErr, readStream) => {
            if (openErr || !readStream) return reject(openErr ?? new Error(`Failed to read entry ${entry.fileName}`));

            const chunks: Buffer[] = [];
            let total = 0;
            let failed = false;

            const abort = (error: Error) => {
                if (failed) return;
                failed = true;
                readStream.destroy();
                reject(error);
            };

            readStream.on('data', (chunk: Buffer) => {
                total += chunk.length;
                if (total > budget.perEntryLimit || total > budget.remainingBytes) {
                    abort(new Error(`Entry ${entry.fileName} exceeds size limits during read`));
                    return;
                }
                chunks.push(chunk);
            });

            readStream.on('end', () => {
                if (failed) return;
                budget.remainingBytes -= total;
                resolve(Buffer.concat(chunks));
            });

            readStream.on('error', (err) => abort(err instanceof Error ? err : new Error(String(err))));
        });
    });
}

async function findWorldFolders(root: string): Promise<string[]> {
    const rootResolved = Path.resolve(root);
    const pending: string[] = [rootResolved];
    const worlds: string[] = [];

    while (pending.length > 0) {
        const dir = pending.pop() as string;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const hasLevelDat = entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === 'level.dat');
        if (hasLevelDat) {
            worlds.push(dir);
            continue;
        }

        for (const entry of entries) {
            if (entry.isDirectory()) {
                pending.push(safeJoinPath(dir, entry.name));
            }
        }
    }

    return worlds;
}
