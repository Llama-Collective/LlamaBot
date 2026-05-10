import { GuildHolder } from "../GuildHolder.js";
import fs from "fs/promises";
import { ConfigManager } from "../config/ConfigManager.js";
import { AnyThreadChannel, AttachmentBuilder, ChannelType, EmbedBuilder, ForumChannel, ForumLayoutType, GuildForumTag, GuildTextBasedChannel, Message, MessageFlags, PartialMessage, Snowflake } from "discord.js";
import { ArchiveChannelReference, RepositoryConfigs } from "./RepositoryConfigs.js";
import { areAuthorsSame, chunkArray, deepClone, escapeString, generateCommitMessage, getAuthorIconURL, getAuthorName, hasAttachmentNameChanged, getCodeAndDescriptionFromTopic, getGithubOwnerAndProject, mergeTwoArraysUnique, reclassifyAuthors, splitCode, splitIntoChunks, truncateStringWithEllipsis } from "../utils/Util.js";
import { ArchiveEntry, ArchiveEntryData } from "./ArchiveEntry.js";
import { Submission } from "../submissions/Submission.js";
import { SubmissionConfigs } from "../submissions/SubmissionConfigs.js";
import { ArchiveChannel, ArchiveEntryReference } from "./ArchiveChannel.js";
import { Lock } from "../utils/Lock.js";
import { PostEmbed } from "../embed/PostEmbed.js";
import { GuildConfigs } from "../config/GuildConfigs.js";
import { simpleGit, SimpleGit } from "simple-git";
import { ArchiveComment } from "./ArchiveComments.js";
import { Author, AuthorType } from "../submissions/Author.js";
import { SubmissionStatus } from "../submissions/SubmissionStatus.js";
import { makeEntryReadMe } from "./ReadMeMaker.js";
import { analyzeAttachments, deduplicateAttachmentNames, filterAttachmentsForViewer, getAttachmentsFromMessage, getFileKey, processAttachments, splitFileName } from "../utils/AttachmentUtils.js";
import { DictionaryManager } from "./DictionaryManager.js";
import { IndexManager } from "./IndexManager.js";
import { DiscordServersDictionary } from "./DiscordServersDictionary.js";
import { getDiscordServersFromReferences, ReferenceType, tagReferencesInAcknowledgements, tagReferencesInSubmissionRecords, transformOutputWithReferencesForEmbeddings } from "../utils/ReferenceUtils.js";
import { PersistentIndex, PersistentIndexChannel, PersistentIndexEntry, serializePersistentIndex } from "../utils/PersistentIndexUtils.js";
import { postToMarkdown } from "../utils/MarkdownUtils.js";
import { base64ToInt8Array, EmbeddingsEntry, EmbeddingsSearchResult as EmbeddingsSearchResult, generateDocumentEmbeddings, getClosestWithIndex, loadHNSWIndex, makeHNSWIndex } from "../llm/EmbeddingUtils.js";
import { type HierarchicalNSW } from "hnswlib-node";
import { TemporaryCache } from "./TemporaryCache.js";
import { AttachmentSource } from "../submissions/Attachment.js";
import { GlobalTag } from "./RepositoryConfigs.js";
import { Tag } from "../submissions/Tag.js";
import { PublishCommitMessage } from "../submissions/Publish.js";
import { safeJoinPath, safeWorkspacePath } from "../utils/SafePath.js";

export class RepositoryManager {
    public folderPath: string;
    private git?: SimpleGit;
    private configManager: ConfigManager;
    private lock: Lock = new Lock();
    private ignoreUpdatesFrom: Snowflake[] = [];
    private guildHolder: GuildHolder;
    private dictionaryManager: DictionaryManager;
    private indexManager: IndexManager;
    private branchName: string = 'main';
    private discordServersDictionary: DiscordServersDictionary;
    private hnswIndexCache: TemporaryCache<HierarchicalNSW | null>;
    private channelsCache: TemporaryCache<ArchiveChannelReference[]>;
    constructor(guildHolder: GuildHolder, folderPath: string, globalDiscordServersDictionary?: DiscordServersDictionary) {
        this.guildHolder = guildHolder;
        this.folderPath = safeWorkspacePath(folderPath);
        this.configManager = new ConfigManager(this.getConfigFilePath());
        this.dictionaryManager = new DictionaryManager(
            this.guildHolder,
            safeJoinPath(this.folderPath, 'dictionary'),
            safeJoinPath(this.guildHolder.getGuildFolder(), 'dictionary_submissions'),
            this
        );
        this.indexManager = new IndexManager(this.dictionaryManager, this, this.folderPath);
        this.dictionaryManager.setIndexManager(this.indexManager);
        this.discordServersDictionary = new DiscordServersDictionary(this.folderPath, this, globalDiscordServersDictionary);
        this.hnswIndexCache = new TemporaryCache<HierarchicalNSW | null>(5 * 60 * 1000, async () => {
            return await loadHNSWIndex(this.getHNSWIndexPath()).catch(() => null);
        });

        this.channelsCache = new TemporaryCache<ArchiveChannelReference[]>(10 * 60 * 1000, async () => {
            return this.loadChannelReferencesFromFile();
        });
    }

    getConfigFilePath(): string {
        return safeJoinPath(this.folderPath, 'config.json');
    }

    public async configChanged() {
        await this.lock.acquire();
        await this.configManager.saveConfig();
        await this.commit('Updated repository configuration', [this.getConfigFilePath()]).catch(() => { });
        await this.push().catch(() => { });
        await this.lock.release();
    }

    loadChannelReferencesFromFile(): Promise<ArchiveChannelReference[]> {
        const channelsPath = this.getChannelsFilePath();
        return fs.readFile(channelsPath, 'utf-8').then(data => JSON.parse(data) as ArchiveChannelReference[]).catch(() => []);
    }

    getChannelsFilePath(): string {
        return safeJoinPath(this.folderPath, 'channels.json');
    }

    async init() {
        await this.lock.acquire();
        // try to access the folder, create it if it doesn't exist
        if (!await fs.access(this.folderPath).then(() => true).catch(() => false)) {
            await fs.mkdir(this.folderPath, { recursive: true });
        }
        this.git = simpleGit(this.folderPath)
            .init()
            .addConfig('user.name', 'llamabot-archiver[bot]')
            .addConfig('user.email', '217070326+llamabot-archiver[bot]@users.noreply.github.com')
            .addConfig('pull.rebase', 'false')

        await this.git;

        // check if gitignore exists, create it if it doesn't
        const gitignorePath = safeJoinPath(this.folderPath, '.gitignore');
        if (!await fs.access(gitignorePath).then(() => true).catch(() =>
            false)) {
            await fs.writeFile(gitignorePath, '.DS_Store\n', 'utf-8');
            await this.git.add('.gitignore');
            await this.commit('Initial commit: add .gitignore');
        }

        // check if gitattributes exists, create it if it doesn't
        const gitattributesPath = safeJoinPath(this.folderPath, '.gitattributes');
        if (!await fs.access(gitattributesPath).then(() => true).catch(() =>
            false)) {
            const lfsExtensions = this.configManager.getConfig(RepositoryConfigs.LFS_EXTENSIONS);
            const lfsLines = lfsExtensions.map(ext => `*.${ext} filter=lfs diff=lfs merge=lfs -text`);
            await fs.writeFile(gitattributesPath, lfsLines.join('\n') + '\n', 'utf-8');
            await this.git.add('.gitattributes');
            await this.commit('Initial commit: add .gitattributes for LFS');
        }

        // Load the config manager
        await this.configManager.loadConfig();

        // set branch name
        this.branchName = await this.fetchBranchName().catch(() => 'main');

        try {
            await this.push();
        } catch (e: any) {
            console.error("Error pushing to remote:", e.message);
        }

        await this.dictionaryManager.init();
        // await this.dictionaryManager.migrateLegacyStorageAndUpdateGit();

        await this.lock.release();

        await this.indexManager.getPostToSubmissionIndex();
    }

    public async add(paths: string | string[]) {
        if (!this.git) {
            return;
        }
        await this.git.add(paths).catch(() => { });
    }

    public async rm(paths: string | string[]) {
        if (!this.git) {
            return;
        }
        await this.git.rm(paths).catch(() => { });
    }

    addToIgnoreUpdatesFrom(id: Snowflake) {
        if (!this.ignoreUpdatesFrom.includes(id)) {
            this.ignoreUpdatesFrom.push(id);
        }
    }

    removeFromIgnoreUpdatesFrom(id: Snowflake) {
        const index = this.ignoreUpdatesFrom.indexOf(id);
        if (index !== -1) {
            this.ignoreUpdatesFrom.splice(index, 1);
        }
    }

    public async getEmbeddings(): Promise<EmbeddingsEntry[]> {
        const embeddingPath = this.getEmbeddingPath();
        return fs.readFile(embeddingPath, 'utf-8')
            .then(data => JSON.parse(data) as EmbeddingsEntry[])
            .catch(() => []);
    }

    public getHNSWIndexPath(): string {
        return safeJoinPath(this.folderPath, 'hnsw.idx');
    }

    public async getEmbeddingsIndex(): Promise<HierarchicalNSW | null> {
        return this.hnswIndexCache.get();
    }

    public async getClosest(embedding: Int8Array, numNeighbors: number): Promise<EmbeddingsSearchResult[]> {
        const [index, embeddings] = await Promise.all([this.getEmbeddingsIndex(), this.getEmbeddings()]);
        if (!index || embeddings.length === 0) {
            return [];
        }
        return getClosestWithIndex(index, embeddings, embedding, numNeighbors);
    }

    public async buildPersistentIndexAndEmbeddings() {
        const authors = new Map<string, number>();
        const tags = new Map<string, number>();
        const categories = new Map<string, number>();

        const channelReferences = await this.getChannelReferences();

        channelReferences.sort((a, b) => a.position - b.position);

        const channels: PersistentIndexChannel[] = [];

        const embeddings = await this.getEmbeddings();
        const embeddingsMap = new Map<string, EmbeddingsEntry>(embeddings.map(e => [e.identifier, e]));
        const seenCodes = new Set<string>();
        const toRefreshEmbeddings = new Set<string>();

        let latestUpdate = 0;

        for (const channelRef of channelReferences) {
            const channelPath = safeJoinPath(this.folderPath, channelRef.path);
            const archiveChannel = await ArchiveChannel.fromFolder(channelPath);
            const entryRefs = archiveChannel.getData().entries;


            const entries: PersistentIndexEntry[] = [];

            const channelTags = new Set<number>();

            for (const entryRef of entryRefs) {
                const entryPath = safeJoinPath(channelPath, entryRef.path);
                const archiveEntry = await ArchiveEntry.fromFolder(entryPath);
                if (!archiveEntry) {
                    continue;
                }
                const entryData = archiveEntry.getData();

                // map authors
                const authorIndexes = entryData.authors.map(author => {
                    const name = getAuthorName(author);
                    if (!authors.has(name)) {
                        authors.set(name, authors.size);
                    }
                    return authors.get(name)!;
                });

                // map tags
                const tagIndexes = entryData.tags.map(tag => {
                    if (!tags.has(tag.name)) {
                        tags.set(tag.name, tags.size);
                    }
                    const tagIndex = tags.get(tag.name)!;
                    channelTags.add(tagIndex);
                    return tagIndex;
                });


                const currentCode = entryData.code;
                const pastCodes = entryData.reservedCodes.filter(code => code !== currentCode);
                entries.push({
                    id: entryData.id,
                    codes: [currentCode, ...pastCodes],
                    name: entryData.name,
                    authors: authorIndexes,
                    tags: tagIndexes,
                    path: entryRef.path,
                    archived_at: entryData.archivedAt,
                    updated_at: entryData.updatedAt,
                    main_image_path: entryData.images.length > 0 ? entryData.images[0].path || null : null
                });

                if (entryData.updatedAt > latestUpdate) {
                    latestUpdate = entryData.updatedAt;
                }

                seenCodes.add(currentCode);

                const embeddingEntry = embeddingsMap.get(currentCode);
                if (!embeddingEntry || embeddingEntry.updated_at !== entryData.updatedAt) {
                    toRefreshEmbeddings.add(entryPath);
                }
            }

            // map categories
            if (!categories.has(channelRef.category)) {
                categories.set(channelRef.category, categories.size);
            }
            const categoryIndex = categories.get(channelRef.category)!;

            channels.push({
                code: channelRef.code,
                name: channelRef.name,
                description: channelRef.description,
                category: categoryIndex,
                tags: Array.from(channelTags),
                path: channelRef.path,
                entries: entries
            })
        }

        const persistentIndex: PersistentIndex = {
            schemaStyles: this.configManager.getConfig(RepositoryConfigs.POST_STYLE),
            updated_at: latestUpdate,
            all_authors: Array.from(authors.keys()),
            all_tags: Array.from(tags.keys()),
            all_categories: Array.from(categories.keys()),
            channels: channels
        };

        const serialized = serializePersistentIndex(persistentIndex);

        const indexPath = this.getPersistentIndexPath();
        await fs.writeFile(indexPath, Buffer.from(serialized));

        await this.git?.add(indexPath);

        // now handle embeddings refresh
        const embeddingsToDelete: string[] = [];
        for (const embeddingEntry of embeddings) {
            if (!seenCodes.has(embeddingEntry.identifier)) {
                embeddingsToDelete.push(embeddingEntry.identifier);
            }
        }

        for (const code of embeddingsToDelete) {
            embeddingsMap.delete(code);
        }

        const toRefreshEmbeddingsChunked = chunkArray(Array.from(toRefreshEmbeddings), 60);
        for (const chunk of toRefreshEmbeddingsChunked) {
            const entries = (await Promise.all(chunk.map(async entryPath => {
                const archiveEntry = await ArchiveEntry.fromFolder(entryPath);
                if (!archiveEntry) {
                    return null;
                }
                const entryData = archiveEntry.getData();
                return entryData;
            }))).filter((e): e is ArchiveEntryData => e !== null);


            // get text
            const texts = entries.map(entryData => {
                const channelRef = channelReferences.find(c => c.code === splitCode(entryData.code).channelCode);
                const lines = [];
                lines.push('Name: ' + entryData.name);
                if (channelRef) {
                    lines.push('Category: ' + channelRef.category + ' > ' + channelRef.name);
                }
                lines.push('Tags: ' + entryData.tags.map(t => t.name).join(', '));
                lines.push('Authors: ' + entryData.authors.map(a => getAuthorName(a)).join(','));
                lines.push('')
                lines.push(transformOutputWithReferencesForEmbeddings(postToMarkdown(entryData.records, entryData.styles, persistentIndex.schemaStyles), entryData.references));
                return lines.join('\n');
            });

            const result = await generateDocumentEmbeddings(texts).catch((e) => {
                console.error("Error generating document embeddings for archive entries:", e);
                return null;
            });

            if (result === null) {
                continue;
            }

            for (let i = 0; i < entries.length; i++) {
                const entryData = entries[i];
                const embedding = result.embeddings[i];
                embeddingsMap.set(entryData.code, {
                    identifier: entryData.code,
                    updated_at: entryData.updatedAt,
                    embedding: embedding
                });
            }
        }

        if (toRefreshEmbeddings.size > 0 || embeddingsToDelete.length > 0) {
            const newEmbeddings = Array.from(embeddingsMap.values());
            await fs.writeFile(this.getEmbeddingPath(), JSON.stringify(newEmbeddings, null, 2), 'utf-8');
            await this.git?.add(this.getEmbeddingPath());

            await makeHNSWIndex(newEmbeddings.map(e => base64ToInt8Array(e.embedding)), this.getHNSWIndexPath());
            this.hnswIndexCache.clear();
            await this.git?.add(this.getHNSWIndexPath());
        }
    }


    public getPersistentIndexPath(): string {
        return safeJoinPath(this.folderPath, 'persistent.idx');
    }

    public getEmbeddingPath(): string {
        return safeJoinPath(this.folderPath, 'embeddings.json');
    }

    public async iterateAllEntries(callback: (entry: ArchiveEntry, entryRef: ArchiveEntryReference, channelRef: ArchiveChannelReference, channel: ArchiveChannel) => Promise<void>) {
        const channelReferences = await this.getChannelReferences();
        for (const channelRef of channelReferences) {
            const channelPath = safeJoinPath(this.folderPath, channelRef.path);
            const archiveChannel = await ArchiveChannel.fromFolder(channelPath);
            if (!archiveChannel) {
                console.warn(`Channel ${channelRef.name} (${channelRef.id}) not found in repository`);
                continue;
            }
            const entries = archiveChannel.getData().entries;
            for (const entryRef of entries) {
                const entryPath = safeJoinPath(channelPath, entryRef.path);
                const entry = await ArchiveEntry.fromFolder(entryPath);
                if (!entry) {
                    console.warn(`Entry ${entryRef.code} not found in repository`);
                    continue;
                }
                await callback(entry, entryRef, channelRef, archiveChannel);
            }
        }
    }

    public async iterateAllEntryRefs(callback: (entryRef: ArchiveEntryReference, channelRef: ArchiveChannelReference, channel: ArchiveChannel) => Promise<void>) {
        const channelReferences = await this.getChannelReferences();
        for (const channelRef of channelReferences) {
            const channelPath = safeJoinPath(this.folderPath, channelRef.path);
            const archiveChannel = await ArchiveChannel.fromFolder(channelPath);
            if (!archiveChannel) {
                console.warn(`Channel ${channelRef.name} (${channelRef.id}) not found in repository`);
                continue;
            }
            const entries = archiveChannel.getData().entries;
            for (const entryRef of entries) {
                await callback(entryRef, channelRef, archiveChannel);
            }
        }
    }

    shouldIgnoreUpdates(id: Snowflake): boolean {
        return this.ignoreUpdatesFrom.includes(id);
    }

    async updateRemote() {
        if (!this.git) {
            throw new Error("Git not initialized");
        }

        const remoteURL = this.guildHolder.getConfigManager().getConfig(GuildConfigs.GITHUB_REPO_URL);
        if (!remoteURL) {
            throw new Error("GitHub repository URL not set in guild configuration");
        }

        const { owner, project } = getGithubOwnerAndProject(remoteURL);
        if (!owner || !project) {
            throw new Error("Invalid GitHub repository URL");
        }

        const token = await this.guildHolder.getBot().getGithubInstallationToken(owner);


        const remotes = await this.git.getRemotes(true);
        const origin = remotes.find(r => r.name === 'origin');
        if (origin) {
            await this.git.removeRemote('origin');
        }

        await this.git.addRemote('origin', `https://x-access-token:${token}@github.com/${owner}/${project}.git`);
    }

    public async getChannelReferences() {
        return this.channelsCache.get();
    }

    public async setChannelReferences(references: ArchiveChannelReference[]) {
        const channelsPath = this.getChannelsFilePath();
        await fs.writeFile(channelsPath, JSON.stringify(references, null, 2), 'utf-8');
        this.channelsCache.set(references);
        await this.git?.add(channelsPath);
    }

    async setupArchives(channels: ForumChannel[]) {
        if (!this.git) {
            throw new Error("Git not initialized");
        }
        await this.lock.acquire();

        try {

            this.dictionaryManager.invalidateArchiveIndex();

            const reMapped: ArchiveChannelReference[] = [];
            const channelsArray = Array.from(channels.values());

            const embeddingsTextToGenerate: string[] = [];
            const codeAndDescriptions: string[][] = [];
            const posititons: number[] = [];
            for (const channel of channelsArray) {
                await channel.fetch();
                const { code, description } = getCodeAndDescriptionFromTopic(channel.topic || '');
                if (!code) {
                    this.lock.release();
                    throw new Error(`Channel ${channel.name} (${channel.id}) does not have a valid code in the topic.`);
                }

                codeAndDescriptions.push([code, description || 'No description', channel.name, channel.parent?.name || '']);
                posititons.push(channel.rawPosition);
                embeddingsTextToGenerate.push(`Channel: ${channel.name}\nDesigns archived in this channel: ${description || 'No description'}`);
            }

            const allEmbeddings = await generateDocumentEmbeddings(embeddingsTextToGenerate).catch(() => null);


            for (let i = 0; i < channelsArray.length; i++) {
                const channel = channelsArray[i];
                const [code, description, name, category] = codeAndDescriptions[i];
                const embeddings = allEmbeddings ? allEmbeddings.embeddings[i] : undefined;
                reMapped.push({
                    id: channel.id,
                    name,
                    code,
                    embedding: embeddings,
                    category,
                    path: `Archive/${code}_${escapeString(name) || ''}`,
                    description: description || 'No description',
                    position: posititons[i]
                });
            }

            // sort by position
            reMapped.sort((a, b) => a.position - b.position);


            const existingChannels = await this.getChannelReferences();
            const newChannels = reMapped.filter(c => !existingChannels.some(ec => ec.id === c.id));
            const removedChannels = existingChannels.filter(ec => !reMapped.some(c => c.id === ec.id));
            const modifiedChannels = reMapped.filter(c => {
                const existing = existingChannels.find(ec => ec.id === c.id);
                return existing && (existing.name !== c.name || existing.description !== c.description || existing.code !== c.code || existing.category !== c.category);
            });

            // First, remove any channels that no longer exist
            for (const channel of removedChannels) {
                const channelPath = safeJoinPath(this.folderPath, channel.path);
                // Commit the removal
                for (const file of await fs.readdir(channelPath)) {
                    const filePath = safeJoinPath(channelPath, file);
                    // recursive
                    await fs.rm(filePath, { recursive: true, force: true });
                }
                await this.git.rm(['-r', channelPath]);
                await this.commit(`Removed channel ${channel.name} (${channel.code})`);
            }

            // Then, add new channels
            for (const channel of newChannels) {
                const channelPath = safeJoinPath(this.folderPath, channel.path);

                await fs.mkdir(channelPath, { recursive: true });

                // make new channel
                const newChannel = ArchiveChannel.newFromReference(channel, channelPath);
                await newChannel.savePrivate();


                // Commit the new channel
                await this.git.add(channelPath);
                await this.commit(`Added channel ${channel.name} (${channel.code})`);
            }

            const republishQueue: { entryData: ArchiveEntryData, archiveChannelId: Snowflake }[] = [];

            // Finally, update modified channels
            for (const channel of modifiedChannels) {
                const oldChannel = existingChannels.find(ec => ec.id === channel.id);
                if (!oldChannel) continue;
                const oldPath = safeJoinPath(this.folderPath, oldChannel.path);
                const newPath = safeJoinPath(this.folderPath, channel.path);

                // Rename the folder if the path has changed
                if (oldPath !== newPath) {
                    const newPathExists = await fs.access(newPath).then(() => true).catch(() => false);
                    if (newPathExists) {
                        const newPathEntries = await fs.readdir(newPath);
                        if (newPathEntries.length === 0) {
                            // Clean up stale empty folder so `git mv oldPath newPath` performs a rename.
                            await fs.rmdir(newPath);
                        } else {
                            throw new Error(`Cannot rename channel folder from ${oldChannel.path} to ${channel.path}: destination already exists`);
                        }
                    }
                    await this.git.mv(oldPath, newPath);
                }

                // check each post. Iterate through the files in the new path
                const channelInstance = await ArchiveChannel.fromFolder(newPath);
                if (!channelInstance) {
                    throw new Error(`Channel ${channel.name} (${channel.id}) not found in repository`);
                }

                const entries = channelInstance.getData().entries;
                const newEntries: ArchiveEntryReference[] = [];
                for (const oldEntryRef of entries) {
                    // Check if the file is a directory
                    const newEntryRef: ArchiveEntryReference = {
                        ...oldEntryRef
                    };

                    // get name and code
                    const oldEntry = await ArchiveEntry.fromFolder(safeJoinPath(newPath, oldEntryRef.path));
                    if (!oldEntry) {
                        throw new Error(`Old entry ${oldEntryRef.code} not found in repository`);
                    }

                    const oldEntryData = oldEntry.getData();
                    const oldEntryCode = oldEntryData.code || oldEntryRef.code;
                    let remappedCode = oldEntryCode;
                    if (oldChannel.code !== channel.code) {
                        if (oldEntryCode.startsWith(oldChannel.code)) {
                            remappedCode = channel.code + oldEntryCode.slice(oldChannel.code.length);
                        } else {
                            const numberSuffix = oldEntryCode.match(/\d+$/)?.[0];
                            remappedCode = numberSuffix ? (channel.code + numberSuffix) : (channel.code + oldEntryCode);
                        }
                    }

                    newEntryRef.code = remappedCode;
                    newEntryRef.path = `${newEntryRef.code}_${escapeString(oldEntryData.name || '')}`;

                    const oldFolderPath = safeJoinPath(newPath, oldEntryRef.path);
                    const newFolderPath = safeJoinPath(newPath, newEntryRef.path);
                    // Rename
                    if (oldFolderPath !== newFolderPath) {
                        await this.git.mv(oldFolderPath, newFolderPath);
                    }

                    // Load entry
                    const entry = await ArchiveEntry.fromFolder(newFolderPath);
                    if (!entry) {
                        throw new Error(`Entry ${oldEntryRef.code} not found in repository`);
                    }
                    entry.getData().code = newEntryRef.code;
                    entry.getData().reservedCodes = mergeTwoArraysUnique(entry.getData().reservedCodes || [], [newEntryRef.code]);

                    // Rename attachment files
                    if (oldEntryCode !== newEntryRef.code) {
                        for (const attachment of entry.getData().attachments) {
                            if (attachment.name.startsWith(oldEntryCode)) {
                                attachment.name = newEntryRef.code + attachment.name.slice(oldEntryCode.length);
                            }

                            const oldAttachmentPath = attachment.path || '';
                            if (!oldAttachmentPath) {
                                continue;
                            }

                            // split the path to get the file name
                            const oldPathParts = oldAttachmentPath.split('/');
                            const oldFileName = oldPathParts.pop() || '';
                            const newFileName = oldFileName.startsWith(oldEntryCode)
                                ? newEntryRef.code + oldFileName.slice(oldEntryCode.length)
                                : oldFileName;

                            oldPathParts.push(newFileName);
                            const newAttachmentPath = oldPathParts.join('/');
                            if (oldAttachmentPath !== newAttachmentPath) {
                                const fullOldPath = safeJoinPath(newFolderPath, oldAttachmentPath);
                                const fullNewPath = safeJoinPath(newFolderPath, newAttachmentPath);
                                await this.git.mv(fullOldPath, fullNewPath);
                                attachment.path = newAttachmentPath;
                            }
                        }
                    }

                    // Save the entry
                    await this.git.add(entry.getDataPath());
                    await entry.savePrivate();
                    newEntries.push(newEntryRef);
                    //await this.git.add(await this.updateEntryReadme(entry));

                    // update submission
                    //await this.addOrUpdateEntryFromData(this.guildHolder, entry.getData(), channel.id, false, false, async () => {});
                }

                channelInstance.getData().name = channel.name;
                channelInstance.getData().category = channel.category;
                channelInstance.getData().description = channel.description;
                channelInstance.getData().code = channel.code;
                channelInstance.getData().entries = newEntries;
                await channelInstance.savePrivate();

                if (oldPath !== newPath) {
                    // Queue entries to republish after channel references are updated.
                    for (const entryRef of newEntries) {
                        const entryPath = safeJoinPath(newPath, entryRef.path);
                        const entry = await ArchiveEntry.fromFolder(entryPath);
                        if (!entry) {
                            throw new Error(`Entry ${entryRef.code} not found in repository`);
                        }
                        republishQueue.push({
                            entryData: deepClone(entry.getData()),
                            archiveChannelId: channel.id
                        });
                    }
                }

                // Commit the changes
                let msg;
                if (oldChannel.code !== channel.code) {
                    msg = `Changed code for channel ${oldChannel.name} from ${oldChannel.code} to ${channel.code}`;
                } else if (oldChannel.name !== channel.name) {
                    msg = `Renamed channel ${oldChannel.name} to ${channel.name} (${channel.code})`;
                } else {
                    msg = `Updated channel ${oldChannel.name} (${channel.code})`;
                }
                await this.git.add(newPath);
                await this.commit(msg);
            }

            // Check tags for entries
            for (const channel of reMapped) {
                const channelPath = safeJoinPath(this.folderPath, channel.path);
                const archiveChannel = await ArchiveChannel.fromFolder(channelPath);
                if (!archiveChannel) {
                    console.warn(`Channel ${channel.name} (${channel.id}) not found in repository`);
                    continue;
                }
                const entries = archiveChannel.getData().entries;
                let changed = false;
                for (const entryRef of entries) {
                    const entryPath = safeJoinPath(channelPath, entryRef.path);
                    const entry = await ArchiveEntry.fromFolder(entryPath);
                    if (!entry) {
                        console.warn(`Entry ${entryRef.code} not found in repository`);
                        continue;
                    }
                }
                if (changed) {
                    await archiveChannel.savePrivate();
                    await this.git.add(archiveChannel.getDataPath());
                }
            }

            // Finally, save the new config
            //this.configManager.setConfig(RepositoryConfigs.ARCHIVE_CHANNELS, reMapped);
            await this.setChannelReferences(reMapped);

            for (const { entryData, archiveChannelId } of republishQueue) {
                const result = await this.addOrUpdateEntryFromData(entryData, archiveChannelId, false, false, false, async () => { });
                const submission = await this.guildHolder.getSubmissionsManager().getSubmission(entryData.id);
                if (submission) {
                    submission.getConfigManager().setConfig(SubmissionConfigs.ARCHIVE_CHANNEL_ID, archiveChannelId);
                    this.updateSubmissionFromEntryData(submission, result.newEntryData);
                    await submission.save();
                    await submission.statusUpdated();
                }
            }

            // if config file path doesnt exist, create it  
            if (!await fs.access(this.getConfigFilePath()).then(() => true).catch(() => false)) {
                await fs.writeFile(this.getConfigFilePath(), JSON.stringify({}, null, 2), 'utf-8');
            }
            await this.save();

            // Rebuild index
            await this.buildPersistentIndexAndEmbeddings();
            await this.dictionaryManager.rebuildIndexAndEmbeddings();

            // Add config if it doesn't exist
            await this.git.add(this.getConfigFilePath());
            await this.commit('Updated repository configuration');
            try {
                await this.push().catch(() => { });
            } catch (e: any) {
                console.error("Error pushing to remote:", e.message);
            }
            await this.lock.release();
        } catch (e) {
            this.lock.release();
            throw e;
        }
    }

    public async rebuildIndexesAndEmbeddings() {
        await this.lock.acquire();
        await this.buildPersistentIndexAndEmbeddings().catch(() => { });
        await this.dictionaryManager.rebuildIndexAndEmbeddings().catch(() => { });
        await this.commit('Rebuilt persistent index and embeddings').catch(() => { });
        await this.push().catch(() => { });
        await this.lock.release();
    }

    public async restoreTags(): Promise<void> {

        await this.lock.acquire();
        try {
            const globalTags = this.getConfigManager().getConfig(RepositoryConfigs.GLOBAL_TAGS);
            const archiveChannels = await this.guildHolder.getGuild().channels.fetch();
            const archiveCategories = this.guildHolder.getConfigManager().getConfig(GuildConfigs.ARCHIVE_CATEGORY_IDS);
            const forumChannels = Array.from(
                archiveChannels
                    .filter(c => c?.type === ChannelType.GuildForum && c.parentId && archiveCategories.includes(c.parentId))
                    .values()
            ) as ForumChannel[];

            const channelRefs = await this.getChannelReferences();
            const changedEntryPaths: string[] = [];

            for (const forum of forumChannels) {
                const channelRef = channelRefs.find(r => r.id === forum.id);
                if (!channelRef) continue;

                const channelPath = safeJoinPath(this.folderPath, channelRef.path);
                const archiveChannel = await ArchiveChannel.fromFolder(channelPath);
                if (!archiveChannel) continue;

                const tagsInEntries = new Map<string, Tag>();


                const entries = archiveChannel.getData().entries;

                for (const entryRef of entries) {
                    const entryPath = safeJoinPath(channelPath, entryRef.path);
                    const entry = await ArchiveEntry.fromFolder(entryPath);
                    if (!entry) continue;

                    const entryData = entry.getData();
                    for (const tag of entryData.tags) {
                        const tagExisting = tagsInEntries.get(tag.id);
                        if (!tagExisting) {
                            tagsInEntries.set(tag.id, tag);
                        } else {
                            // check if id is same
                            if (tagExisting.name !== tag.name) {
                                throw new Error(`Conflicting tag names for ID ${tag.id}: ${tagExisting.name} and ${tag.name}`);
                            }
                        }
                    }
                }


                const available = forum.availableTags;


                const globalTagData = globalTags.map(gt => {
                    const matchByNameAvailable = available.find(t => t.name === gt.name);
                    const matchByNameEntries = Array.from(tagsInEntries.values()).find(t => t.name === gt.name);
                    return {
                        id: matchByNameAvailable ? matchByNameAvailable.id : matchByNameEntries?.id,
                        name: gt.name,
                        moderated: !!gt.moderated,
                        emoji: gt.emoji ? { id: null, name: gt.emoji } : null,
                    };
                });

                const otherTags = Array.from(tagsInEntries.values()).filter((tag) => {
                    if (globalTagData.some(gt => gt.name === tag.name)) {
                        return false;
                    }
                    return true;
                }).map((tag) => {
                    const matchByIDAvailable = available.find(t => t.id === tag.id);
                    const matchByNameAvailable = available.find(t => t.name === tag.name);

                    if (matchByIDAvailable && matchByNameAvailable?.name === tag.name) {
                        return matchByIDAvailable;
                    }

                    if (matchByNameAvailable) {
                        return matchByNameAvailable;
                    }

                    return {
                        id: tag.id,
                        name: tag.name,
                        moderated: false,
                        emoji: null,
                    };
                });

                const newTags = [...globalTagData, ...otherTags];

                // Only update if changed
                const changed = newTags.length !== available.length || newTags.some((t, i) => {
                    const cur = available[i];
                    return !cur || cur.id !== t.id || cur.name !== t.name || cur.moderated !== t.moderated || (cur.emoji?.name || null) !== (t.emoji?.name || null);
                });

                if (changed) {
                    await forum.setAvailableTags(newTags);
                }

                // get new available tags
                await forum.fetch();

                const newAvailable = forum.availableTags;

                const byIdMap = new Map<string, string>();
                const byNameMap = new Map<string, string>();
                for (const tag of newAvailable) {
                    byIdMap.set(tag.id, tag.name);
                    byNameMap.set(tag.name, tag.id);
                }

                // Update stored entries for this channel based on tag IDs

                let channelChanged = false;

                for (const entryRef of entries) {
                    const entryPath = safeJoinPath(channelPath, entryRef.path);
                    const entry = await ArchiveEntry.fromFolder(entryPath);
                    if (!entry) continue;
                    const entryData = entry.getData();
                    if (!entryData.post) continue;

                    // update tags
                    const updatedTags = entryData.tags
                        .map(tag => {
                            if (byNameMap.has(tag.name)) {
                                return { id: byNameMap.get(tag.name)!, name: tag.name };
                            }

                            const byIdName = byIdMap.get(tag.id);
                            if (byIdName) {
                                return { id: tag.id, name: byIdName };
                            }
                            return tag;
                        });

                    entryData.tags = updatedTags;
                    await entry.savePrivate();
                    await this.git?.add(entry.getDataPath()).catch(() => { });
                    await this.git?.add(await this.updateEntryReadme(entry)).catch(() => { });
                    channelChanged = true;
                    changedEntryPaths.push(entry.getDataPath());

                    // update discord thread
                    const thread = await forum.threads.fetch(entryData.post.threadId)

                    if (thread) {

                        const newIds = updatedTags.map(t => t.id);
                        const currentTags = thread.appliedTags;
                        const idsAreSame = newIds.length === currentTags.length && newIds.every(id => currentTags.includes(id));
                        if (!idsAreSame) {


                            const wasArchived = thread.archived;

                            this.addToIgnoreUpdatesFrom(entryData.id);
                            if (wasArchived) {
                                await thread.setArchived(false);
                            }
                            await thread.setAppliedTags(newIds);
                            if (wasArchived) {
                                await thread.setArchived(true);
                            }
                            this.removeFromIgnoreUpdatesFrom(entryData.id);
                        }
                    }

                    // update submission
                    const submission = await this.guildHolder.getSubmissionsManager().getSubmission(entryData.id);
                    if (submission) {
                        const pastSubmissionTags = submission.getConfigManager().getConfig(SubmissionConfigs.TAGS) || [];
                        const submissionTagsAreSame = pastSubmissionTags.length === updatedTags.length &&
                            pastSubmissionTags.every(t => updatedTags.some(ut => ut.id === t.id && ut.name === t.name));
                        if (!submissionTagsAreSame) {
                            // set tags
                            submission.getConfigManager().setConfig(SubmissionConfigs.TAGS, entryData.tags);
                            await submission.save();
                            await submission.statusUpdated();
                        }
                    }
                }

                if (channelChanged) {
                    await archiveChannel.savePrivate();
                    await this.git?.add(archiveChannel.getDataPath()).catch(() => { });
                }
            }

            if (changedEntryPaths.length > 0) {
                await this.buildPersistentIndexAndEmbeddings().catch(() => { });
                await this.dictionaryManager.rebuildIndexAndEmbeddings().catch(() => { });
                await this.commit('Synced archive tags after global tag restore', changedEntryPaths).catch(() => { });
                await this.push().catch(() => { });
            }
        } finally {
            await this.lock.release();
        }
    }

    public async deleteTag(name: string): Promise<void> {
        await this.lock.acquire();

        try {
            const archiveChannels = await this.guildHolder.getGuild().channels.fetch();
            const archiveCategories = this.guildHolder.getConfigManager().getConfig(GuildConfigs.ARCHIVE_CATEGORY_IDS);
            const forumChannels = Array.from(
                archiveChannels
                    .filter(c => c?.type === ChannelType.GuildForum && c.parentId && archiveCategories.includes(c.parentId))
                    .values()
            ) as ForumChannel[];
            const channelRefs = await this.getChannelReferences();
            for (const forum of forumChannels) {
                const channelRef = channelRefs.find(r => r.id === forum.id);
                if (!channelRef) continue;

                const newAvailableTags = forum.availableTags.filter(t => t.name !== name);
                if (newAvailableTags.length === forum.availableTags.length) {
                    continue;
                }

                await forum.setAvailableTags(newAvailableTags);
            }

        } finally {
            await this.lock.release();
        }

    }
    /**
     * Synchronize global tags to all archive forum channels in Discord, ensuring
     * global tags appear first (preserving the order in config), then any
     * channel-specific tags. Options allow preserving tag IDs on rename and
     * choosing which removed globals should also be deleted from forums.
     */
    public async applyGlobalTagChanges(
        newGlobalTags: GlobalTag[],
        options?: { renamedFromMap?: Map<string, string>, deleteRemovedTagNames?: Iterable<string> }
    ): Promise<void> {
        await this.lock.acquire();
        try {

            const oldGlobalTags = this.getConfigManager().getConfig(RepositoryConfigs.GLOBAL_TAGS);

            const renamedFromMap = options?.renamedFromMap;
            const deleteRemovedTagNames = new Set(options?.deleteRemovedTagNames ?? []);
            const newGlobalTagNames = new Set(newGlobalTags.map(t => t.name));
            const renameSources = new Set<string>(renamedFromMap ? Array.from(renamedFromMap.values()) : []);

            const archiveChannels = await this.guildHolder.getGuild().channels.fetch();
            const archiveCategories = this.guildHolder.getConfigManager().getConfig(GuildConfigs.ARCHIVE_CATEGORY_IDS);
            const forumChannels = Array.from(
                archiveChannels
                    .filter(c => c?.type === ChannelType.GuildForum && c.parentId && archiveCategories.includes(c.parentId))
                    .values()
            ) as ForumChannel[];

            const channelRefs = await this.getChannelReferences();
            const changedEntryPaths: string[] = [];

            for (const forum of forumChannels) {
                const channelRef = channelRefs.find(r => r.id === forum.id);
                if (!channelRef) continue;

                const availableForReuse = deepClone(forum.availableTags);
                const oldGlobalTagsAvailable = oldGlobalTags.map(gt => {
                    const foundIndex = availableForReuse.findIndex(t => t.name === gt.name);
                    if (foundIndex === -1) {
                        return null;
                    }

                    // Remove from the pool if it stays global, is being renamed, or we intend to delete this removed global.
                    const shouldConsume = newGlobalTagNames.has(gt.name) || renameSources.has(gt.name) || deleteRemovedTagNames.has(gt.name);
                    if (shouldConsume) {
                        const tag = availableForReuse[foundIndex];
                        availableForReuse.splice(foundIndex, 1);
                        return tag;
                    }
                    return null;
                }).filter(Boolean) as GuildForumTag[];

                const globalTagData = newGlobalTags.map(gt => {
                    // check if renamed
                    const renamedFrom = renamedFromMap?.get(gt.name);
                    if (renamedFrom) {
                        const oldTagIndex = oldGlobalTagsAvailable.findIndex(ogt => ogt.name === renamedFrom);
                        if (oldTagIndex !== -1) {
                            const oldTag = oldGlobalTagsAvailable[oldTagIndex];
                            oldGlobalTagsAvailable.splice(oldTagIndex, 1);
                            oldTag.name = gt.name;
                            oldTag.moderated = !!gt.moderated;
                            oldTag.emoji = gt.emoji ? { id: null, name: gt.emoji } : null;
                            return oldTag;
                        }
                    }

                    // unchanged global tag: reuse the existing tag object so the ID is preserved
                    const existingIdx = oldGlobalTagsAvailable.findIndex(ogt => ogt.name === gt.name);
                    if (existingIdx !== -1) {
                        const tag = oldGlobalTagsAvailable[existingIdx];
                        oldGlobalTagsAvailable.splice(existingIdx, 1);
                        tag.moderated = !!gt.moderated;
                        tag.emoji = gt.emoji ? { id: null, name: gt.emoji } : null;
                        return tag;
                    }

                    // brand new global tag: try to reuse any remaining tag object (unlikely) else create fresh
                    const matchByNameAvailableIndex = availableForReuse.findIndex(t => t.name === gt.name);
                    if (matchByNameAvailableIndex !== -1) {
                        const tag = availableForReuse[matchByNameAvailableIndex];
                        availableForReuse.splice(matchByNameAvailableIndex, 1);
                        tag.moderated = !!gt.moderated;
                        tag.emoji = gt.emoji ? { id: null, name: gt.emoji } : null;
                        return tag;
                    }

                    return {
                        id: null,
                        name: gt.name,
                        moderated: !!gt.moderated,
                        emoji: gt.emoji ? { id: null, name: gt.emoji } : null,
                    }
                }) as GuildForumTag[];

                let newTags = [...globalTagData, ...availableForReuse];

                // Only update if changed
                const changed = newTags.length !== forum.availableTags.length || newTags.some((t, i) => {
                    const cur = forum.availableTags[i];
                    return !cur || cur.id !== t.id || cur.name !== t.name || cur.moderated !== t.moderated || (cur.emoji?.name || null) !== (t.emoji?.name || null);
                });

                if (!changed) {
                    continue;
                }

                await forum.setAvailableTags(newTags);
                // get new available tags
                await forum.fetch();
                newTags = forum.availableTags;

                // Update stored entries for this channel based on tag IDs
                const channelPath = safeJoinPath(this.folderPath, channelRef.path);
                const archiveChannel = await ArchiveChannel.fromFolder(channelPath);
                if (!archiveChannel) continue;
                const entries = archiveChannel.getData().entries;
                let channelChanged = false;

                for (const entryRef of entries) {
                    const entryPath = safeJoinPath(channelPath, entryRef.path);
                    const entry = await ArchiveEntry.fromFolder(entryPath);
                    if (!entry) continue;
                    const entryData = entry.getData();
                    const updatedTags = entryData.tags
                        .map(tag => {
                            const match = newTags.find(t => t.id === tag.id);
                            if (!match) return null;
                            return { id: match.id!, name: match.name };
                        })
                        .filter(Boolean) as { id: string, name: string }[];

                    const needsUpdate = updatedTags.length !== entryData.tags.length ||
                        updatedTags.some((t, idx) => t.name !== entryData.tags[idx]?.name);

                    if (needsUpdate) {
                        entryData.tags = updatedTags;
                        await entry.savePrivate();
                        await this.git?.add(entry.getDataPath()).catch(() => { });
                        await this.git?.add(await this.updateEntryReadme(entry)).catch(() => { });
                        channelChanged = true;
                        changedEntryPaths.push(entry.getDataPath());

                        // update submission
                        const submission = await this.guildHolder.getSubmissionsManager().getSubmission(entryData.id);
                        if (submission) {
                            // set tags
                            submission.getConfigManager().setConfig(SubmissionConfigs.TAGS, entryData.tags);
                            await submission.save();
                            await submission.statusUpdated();
                        }
                    }
                }

                if (channelChanged) {
                    await archiveChannel.savePrivate();
                    await this.git?.add(archiveChannel.getDataPath()).catch(() => { });
                }
            }

            this.configManager.setConfig(RepositoryConfigs.GLOBAL_TAGS, deepClone(newGlobalTags));
            await this.configManager.saveConfig();
            await this.add(this.getConfigFilePath());
            await this.buildPersistentIndexAndEmbeddings().catch(() => { });
            await this.commit('Adjusted global tags').catch(() => { });
            await this.push().catch(() => { });
        } finally {
            await this.lock.release();
        }
    }

    async findEntryBySubmissionId(submissionId: string): Promise<null | {
        channelRef: ArchiveChannelReference,
        channel: ArchiveChannel,
        entry: ArchiveEntry,
        entryRef: ArchiveEntryReference,
        entryIndex: number
    }> {
        const channelReferences = await this.getChannelReferences();
        for (const channelRef of channelReferences) {
            const channelPath = safeJoinPath(this.folderPath, channelRef.path);
            const archiveChannel = await ArchiveChannel.fromFolder(channelPath);
            const entries = archiveChannel.getData().entries;
            const entryIndex = entries.findIndex(e => e.id === submissionId);
            if (entryIndex !== -1) {
                const entryRef = entries[entryIndex];
                const entryPath = safeJoinPath(channelPath, entryRef.path);
                const entry = await ArchiveEntry.fromFolder(entryPath);
                if (!entry) {
                    continue; // Skip if entry could not be loaded
                }
                return {
                    channelRef,
                    channel: archiveChannel,
                    entry,
                    entryRef,
                    entryIndex
                };
            }
        }

        return null;
    }

    async getEntryByPostCode(submissionCode: string): Promise<null | {
        channelRef: ArchiveChannelReference,
        channel: ArchiveChannel,
        entry: ArchiveEntry,
        entryRef: ArchiveEntryReference,
        entryIndex: number
    }> {
        submissionCode = submissionCode.toUpperCase();

        const {
            channelCode,
        } = splitCode(submissionCode);

        const channelReferences = await this.getChannelReferences();
        const channelRef = channelReferences.find(c => c.code === channelCode);
        if (!channelRef) {
            return null;
        }

        const channelPath = safeJoinPath(this.folderPath, channelRef.path);
        const archiveChannel = await ArchiveChannel.fromFolder(channelPath);
        const entries = archiveChannel.getData().entries;
        const entryIndex = entries.findIndex(e => e.code === submissionCode);
        if (entryIndex !== -1) {
            const entryRef = entries[entryIndex];
            const entryPath = safeJoinPath(channelPath, entryRef.path);
            const entry = await ArchiveEntry.fromFolder(entryPath);
            if (!entry) {
                return null; // Skip if entry could not be loaded
            }
            return {
                channelRef,
                channel: archiveChannel,
                entry,
                entryRef,
                entryIndex
            };
        }
        return null;
    }

    async addOrUpdateEntryFromSubmission(
        submission: Submission,
        forceNew: boolean,
        reprocessImages: boolean,
        details?: PublishCommitMessage,
        statusCallback?: (status: string) => Promise<void>
    ): Promise<{ oldEntryData?: ArchiveEntryData, newEntryData: ArchiveEntryData }> {

        if (!this.git) {
            throw new Error("Git not initialized");
        }

        const archiveChannelId = submission.getConfigManager().getConfig(SubmissionConfigs.ARCHIVE_CHANNEL_ID);
        if (!archiveChannelId) {
            throw new Error("Submission does not have an archive channel set");
        }

        const archiveChannel = await this.guildHolder.getGuild().channels.fetch(archiveChannelId);
        if (!archiveChannel || archiveChannel.type !== ChannelType.GuildForum) {
            throw new Error("Archive channel not a valid forum channel");
        }

        const archiveChannelRef = (await this.getChannelReferences()).find(c => c.id === archiveChannelId);
        if (!archiveChannelRef) {
            throw new Error("Archive channel reference not found");
        }

        // acquire lock
        await this.lock.acquire();
        let submissionChannel: GuildTextBasedChannel | null = null;
        let entryData: ArchiveEntryData | null = null;
        try {
            const channelPath = safeJoinPath(this.folderPath, archiveChannelRef.path);
            const archiveChannelData = await ArchiveChannel.fromFolder(channelPath);


            // Find old entry if it exists
            // const existing = await this.findEntryBySubmissionId(submission.getId());
            const reservedCodes = submission.getConfigManager().getConfig(SubmissionConfigs.RESERVED_CODES);
            // archiveChannel.getData().code + (++archiveChannel.getData().currentCodeId).toString().padStart(3, '0')
            // check reserved codes
            let newCode = '';
            for (const code of reservedCodes) {
                // get channel code XXX001
                const { channelCode } = splitCode(code);
                if (channelCode === archiveChannelRef.code) {
                    // If the code is reserved, use it
                    newCode = code;

                    if (!archiveChannelData.getData().entries.find(e => e.code === newCode && submission.getId() !== e.id)) {
                        break;
                    }
                }
            }

            if (!newCode) {
                // If no reserved code was found, generate a new code
                newCode = archiveChannelRef.code + (++archiveChannelData.getData().currentCodeId).toString().padStart(3, '0');
            }

            // Check if the code already exists in the channel
            for (let i = 0; i < archiveChannelData.getData().entries.length; i++) {
                const existingCodeEntry = archiveChannelData.getData().entries.find(e => e.code === newCode);
                if (existingCodeEntry && submission.getId() !== existingCodeEntry.id) {
                    newCode = archiveChannelRef.code + (++archiveChannelData.getData().currentCodeId).toString().padStart(3, '0');
                } else {
                    break; // Found a unique code
                }
            }

            await archiveChannelData.savePrivate();

            // Add the new code to the reserved codes if it doesn't already exist
            if (!reservedCodes.includes(newCode)) {
                reservedCodes.push(newCode);
                submission.getConfigManager().setConfig(SubmissionConfigs.RESERVED_CODES, reservedCodes);
            }

            const revisionReference = submission.getRevisionsManager().getCurrentRevision();
            if (!revisionReference) {
                throw new Error("Submission does not have a current revision");
            }
            const revision = await submission.getRevisionsManager().getRevisionById(revisionReference.id);
            if (!revision) {
                throw new Error("Submission revision not found");
            }

            submissionChannel = await submission.getSubmissionChannel();
            if (!submissionChannel) {
                throw new Error("Submission channel not found");
            }

            const config = submission.getConfigManager();

            config.setConfig(SubmissionConfigs.NAME, submissionChannel.name);

            const pastPostThreadIds = config.getConfig(SubmissionConfigs.PAST_POST_THREAD_IDS);
            const oldRef = submission.getConfigManager().getConfig(SubmissionConfigs.AUTHORS_REFERENCES);
            const authors = await reclassifyAuthors(this.guildHolder, config.getConfig(SubmissionConfigs.AUTHORS) || []);
            const now = Date.now();

            entryData = deepClone({
                id: submission.getId(),
                name: config.getConfig(SubmissionConfigs.NAME),
                code: newCode,

                reservedCodes: reservedCodes,
                pastPostThreadIds: pastPostThreadIds,

                authors: authors,
                endorsers: await reclassifyAuthors(this.guildHolder, config.getConfig(SubmissionConfigs.ENDORSERS)),
                tags: config.getConfig(SubmissionConfigs.TAGS) || [],
                images: deduplicateAttachmentNames(submission.getConfigManager().getConfig(SubmissionConfigs.IMAGES) || [], '', 'png'),
                attachments: deduplicateAttachmentNames(submission.getConfigManager().getConfig(SubmissionConfigs.ATTACHMENTS) || [], `${newCode}_`),
                records: revision.records,
                styles: revision.styles,
                references: await tagReferencesInSubmissionRecords(revision.records, revision.references, this.guildHolder, submission.getId()),
                author_references: await tagReferencesInAcknowledgements(authors, oldRef, this.guildHolder, submission.getId()),
                updatedAt: now,
                archivedAt: now,
                num_comments: 0,
                post: undefined
            });


            const availableTags = archiveChannel.availableTags;

            // Ensure all tags exist in the forum channel
            const newTags = [];
            for (const tag of entryData.tags) {
                let match = availableTags.find(t => t.id === tag.id);
                if (match && match.name === tag.name) {
                    newTags.push(tag);
                    continue;
                }

                let nameMatch = availableTags.find(t => t.name === tag.name);
                if (nameMatch) {
                    newTags.push({ id: nameMatch.id, name: nameMatch.name });
                }
                // ignore if not found
            }

            entryData.tags = newTags;


            for (const ref of revision.references) {
                if (ref.type === ReferenceType.DICTIONARY_TERM) {
                    const item = await this.dictionaryManager.getEntry(ref.id);
                    if (!item) continue;
                    if (!item.referencedBy.some(r => r === entryData?.code)) {
                        item.referencedBy.push(entryData.code);
                        // sort referencedBy
                        item.referencedBy.sort();
                        await this.dictionaryManager.saveEntry(item).catch(() => { });
                        await this.dictionaryManager.updateStatusMessage(item).catch(() => { });
                    }
                }
            }

            if (!submissionChannel || !entryData) {
                throw new Error("Failed to get submission channel or entry data");
            }
            const result = await this.addOrUpdateEntryFromData(entryData, archiveChannelId, forceNew, reprocessImages, false, async (entryData, imageFolder, attachmentFolder) => {
                // remove all images and attachments that exist in the folder.

                // remove existing files
                await fs.rm(imageFolder, { recursive: true, force: true });
                await fs.rm(attachmentFolder, { recursive: true, force: true });

                await fs.mkdir(imageFolder, { recursive: true });
                await fs.mkdir(attachmentFolder, { recursive: true });

                // Copy over all attachments and images
                for (const image of entryData.images) {
                    if (!image.path) continue;
                    const sourcePath = safeJoinPath(submission.getProcessedImagesFolder(), image.path);
                    const newBaseName = escapeString(splitFileName(image.name).basename);
                    const destPath = safeJoinPath(imageFolder, `${newBaseName}.png`);
                    await fs.copyFile(sourcePath, destPath);
                    image.path = `images/${newBaseName}.png`;
                }

                for (const attachment of entryData.attachments) {
                    if (!attachment.path) continue;
                    const sourcePath = safeJoinPath(submission.getAttachmentFolder(), attachment.path);

                    const { basename, ext } = splitFileName(attachment.name);

                    const escapedName = escapeString(basename);
                    const escapedExt = ext ? `.${escapeString(ext)}` : '';
                    const newKey = `${escapedName}${escapedExt}`;

                    const destPath = safeJoinPath(attachmentFolder, newKey);
                    attachment.path = `attachments/${newKey}`;

                    if (!attachment.canDownload) {
                        await fs.writeFile(destPath, attachment.url || '', 'utf-8');
                    } else {
                        await fs.copyFile(sourcePath, destPath);
                    }
                }

            }, statusCallback);

            const newEntryData = result.newEntryData;
            const oldEntryData = result.oldEntryData;

            await this.buildPersistentIndexAndEmbeddings();

            let commitMessage = '';
            if (oldEntryData) {
                commitMessage = `${newEntryData.code}: ${generateCommitMessage(oldEntryData, newEntryData)}`;
            } else {
                commitMessage = `Added entry ${newEntryData.name} (${newEntryData.code}) to channel ${archiveChannelData.getData().name} (${archiveChannelData.getData().code})`;
            }

            if (details) {
                if (details.message) {
                    commitMessage = `${newEntryData.code}: ${details.message}`;
                }

                if (details.detailedDescription) {
                    commitMessage += `\n\n${details.detailedDescription}`;
                }
            }

            await this.commit(commitMessage);
            try {
                await this.push();
            } catch (e: any) {
                console.error("Error pushing to remote:", e.message);
            }
            this.lock.release();
            return result;
        } catch (e: any) {
            await this.lock.release();
            throw e;
        }
    }

    async fetchBranchName(): Promise<string> {
        if (!this.git) {
            throw new Error("Git not initialized");
        }
        const branchSummary = await this.git.branch();
        return branchSummary.current;
    }

    async addOrUpdateEntryFromData(
        newEntryData: ArchiveEntryData,
        archiveChannelId: Snowflake,
        forceNew: boolean,
        reprocessImages: boolean,
        reanalyzeAttachments: boolean,
        moveAttachments: (entryData: ArchiveEntryData, imageFolder: string, attachmentFolder: string) => Promise<void>,
        statusCallback: (status: string) => Promise<void> | void = () => { }
    ): Promise<{ oldEntryData?: ArchiveEntryData, newEntryData: ArchiveEntryData }> {
        const guildHolder = this.guildHolder;
        // clone entryData
        newEntryData = deepClone(newEntryData);

        if (!this.git) {
            throw new Error("Git not initialized");
        }

        const reportStatus = async (status: string) => {
            try {
                await statusCallback(status);
            } catch (e) {
                console.error("Status callback failed:", e);
            }
        };

        this.addToIgnoreUpdatesFrom(newEntryData.id);

        if (!archiveChannelId) {
            throw new Error("Submission does not have an archive channel set");
        }


        const archiveChannelRef = (await this.getChannelReferences()).find(c => c.id === archiveChannelId);
        if (!archiveChannelRef) {
            throw new Error("Archive channel reference not found");
        }

        await reportStatus('Collecting information...');

        const archiveChannelDiscord = await guildHolder.getGuild().channels.fetch(archiveChannelId).catch(() => null);
        if (!archiveChannelDiscord || archiveChannelDiscord.type !== ChannelType.GuildForum) {
            throw new Error('Archive channel not found or is not a forum channel');
        }

        const uploadChannel = await guildHolder.getGuild().channels.fetch(newEntryData.id).catch(() => null);
        if (!uploadChannel || !uploadChannel.isTextBased()) {
            throw new Error('Upload channel not found or is not text based');
        }

        const channelPath = safeJoinPath(this.folderPath, archiveChannelRef.path);
        const archiveChannel = await ArchiveChannel.fromFolder(channelPath);

        const existing = await this.findEntryBySubmissionId(newEntryData.id);
        const isSameChannel = existing && existing.channelRef.id === archiveChannelId;

        const entryRef: ArchiveEntryReference = {
            id: newEntryData.id,
            code: newEntryData.code,
            path: `${newEntryData.code}_${escapeString(newEntryData.name) || ''}`,
        }

        if (existing) {
            newEntryData.archivedAt = existing.entry.getData().archivedAt;
        }

        const entryFolderPath = safeJoinPath(channelPath, entryRef.path);

        if (!newEntryData.post) {
            newEntryData.post = {
                threadId: '',
                forumId: archiveChannelId,
                continuingMessageIds: [],
                threadURL: '',
                uploadMessageId: ''
            }
        }

        let wasArchived = false;
        if (existing) {
            const existingFolder = safeJoinPath(existing.channel.getFolderPath(), existing.entryRef.path);
            if (existingFolder !== entryFolderPath) {
                // If the folder is different, we need to rename the old folder
                await this.git.mv(existingFolder, entryFolderPath);
            }

            if (!isSameChannel) {
                // If the channel is different, we need to remove the old entry from the old channel
                existing.channel.getData().entries.splice(existing.entryIndex, 1);
                await existing.channel.savePrivate();
                await this.git.add(existing.channel.getDataPath());

                // Also remove old discord post if it exists
                const post = existing.entry.getData().post;
                if (post) {
                    const publishForumId = post.forumId;
                    const publishForum = await guildHolder.getGuild().channels.fetch(publishForumId).catch(() => null);
                    if (publishForum && publishForum.type === ChannelType.GuildForum) {
                        const thread = await publishForum.threads.fetch(post.threadId).catch(() => null);
                        if (thread) {
                            if (thread.archived) {
                                wasArchived = true;
                            }
                            await thread.delete('Entry moved to a different channel');
                        }
                    }
                }
            } else {
                if (!forceNew) { // no problem
                    const post = existing.entry.getData().post;
                    if (post) {
                        newEntryData.post = deepClone(post);
                    }
                } else {
                    // If requested to force new post, remove old post if it exists
                    const post = existing.entry.getData().post;
                    if (post) {
                        const publishForumId = post.forumId;
                        const publishForum = await guildHolder.getGuild().channels.fetch(publishForumId).catch(() => null);
                        if (publishForum && publishForum.type === ChannelType.GuildForum) {
                            const thread = await publishForum.threads.fetch(post.threadId).catch(() => null);
                            if (thread) {
                                if (thread.archived) {
                                    wasArchived = true;
                                }
                                await thread.delete('Entry updated with forceNew, creating a new post');
                            }
                        }
                    }
                }
            }
        }

        if (existing) {
            const existingData = existing.entry.getData();
            if (hasAttachmentNameChanged(existingData.attachments, newEntryData.attachments) || existingData.code !== newEntryData.code) {
                newEntryData.post.uploadMessageId = '';
            } else if (existingData.post) {
                newEntryData.post.uploadMessageId = existingData.post.uploadMessageId;
            } else {
                newEntryData.post.uploadMessageId = '';
            }
        } else {
            newEntryData.post.uploadMessageId = '';
        }

        await fs.mkdir(entryFolderPath, { recursive: true });

        const entry = new ArchiveEntry(newEntryData, entryFolderPath);

        const imageFolder = safeJoinPath(entryFolderPath, 'images');
        const attachmentFolder = safeJoinPath(entryFolderPath, 'attachments');

        await moveAttachments(newEntryData, imageFolder, attachmentFolder);

        if (reanalyzeAttachments) {
            await reportStatus('Reanalyzing attachments');
            await analyzeAttachments(newEntryData.attachments, entryFolderPath);
        }

        if (existing && isSameChannel) {
            archiveChannel.getData().entries[existing.entryIndex] = entryRef;
        } else {
            // New entry
            archiveChannel.getData().entries.push(entryRef);
        }

        let thread;
        if (newEntryData.post && newEntryData.post.threadId) {
            thread = await archiveChannelDiscord.threads.fetch(newEntryData.post.threadId).catch(() => null);
            // unarchive the thread if it exists
            if (thread && thread.archived) {
                await thread.setArchived(false);
                wasArchived = true;
            }
        }

        // First, upload attachments
        const entryPathPart = `${archiveChannelRef.path}/${entryRef.path}`;

        const attachmentUpload = await PostEmbed.createAttachmentUpload(entryFolderPath, newEntryData);

        const hasUploadAttachments = attachmentUpload.files.length > 0;
        let uploadMessage = null;
        if (newEntryData.post && newEntryData.post.uploadMessageId && hasUploadAttachments) {
            uploadMessage = await uploadChannel.messages.fetch(newEntryData.post.uploadMessageId).catch(() => null);
        }

        let uploadArchived = false;
        if (!uploadMessage && hasUploadAttachments) {
            await reportStatus('Uploading attachments...');

            if (uploadChannel.isThread() && uploadChannel.archived) {
                uploadArchived = true;
                await uploadChannel.setArchived(false);
            }

            uploadMessage = await uploadChannel.send({
                content: attachmentUpload.content,
                files: attachmentUpload.files,
            });
            newEntryData.post.uploadMessageId = uploadMessage.id;
        }

        // Remove old attachment message
        const postData = existing ? existing.entry.getData().post : null;
        if (postData && postData.uploadMessageId && postData.uploadMessageId !== newEntryData.post.uploadMessageId) {
            const oldUploadMessage = await uploadChannel.messages.fetch(postData.uploadMessageId).catch(() => null);
            if (oldUploadMessage) {
                await oldUploadMessage.delete().catch((e) => {
                    console.error("Failed to delete old upload message:", e);
                });
            }
        }

        // get comments
        const commentsFile = safeJoinPath(entryFolderPath, 'comments.json');
        let comments: ArchiveComment[] = [];
        try {
            comments = JSON.parse(await fs.readFile(commentsFile, 'utf-8')) as ArchiveComment[];
        }
        catch (e: any) {
            if (e.code !== 'ENOENT') {
                console.error("Error reading comments file:", e);
                throw e;
            }
        }

        newEntryData.num_comments = comments.length;

        const branchName = this.branchName;

        // Next, create the post
        const message = PostEmbed.createInitialMessage(this.guildHolder, newEntryData, entryPathPart);
        const messageChunks: {
            content: string;
            showEmbed: boolean;
            embeds: EmbedBuilder[];
        }[] = splitIntoChunks(message, 2000).map((m) => {
            return {
                content: m,
                showEmbed: false,
                embeds: []
            }
        });

        const serverLinks = getDiscordServersFromReferences([newEntryData.references, newEntryData.author_references].flat());
        if (serverLinks.length > 0) {
            const serverLinkMessage: string[] = [];
            serverLinks.forEach((link) => {
                serverLinkMessage.push(`**${link.name}**: ${link.joinURL}`);
            });
            const serverLinkMsg = truncateStringWithEllipsis(serverLinkMessage.join('\n'), 4000);
            messageChunks.push({
                content: '',
                showEmbed: true,
                embeds: [
                    new EmbedBuilder().setTitle('Server Invite Links').setDescription(serverLinkMsg).setColor(0x00AE86)
                ]
            });
        }

        const hasAttachments = newEntryData.attachments.length > 0;
        if (hasAttachments) {
            const attachmentMessageChunks = splitIntoChunks(await PostEmbed.createAttachmentMessage(this.guildHolder, newEntryData, branchName, entryPathPart, uploadMessage), 2000);
            attachmentMessageChunks.forEach(c => {
                messageChunks.push({
                    content: c,
                    showEmbed: false,
                    embeds: []
                })
            })

            const filtered = filterAttachmentsForViewer(newEntryData.attachments);
            if (filtered.length > 0) {
                const viewerChunks = PostEmbed.createAttachmentViewerMessages(filtered, uploadMessage);
                viewerChunks.forEach(c => {
                    messageChunks.push({
                        content: c,
                        showEmbed: true,
                        embeds: []
                    })
                })
            }
        }

        let wasThreadCreated = false;
        if (!thread) {
            await reportStatus('Creating thread...');
            newEntryData.post.threadId = '';
            newEntryData.post.threadURL = '';
            newEntryData.post.continuingMessageIds = [];
            thread = await archiveChannelDiscord.threads.create({
                message: {
                    content: `Pending...`,
                    flags: [MessageFlags.SuppressEmbeds, MessageFlags.SuppressNotifications]
                },
                name: newEntryData.code + ' ' + newEntryData.name,
                appliedTags: newEntryData.tags.map(tag => tag.id).filter(tagId => archiveChannelDiscord.availableTags.some(t => t.id === tagId)).slice(0, 5),
            })
            wasThreadCreated = true;
        } else {
            await thread.setAppliedTags(newEntryData.tags.map(tag => tag.id).filter(tagId => archiveChannelDiscord.availableTags.some(t => t.id === tagId)).slice(0, 5));
        }

        // check if images changed
        const existingData = existing ? existing.entry.getData() : null;
        let imagesChanged = wasThreadCreated || reprocessImages;

        if (!imagesChanged && existingData) {
            const existingImages = existingData.images.map(i => getFileKey(i) + "|" + i.description);
            const newImages = newEntryData.images.map(i => getFileKey(i) + "|" + i.description);
            if (existingImages.length !== newImages.length) {
                imagesChanged = true;
            } else {
                for (let i = 0; i < existingImages.length; i++) {
                    if (existingImages[i] !== newImages[i]) {
                        imagesChanged = true;
                        break;
                    }
                }
            }
        }

        if (imagesChanged) {
            await reportStatus('Setting thread images...');
            const temp_dir = safeJoinPath(this.guildHolder.getGuildFolder(), 'discord-image-temp', newEntryData.id);
            await fs.mkdir(temp_dir, { recursive: true });

            const files = await PostEmbed.createImageFiles(newEntryData, this.folderPath, temp_dir, entryPathPart, archiveChannelDiscord.defaultForumLayout === ForumLayoutType.GalleryView);
            const initialMessage = await thread.fetchStarterMessage().catch(() => null);
            if (initialMessage) {
                const resultMessage = await initialMessage.edit({
                    content: messageChunks[0].content,
                    files: files.files,
                    allowedMentions: { parse: [] }
                });

                const thumbnailURL = resultMessage.attachments.first()?.url;
                if (thumbnailURL) {
                    newEntryData.post.thumbnailURL = thumbnailURL;
                }
            }

            // delete temp files
            await fs.rm(temp_dir, { recursive: true, force: true }).catch(() => { });
        }

        newEntryData.post.threadId = thread.id;
        newEntryData.post.threadURL = thread.url;

        newEntryData.pastPostThreadIds = mergeTwoArraysUnique(existing ? existing.entry.getData().pastPostThreadIds : [], newEntryData.pastPostThreadIds);

        if (!newEntryData.pastPostThreadIds.includes(thread.id)) {
            newEntryData.pastPostThreadIds.push(thread.id);
        }

        newEntryData.reservedCodes = mergeTwoArraysUnique(existing ? existing.entry.getData().reservedCodes : [], newEntryData.reservedCodes);

        if (!newEntryData.reservedCodes.includes(newEntryData.code)) {
            newEntryData.reservedCodes.push(newEntryData.code);
        }

        if (newEntryData.name !== thread.name) {
            await thread.edit({
                name: newEntryData.code + ' ' + newEntryData.name
            })
        }

        const initialMessage = await thread.fetchStarterMessage().catch(() => null);
        if (!initialMessage) {
            throw new Error('Initial message not found in thread');
        }

        // Detect if thread needs to be refreshed
        let continuingMessageIds = newEntryData.post.continuingMessageIds || [];
        const shouldRefreshThread = (messageChunks.length > 1 + continuingMessageIds.length);
        if (shouldRefreshThread) {
            await reportStatus('Clearing old thread messages...');
            // Delete all previous messages in the thread that are not part of the continuing messages
            for (let i = 0; i < 100; i++) {
                const messages = await thread.messages.fetch({ limit: 100 });
                let deletedCount = 0;
                for (const message of messages.values()) {
                    if (message.id !== initialMessage.id) {
                        await message.delete();
                        deletedCount++;
                    }
                }
                if (deletedCount === 0) {
                    break; // No more messages to delete
                }
            }
            continuingMessageIds = []; // Reset continuing message IDs to force re-creation
        }


        await reportStatus('Updating thread contents...');

        // Delete excess messages if they exist
        if (continuingMessageIds.length > messageChunks.length - 1) {
            const excessMessageIds = continuingMessageIds.slice(messageChunks.length - 1);
            for (const messageId of excessMessageIds) {
                try {
                    const messageInstance = await thread.messages.fetch(messageId).catch(() => null);
                    if (messageInstance) {
                        await messageInstance.delete();
                    }
                } catch (e: any) {
                    console.error(`Error deleting message ${messageId} in thread ${thread.id}:`, e.message);
                }
            }
            continuingMessageIds.splice(messageChunks.length - 1); // Keep only the messages that are still needed
        }

        // Create new messages if needed
        for (let i = continuingMessageIds.length; i < messageChunks.length - 1; i++) {
            const message = await thread.send({
                content: 'Pending...',
                flags: [MessageFlags.SuppressEmbeds, MessageFlags.SuppressNotifications],
            });
            continuingMessageIds.push(message.id);
        }

        // Update the initial message with the first chunk
        if (messageChunks.length > 0) {
            await initialMessage.edit({
                content: messageChunks[0].content,
                flags: messageChunks[0].showEmbed ? [] : [MessageFlags.SuppressEmbeds],
                embeds: messageChunks[0].embeds,
                allowedMentions: { parse: [] }
            });
        }

        // If there are more chunks, send them as separate messages
        for (let i = 1; i < messageChunks.length; i++) {
            const messageId = continuingMessageIds[i - 1];
            const message = await thread.messages.fetch(messageId).catch(() => null);
            if (!message) {
                throw new Error(`Message with ID ${messageId} not found in thread ${thread.id}`);
            }
            await message.edit({
                content: messageChunks[i].content,
                flags: messageChunks[i].showEmbed ? [] : [MessageFlags.SuppressEmbeds],
                embeds: messageChunks[i].embeds,
                allowedMentions: { parse: [] }
            });
        }

        newEntryData.post.continuingMessageIds = continuingMessageIds;

        if (wasThreadCreated || shouldRefreshThread) { // check if there are comments to post
            if (comments.length > 0 && thread.parent) {
                // make webhook
                await reportStatus('Posting comments to thread');
                const threadWebhook = await thread.parent.createWebhook({
                    name: 'LlamaBot Archiver'
                });



                for (const comment of comments) {
                    const author = (await reclassifyAuthors(this.guildHolder, [comment.sender]))[0];
                    comment.sender = author;

                    const files: AttachmentBuilder[] = [];
                    if (comment.attachments.length > 0) {
                        for (const attachment of comment.attachments) {
                            if (!attachment.canDownload || !attachment.path || attachment.contentType === 'discord') {
                                continue; // Skip attachments that cannot be downloaded or have no path
                            }

                            // check if the attachment exists in textAttachments
                            if (attachment.source === AttachmentSource.URLInMessage) {
                                continue; // Skip attachments that are already in the text
                            }

                            const attachmentPath = safeJoinPath(entryFolderPath, attachment.path);
                            if (await fs.access(attachmentPath).then(() => true).catch(() => false)) {
                                const file = new AttachmentBuilder(attachmentPath);
                                file.setName(attachment.name);
                                file.setDescription(attachment.description || '');
                                files.push(file);
                            }
                        }
                    }

                    const commentMessage = await threadWebhook.send({
                        content: truncateStringWithEllipsis(comment.content, 2000),
                        username: getAuthorName(author) || 'Unknown Author',
                        avatarURL: getAuthorIconURL(author),
                        files: files,
                        threadId: thread.id,
                        flags: [MessageFlags.SuppressNotifications]
                    });
                    comment.id = commentMessage.id;
                }
                // Save comments back to the file
                await fs.writeFile(commentsFile, JSON.stringify(comments, null, 2), 'utf-8');
                await this.git.add(commentsFile);
                await threadWebhook.delete();
            }

        }

        if (wasArchived) {
            await thread.setArchived(true, 'Thread was previously archived');
        }

        if (uploadArchived && uploadChannel.isThread()) {
            await uploadChannel.setArchived(true, 'Upload thread was previously archived');
        }

        await reportStatus('Saving data in repository...');
        await entry.savePrivate();
        await archiveChannel.savePrivate();
        await this.git.add(archiveChannel.getDataPath());

        await this.git.add(await this.updateEntryReadme(entry));

        await this.git.add(entryFolderPath);
        await this.git.add(channelPath); // to update currentCodeId and entries

        await this.indexManager.setSubmissionIDForPostID(thread.id, newEntryData.id);
        this.removeFromIgnoreUpdatesFrom(newEntryData.id);


        if (existing) {
            const oldPath = existing.channelRef.path + '/' + existing.entryRef.path;
            const newPath = archiveChannelRef.path + '/' + entryRef.path;
            const oldEntryData = existing.entry.getData();

            const needsRefreshReferences = oldEntryData.post?.threadURL !== newEntryData.post?.threadURL || oldPath !== newPath;
            if (needsRefreshReferences) {
                await reportStatus('Updating cross-references in archive...');

                this.getDictionaryManager().invalidateArchiveIndex();

                const newURL = newEntryData.post?.threadURL || '';
                // just swap urls, no need to reanalyze
                await this.iterateAllEntries(async (entry: ArchiveEntry) => {
                    if (entry.getData().id === newEntryData.id) {
                        return;
                    }

                    // check references
                    const otherData = entry.getData();
                    const references = otherData.references;
                    const authorReferences = otherData.author_references;

                    // check if any are post
                    let updated = false;
                    for (const reference of references) {
                        if (reference.type === ReferenceType.ARCHIVED_POST && reference.id === newEntryData.id) {
                            reference.url = newURL;
                            reference.path = newPath;
                            updated = true;
                        }
                    }

                    for (const authorReference of authorReferences) {
                        if (authorReference.type === ReferenceType.ARCHIVED_POST && authorReference.id === newEntryData.id) {
                            authorReference.url = newURL;
                            authorReference.path = newPath;
                            updated = true;
                        }
                    }

                    if (updated && otherData.post) {
                        await this.addOrUpdateEntryFromData(otherData, otherData.post.forumId, false, false, false, async () => {
                            // do nothing
                        }).catch(e => {
                            console.error("Error updating entry for URL update:", e);
                        });
                    }
                }).catch(e => {
                    console.error("Error iterating all entries:", e);
                });

                // update definitions
                await this.getDictionaryManager().iterateEntries(async (definition) => {
                    let updated = false;
                    for (const reference of definition.references) {
                        if (reference.type === ReferenceType.ARCHIVED_POST && reference.id === newEntryData.id) {
                            reference.url = newURL;
                            reference.path = newPath;
                            updated = true;
                        }
                    }
                    if (updated) {
                        await this.getDictionaryManager().saveEntry(definition);
                        await this.getDictionaryManager().updateStatusMessage(definition).catch(e => {
                            console.error("Error updating definition status message:", e);
                        });
                    }
                });
            }

            await reportStatus('Running post-update tasks...');

            this.guildHolder.onPostUpdate(oldEntryData, entry.getData()).catch(e => {
                console.error("Error handling post update:", e);
            });
        } else {
            await reportStatus('Running post-add tasks...');
            this.guildHolder.onPostAdd(entry.getData()).catch(e => {
                console.error("Error handling post add:", e);
            });
        }

        return {
            oldEntryData: existing ? existing.entry.getData() : undefined,
            newEntryData: entry.getData()
        }
    }

    public updateSubmissionFromEntryData(submission: Submission, entryData?: ArchiveEntryData, removed: boolean = false) {
        const submissionConfig = submission.getConfigManager();
        submissionConfig.setConfig(SubmissionConfigs.POST, removed ? null : (entryData?.post || null));
        const pastThreadsPost = entryData?.pastPostThreadIds || [];
        const pastThreadsSubmission = submissionConfig.getConfig(SubmissionConfigs.PAST_POST_THREAD_IDS);
        const merged = mergeTwoArraysUnique(pastThreadsSubmission, pastThreadsPost);
        submissionConfig.setConfig(SubmissionConfigs.PAST_POST_THREAD_IDS, merged);
        const pastReservedCodes = submissionConfig.getConfig(SubmissionConfigs.RESERVED_CODES);
        const reservedCodesFromEntry = entryData?.reservedCodes || [];
        const mergedCodes = mergeTwoArraysUnique(pastReservedCodes, reservedCodesFromEntry);
        submissionConfig.setConfig(SubmissionConfigs.RESERVED_CODES, mergedCodes);
    }

    async retractSubmission(submission: Submission, reason: string): Promise<ArchiveEntryData> {
        if (!this.git) {
            throw new Error("Git not initialized");
        }
        await this.lock.acquire();
        this.addToIgnoreUpdatesFrom(submission.getId());
        try {
            // Find archived entry in all channels
            const found = await this.findEntryBySubmissionId(submission.getId());
            if (!found) {
                throw new Error(`Submission ${submission.getId()} not found in any archive channel`);
            }
            const { channel: foundChannel, entry: foundEntry, entryIndex: foundEntryIndex } = found;
            const entryData = foundEntry.getData();
            const entryPath = foundEntry.getFolderPath();

            // Remove all files inside the entry folder
            const files = [];
            const stack = [entryPath];
            while (stack.length > 0) {
                const currentPath = stack.pop();
                if (!currentPath) continue;
                const entries = await fs.readdir(currentPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.name === '.DS_Store') {
                        // delete .DS_Store files
                        await fs.unlink(safeJoinPath(currentPath, entry.name));
                        continue; // Skip .DS_Store files
                    }
                    const fullPath = safeJoinPath(currentPath, entry.name);
                    if (entry.isDirectory()) {
                        stack.push(fullPath);
                    } else {
                        files.push(fullPath);
                    }
                }
            }

            await this.git.rm(files);

            // delete folder
            await fs.rm(entryPath, { recursive: true, force: true });

            foundChannel.getData().entries.splice(foundEntryIndex, 1);
            await foundChannel.savePrivate();
            await this.git.add(foundChannel.getDataPath());

            await this.buildPersistentIndexAndEmbeddings();

            // Commit the removal
            await this.commit(`Retracted entry ${entryData.name} (${entryData.code}) from channel ${foundChannel.getData().name} (${foundChannel.getData().code})\nReason: ${reason || 'No reason provided'}`);

            // Now post to discord
            await this.removeDiscordPost(entryData, submission, reason);

            // Remove post
            this.updateSubmissionFromEntryData(submission, entryData, true);

            await submission.save();
            try {
                await this.push();
            } catch (e: any) {
                console.error("Error pushing to remote:", e.message);
            }

            await this.indexManager.deleteSubmissionIDForPostID(entryData.post?.threadId || '');
            this.removeFromIgnoreUpdatesFrom(submission.getId());

            this.guildHolder.onPostDelete(found.entry.getData()).catch(e => {
                console.error("Error handling post delete:", e);
            });

            this.lock.release();

            return entryData;
        } catch (e) {
            this.removeFromIgnoreUpdatesFrom(submission.getId());
            this.lock.release();
            throw e;
        }
    }

    async removeDiscordPost(entryData: ArchiveEntryData, submission: Submission, reason?: string): Promise<void> {
        if (!entryData.post) {
            return; // No post to remove
        }

        const publishForumId = entryData.post.forumId;
        const publishForum = await submission.getGuildHolder().getGuild().channels.fetch(publishForumId).catch(() => null);
        if (!publishForum || publishForum.type !== ChannelType.GuildForum) {
            return; // Publish forum not found or is not a forum channel
        }
        const thread = await publishForum.threads.fetch(entryData.post.threadId).catch(() => null);
        if (!thread) {
            return; // Thread not found in publish forum
        }

        await thread.delete(reason || 'No reason provided').catch(e => {
            console.error("Error deleting thread:", e);
        });
    }


    public sanitizeGit(message: string): string {
        const fallback = "Updated archive data";

        // simple-git forwards this directly to git, so strip shell/meta control chars
        const sanitized = (typeof message === "string" ? message : "")
            .replace(/[\u0000-\u001F\u007F]/g, " ")
            .replace(/[\\`$|&;<>]/g, "")
            .replace(/["']/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 500);

        const withoutLeadingDashes = sanitized.replace(/^-+/, "").trim();
        return withoutLeadingDashes.length > 0 ? withoutLeadingDashes : fallback;
    }

    public async commit(message: string, files?: string | string[]) {
        if (!this.git) {
            return;
        }
        await this.git.commit(this.sanitizeGit(message), files);
    }

    public getLock(): Lock {
        return this.lock;
    }

    public async push() {
        if (!this.git) {
            return;
        }
        await this.updateRemote();
        const branchName = this.branchName;
        await this.git.push(['-u', 'origin', branchName]);
    }

    public getBranchName(): string {
        return this.branchName;
    }

    async save() {
        await this.configManager.saveConfig();
    }

    public getConfigManager(): ConfigManager {
        return this.configManager;
    }



    public async handlePostOrUpdateMessage(message: Message) {
        const postId = message.channel.id;

        if (!this.git) {
            return;
        }


        const submissionId = await this.indexManager.getSubmissionIDByPostID(postId);
        if (!submissionId || this.shouldIgnoreUpdates(submissionId)) {
            return;
        }


        await this.lock.acquire();
        try {

            const found = await this.findEntryBySubmissionId(submissionId);
            if (!found) {
                throw new Error(`No entry found for submission ID ${submissionId}`);
            }

            const content = message.content;
            const attachments = getAttachmentsFromMessage(message);

            const entryPath = found.entry.getFolderPath();

            const commentsFile = safeJoinPath(entryPath, 'comments.json');
            let comments: ArchiveComment[] = [];

            try {
                comments = JSON.parse(await fs.readFile(commentsFile, 'utf-8')) as ArchiveComment[];
            } catch (e: any) {
                if (e.code !== 'ENOENT') {
                    console.error("Error reading comments file:", e);
                    this.lock.release();
                    return;
                }
                await fs.writeFile(commentsFile, JSON.stringify([], null, 2), 'utf-8');
            }

            // Check if the comment already exists
            const existingCommentIndex = comments.findIndex(c => c.id === message.id);
            const existingComment = existingCommentIndex !== -1 ? comments[existingCommentIndex] : null;

            // Check if things have changed
            if (existingComment && existingComment.content === content && !hasAttachmentNameChanged(existingComment.attachments, attachments)) {
                // No changes, nothing to do
                this.lock.release();
                return;
            }

            const commentsAttachmentFolder = safeJoinPath(entryPath, 'comments_attachments');
            if (existingComment && existingComment.attachments.length > 0) {
                for (const attachment of existingComment.attachments) {
                    const attachmentPath = safeJoinPath(commentsAttachmentFolder, getFileKey(attachment));
                    if (attachment.canDownload && !attachments.some(a => a.id === attachment.id)) {
                        await this.git.rm(attachmentPath);
                    }
                }
            }

            if (attachments.length > 0) {
                try {
                    await fs.mkdir(commentsAttachmentFolder, { recursive: true });
                    await processAttachments(attachments, commentsAttachmentFolder, this.guildHolder.getBot(), false);
                    for (const attachment of attachments) {
                        const attachmentPath = safeJoinPath(commentsAttachmentFolder, getFileKey(attachment));
                        if (attachment.canDownload) {
                            attachment.path = `comments_attachments/${getFileKey(attachment)}`;
                            await this.git.add(attachmentPath);
                        }
                    }
                } catch (e: any) {
                    console.error("Error processing attachments:", e);
                }

            }

            const newComment: ArchiveComment = {
                id: message.id,
                sender: {
                    type: AuthorType.DiscordInGuild,
                    id: message.author.id,
                    username: message.author.username,
                    displayName: message.member?.displayName || message.author.username,
                    iconURL: message.author.displayAvatarURL()
                },
                content: content,
                attachments: attachments,
                timestamp: Date.now()
            }

            if (existingComment) {
                // Update existing comment
                comments[existingCommentIndex] = newComment;
            } else {
                // Add new comment
                comments.push(newComment);
            }

            found.entry.getData().num_comments = comments.length;
            await found.entry.savePrivate();
            await this.git.add(found.entry.getDataPath());

            await fs.writeFile(commentsFile, JSON.stringify(comments, null, 2), 'utf-8');
            await this.git.add(commentsFile);
            await this.git.add(await this.updateEntryReadme(found.entry));

            if (existingComment) {
                await this.commit(`Updated comment by ${message.member?.displayName} on ${found.entry.getData().code}`);
            } else {
                await this.commit(`Added ${message.member?.displayName}'s comment to ${found.entry.getData().code}`);
            }

            // check submission
            try {
                const submission = await this.guildHolder.getSubmissionsManager().getSubmission(submissionId);
                if (submission) {
                    // send message to the user
                    const channel = await submission.getSubmissionChannel();
                    if (channel) {



                        const embed = new EmbedBuilder()
                            .setTitle(`Comment ${existingComment ? 'Updated' : 'Added'}`)
                            .setURL(message.url)
                            .setColor(existingComment ? '#ffa500' : '#00ff00')
                            .setAuthor({
                                name: getAuthorName(newComment.sender) || 'Unknown Author',
                                iconURL: getAuthorIconURL(newComment.sender),
                            })
                            .setDescription(newComment.content)
                            .setTimestamp(newComment.timestamp ? new Date(newComment.timestamp) : undefined);
                        if (newComment.attachments.length > 0) {
                            embed.addFields({
                                name: 'Attachments',
                                value: truncateStringWithEllipsis(newComment.attachments.map(a => a.name).join(', '), 1024)
                            });
                        }
                        channel.send({
                            flags: [MessageFlags.SuppressNotifications],
                            embeds: [embed],
                        });
                    }
                }
            } catch (e: any) {
                console.error("Error updating submission:", e.message);
            }

            try {
                await this.push();
            } catch (e: any) {
                console.error("Error pushing to remote:", e.message);
            }
        } catch (e) {
            console.error("Error handling post message:", e);
        }
        this.lock.release();
    }

    public async handlePostMessageDelete(message: Message | PartialMessage) {

        if (!this.git) {
            throw new Error("Git not initialized");
        }

        const postId = message.channelId;
        const submissionId = await this.indexManager.getSubmissionIDByPostID(postId);
        if (!submissionId || this.shouldIgnoreUpdates(submissionId)) {
            return;
        }

        await this.lock.acquire();
        try {
            const found = await this.findEntryBySubmissionId(submissionId);
            if (!found) {
                return;
            }

            const entryPath = found.entry.getFolderPath();

            const commentsFile = safeJoinPath(entryPath, 'comments.json');

            let comments: ArchiveComment[] = [];
            try {
                comments = JSON.parse(await fs.readFile(commentsFile, 'utf-8')) as ArchiveComment[];
            } catch (e) {
            }

            const deletedCommentIndex = comments.findIndex(c => c.id === message.id);
            if (deletedCommentIndex === -1) {
                return;
            }

            const deletedComment = comments[deletedCommentIndex];


            if (deletedComment.attachments.length > 0) {
                const commentsAttachmentFolder = safeJoinPath(entryPath, 'comments_attachments');

                for (const attachment of deletedComment.attachments) {
                    const attachmentPath = safeJoinPath(commentsAttachmentFolder, getFileKey(attachment));
                    if (attachment.canDownload) {
                        try {
                            await this.git.rm(attachmentPath);
                        } catch (e: any) {
                        }
                    }
                }
            }
            comments.splice(deletedCommentIndex, 1);

            // check if there are any attachments left
            const hasAnyAttachmentsLeft = comments.some(c => c.attachments.filter(a => a.canDownload).length > 0);
            if (!hasAnyAttachmentsLeft) {
                // If no attachments left, delete the comments attachments folder
                const commentsAttachmentFolder = safeJoinPath(entryPath, 'comments_attachments');
                // check if folder exists
                if (await fs.access(commentsAttachmentFolder).then(() => true).catch(() => false)) {

                    for (const file of await fs.readdir(commentsAttachmentFolder)) {
                        const filePath = safeJoinPath(commentsAttachmentFolder, file);
                        const stat = await fs.lstat(filePath);
                        if (stat.isFile()) {
                            await fs.unlink(filePath);
                        }
                    }
                    try {
                        await this.git.rm(commentsAttachmentFolder);
                    } catch (e: any) {
                    }
                }
            }

            if (comments.length === 0) {
                // If no comments left, delete the comments file
                await this.git.rm(commentsFile);
            } else {
                await fs.writeFile(commentsFile, JSON.stringify(comments, null, 2), 'utf-8');
                await this.git.add(commentsFile);
            }

            found.entry.getData().num_comments = comments.length;
            await found.entry.savePrivate();
            await this.git.add(found.entry.getDataPath());

            await this.git.add(await this.updateEntryReadme(found.entry));
            await this.commit(`Deleted ${getAuthorName(deletedComment.sender)}'s comment from ${found.entry.getData().code}`);

            // check submission
            try {
                const submission = await this.guildHolder.getSubmissionsManager().getSubmission(submissionId);
                if (submission) {
                    // send message to the user
                    const channel = await submission.getSubmissionChannel();
                    if (channel) {
                        const embed = new EmbedBuilder()
                            .setTitle(`Comment Deleted`)
                            .setColor('#ff0000')
                            .setAuthor({
                                name: getAuthorName(deletedComment.sender) || 'Unknown Author',
                                iconURL: getAuthorIconURL(deletedComment.sender),
                            })
                            .setDescription(deletedComment.content || "(No content)")
                            .setTimestamp();
                        if (deletedComment.attachments.length > 0) {
                            embed.addFields({
                                name: 'Attachments',
                                value: truncateStringWithEllipsis(deletedComment.attachments.map(a => a.name).join(', '), 1024)
                            });
                        }
                        channel.send({
                            flags: [MessageFlags.SuppressNotifications],
                            embeds: [embed]
                        });
                    }
                }
            } catch (e: any) {
                console.error("Error updating submission:", e.message);
            }

            try {
                await this.push();
            } catch (e: any) {
                console.error("Error pushing to remote:", e.message);
            }
        } catch (e) {
            console.error("Error handling post message:", e);
        }
        this.lock.release();
    }

    public async handlePostThreadDelete(thread: AnyThreadChannel) {
        const postId = thread.id;

        if (!this.git) {
            throw new Error("Git not initialized");
        }


        const submissionId = await this.indexManager.getSubmissionIDByPostID(postId);
        if (!submissionId || this.shouldIgnoreUpdates(submissionId)) {
            return;
        }

        await this.lock.acquire();
        try {

            const found = await this.findEntryBySubmissionId(submissionId);
            if (!found) {
                this.lock.release();
                return;
            }

            const entryPath = found.entry.getFolderPath();

            // Remove all files inside the entry folder
            const files = [];
            const stack = [entryPath];
            while (stack.length > 0) {
                const currentPath = stack.pop();
                if (!currentPath) continue;
                const entries = await fs.readdir(currentPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.name === '.DS_Store') {
                        // delete .DS_Store files
                        await fs.unlink(safeJoinPath(currentPath, entry.name));
                        continue; // Skip .DS_Store files
                    }
                    const fullPath = safeJoinPath(currentPath, entry.name);
                    if (entry.isDirectory()) {
                        stack.push(fullPath);
                    } else {
                        files.push(fullPath);
                    }
                }
            }
            await this.git.rm(files);
            // delete folder
            await fs.rm(entryPath, { recursive: true, force: true });

            found.channel.getData().entries.splice(found.entryIndex, 1);
            await found.channel.savePrivate();
            await this.git.add(found.channel.getDataPath());
            await this.indexManager.deleteSubmissionIDForPostID(postId);

            await this.buildPersistentIndexAndEmbeddings();

            // Commit the removal
            await this.commit(`Force deleted ${found.entry.getData().code} ${found.entry.getData().name} from channel ${found.channel.getData().name} (${found.channel.getData().code})`);

            // check submission
            try {
                const submission = await this.guildHolder.getSubmissionsManager().getSubmission(submissionId);
                if (submission) {
                    this.updateSubmissionFromEntryData(submission, found.entry.getData(), true);
                    submission.getConfigManager().setConfig(SubmissionConfigs.STATUS, SubmissionStatus.RETRACTED);
                    submission.getConfigManager().setConfig(SubmissionConfigs.RETRACTION_REASON, 'Thread deleted');

                    // send message to the user
                    const channel = await submission.getSubmissionChannel();
                    if (channel) {
                        channel.send({
                            content: `Notice: The published post has been forcibly retracted because the thread was deleted.`
                        });

                        await submission.save();
                        await submission.statusUpdated();
                    }
                }
                this.guildHolder.logRetraction(found.entry.getData(), 'Thread deleted').catch(e => {
                    console.error("Error logging retraction:", e);
                });
                this.guildHolder.onPostDelete(found.entry.getData()).catch(e => {
                    console.error("Error handling post delete:", e);
                });
            } catch (e: any) {
                console.error("Error updating submission config:", e.message);
            }

            try {
                await this.push();
            } catch (e: any) {
                console.error("Error pushing to remote:", e.message);
            }
        } catch (e) {
            console.error("Error handling post thread delete:", e);
        }
        this.lock.release();
    }

    public async handlePostThreadUpdate(_oldThread: AnyThreadChannel, thread: AnyThreadChannel) {
        if (!thread.parent || thread.parent.type !== ChannelType.GuildForum) {
            return; // No parent, nothing to do
        }
        if (!this.git) {
            throw new Error("Git not initialized");
        }

        const postId = thread.id;
        const submissionId = await this.indexManager.getSubmissionIDByPostID(postId);
        if (!submissionId || this.shouldIgnoreUpdates(submissionId)) {
            return;
        }

        await this.lock.acquire();
        try {


            const found = await this.findEntryBySubmissionId(submissionId);
            if (!found) {
                return;
            }

            // get tags from the thread
            const availableTags = thread.parent.availableTags;
            const newTags = []
            for (const tag of thread.appliedTags) {
                const availableTag = availableTags.find(t => t.id === tag);
                if (availableTag) {
                    newTags.push(availableTag);
                }
            }

            const entryData = found.entry.getData();
            const oldData = deepClone(entryData);

            const addedTags = [];
            const removedTags = []
            const modifiedTags = [];

            for (const tag of newTags) {
                const existingTag = entryData.tags.find(t => t.id === tag.id);
                if (existingTag) {
                    if (existingTag.name !== tag.name) {
                        modifiedTags.push(tag);
                    }
                } else {
                    addedTags.push(tag);
                }
            }

            for (const tag of entryData.tags) {
                const existingTag = newTags.find(t => t.id === tag.id);
                if (!existingTag) {
                    removedTags.push(tag);
                }
            }

            if (addedTags.length === 0 && removedTags.length === 0 && modifiedTags.length === 0) {
                // No tags changed, nothing to do
                this.lock.release();
                return;
            }

            entryData.tags = newTags.map(tag => ({
                id: tag.id,
                name: tag.name
            }));

            await found.channel.savePrivate();
            await this.git.add(found.channel.getDataPath());
            await found.entry.savePrivate();
            await this.git.add(found.entry.getDataPath());
            await this.git.add(await this.updateEntryReadme(found.entry));
            // check submission
            try {
                const submission = await this.guildHolder.getSubmissionsManager().getSubmission(submissionId);
                if (submission) {
                    submission.getConfigManager().setConfig(SubmissionConfigs.TAGS, entryData.tags);

                    // send message to the user
                    const channel = await submission.getSubmissionChannel();
                    if (channel) {

                        let message = ``;
                        if (addedTags.length > 0) {
                            if (addedTags.length === 1) {
                                message += `Added tag **${addedTags[0].name}**`;
                            } else {
                                message += `Added tags **${addedTags.map(t => t.name).join(', ')}**`;
                            }
                        }

                        if (removedTags.length > 0) {
                            if (message.length > 0) {
                                message += `, `;
                            }
                            if (removedTags.length === 1) {
                                message += `Removed tag **${removedTags[0].name}**`;
                            } else {
                                message += `Removed tags **${removedTags.map(t => t.name).join(', ')}**`;
                            }
                        }

                        if (addedTags.length > 0 || removedTags.length > 0) {
                            await channel.send({
                                content: message + (removedTags.length > 0 ? ' from the post.' : ' to the post.'),
                            });
                            await submission.save();
                            await submission.statusUpdated();

                            await this.buildPersistentIndexAndEmbeddings();
                        }
                    }
                }
                // this.guildHolder.logUpdate(oldEntryData, entryData).catch(e => {
                //     console.error("Error logging tag change:", e);
                // });
            } catch (e: any) {
                console.error("Error updating submission config:", e.message);
            }

            await this.commit(`Updated tags for ${entryData.code} because thread was updated`);
            try {
                await this.push();
            } catch (e: any) {
                console.error("Error pushing to remote:", e.message);
            }

            this.guildHolder.onPostUpdate(oldData, entryData).catch(e => {
                console.error("Error handling post update:", e);
            });
        } catch (e) {
            console.error("Error handling post thread update:", e);
        }
        this.lock.release();
    }

    public async getEntriesByAuthor(author: Author, endorsers: boolean = false): Promise<ArchiveEntryData[]> {
        const entries: ArchiveEntryData[] = [];
        const channelRefs = await this.getChannelReferences();
        for (const channelRef of channelRefs) {
            const channelPath = safeJoinPath(this.folderPath, channelRef.path);
            const archiveChannel = await ArchiveChannel.fromFolder(channelPath);
            for (const entryRef of archiveChannel.getData().entries) {
                const entryPath = safeJoinPath(channelPath, entryRef.path);
                const entry = await ArchiveEntry.fromFolder(entryPath);
                if (!entry) {
                    continue; // Skip if entry cannot be loaded
                }
                const entryData = entry.getData();
                const compareAuthors = endorsers ? entryData.endorsers : entryData.authors;
                if (compareAuthors.some(otherAuthor => {
                    return areAuthorsSame(otherAuthor, author);
                })) {
                    entries.push(entryData);
                }
            }
        }
        return entries;
    }

    async updateEntryReadme(entry: ArchiveEntry): Promise<string> {
        const entryData = entry.getData();
        const readmePath = safeJoinPath(entry.getFolderPath(), 'README.md');

        // Generate the README content
        let comments: ArchiveComment[] = [];
        const commentsFile = safeJoinPath(entry.getFolderPath(), 'comments.json');
        try {
            comments = JSON.parse(await fs.readFile(commentsFile, 'utf-8')) as
                ArchiveComment[];
        } catch (e: any) {
            if (e.code !== 'ENOENT') {
                console.error("Error reading comments file:", e);
            }
        }
        const readmeContent = makeEntryReadMe(entryData, comments, this.guildHolder.getSchemaStyles());

        // Write the README file
        await fs.writeFile(readmePath, readmeContent, 'utf-8');
        return readmePath
    }

    public async getArchiveStats(): Promise<{ numPosts: number, numSubmissions: number }> {
        let numPosts = 0;

        const channelRefs = await this.getChannelReferences();
        for (const channelRef of channelRefs) {
            const channelPath = safeJoinPath(this.folderPath, channelRef.path);
            const archiveChannel = await ArchiveChannel.fromFolder(channelPath);
            numPosts += archiveChannel.getData().entries.length;
        }

        const numSubmissions = (await this.guildHolder.getSubmissionsManager().getSubmissionsList()).length;

        return {
            numPosts,
            numSubmissions
        };
    }

    public async getUserArchiveStats(user: Author): Promise<{ numPosts: number, numSubmissions: number, numEndorsed: number }> {
        let numPosts = 0;
        let numEndorsed = 0;

        const channelRefs = await this.getChannelReferences();
        for (const channelRef of channelRefs) {
            const channelPath = safeJoinPath(this.folderPath, channelRef.path);
            const archiveChannel = await ArchiveChannel.fromFolder(channelPath);
            for (const entryRef of archiveChannel.getData().entries) {
                const entryPath = safeJoinPath(channelPath, entryRef.path);
                const entry = await ArchiveEntry.fromFolder(entryPath);
                if (!entry) {
                    continue; // Skip if entry cannot be loaded
                }
                const entryData = entry.getData();
                if (entryData.authors.some(a => areAuthorsSame(a, user))) {
                    numPosts++;
                }
                if (entryData.endorsers.some(a => areAuthorsSame(a, user))) {
                    numEndorsed++;
                }
            }
        }

        let numSubmissions = 0;
        const submissions = await this.guildHolder.getSubmissionsManager().getSubmissionsList();
        for (const submissionId of submissions) {
            const submission = await this.guildHolder.getSubmissionsManager().getSubmission(submissionId);
            if (!submission) {
                continue; // Skip if submission cannot be loaded
            }
            const authors = submission.getConfigManager().getConfig(SubmissionConfigs.AUTHORS) || [];
            if (authors.some(a => areAuthorsSame(a, user))) {
                numSubmissions++;
            }
        }
        return {
            numPosts,
            numSubmissions,
            numEndorsed
        };
    }

    public getDictionaryManager(): DictionaryManager {
        return this.dictionaryManager;
    }

    public getIndexManager(): IndexManager {
        return this.indexManager;
    }

    public getDiscordServersDictionary(): DiscordServersDictionary {
        return this.discordServersDictionary;
    }

    public isReady(): boolean {
        return this.git !== null;
    }

    public getGuildHolder(): GuildHolder {
        return this.guildHolder;
    }
}
