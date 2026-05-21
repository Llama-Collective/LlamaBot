import { Bot } from '../Bot.js'
import { Message, Snowflake, TextBasedChannel, TextThreadChannel } from 'discord.js'
import { Attachment, AttachmentSource, BaseAttachment } from '../submissions/Attachment.js'
import { Image } from '../submissions/Image.js'
import Path from 'path'
import fs from 'fs/promises'
import got from 'got'
import sharp from 'sharp'
import { MCMeta } from './MCMeta.js'
import { deepClone, escapeDiscordString, escapeString, formatSize, getMessageAuthor, truncateStringWithEllipsis } from './Util.js'
import { Author } from '../submissions/Author.js'
import { findWorldsInZip, optimizeWorldsInZip } from './WDLUtils.js'
import { safeJoinPath } from './SafePath.js'
import { createHash } from 'crypto'
import nbt from 'prismarine-nbt';

// Matches both cdn.discordapp.com and media.discordapp.net attachment URLs
const DISCORD_ATTACHMENT_REGEX = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\//;

export async function changeImageName(processed_folder: string, oldImage: BaseAttachment, newImage: BaseAttachment): Promise<void> {

    const oldPath = safeJoinPath(processed_folder, getFileKey(oldImage, 'png'));
    const newPath = safeJoinPath(processed_folder, getFileKey(newImage, 'png'));
    try {
        await fs.rename(oldPath, newPath);
        newImage.path = getFileKey(newImage, 'png');
    } catch (error) {
        console.error(`Failed to rename image file from ${oldPath} to ${newPath}:`, error);
    }
}

export async function changeAttachmentName(attachments_folder: string, oldAttachment: BaseAttachment, newAttachment: BaseAttachment): Promise<void> {
    if (!newAttachment.canDownload || !newAttachment.path) {
        return;
    }
    const oldPath = safeJoinPath(attachments_folder, getFileKey(oldAttachment));
    const newPath = safeJoinPath(attachments_folder, getFileKey(newAttachment));

    try {
        await fs.rename(oldPath, newPath);
        newAttachment.path = getFileKey(newAttachment);
    } catch (error) {
        console.error(`Failed to rename image file from ${oldPath} to ${newPath}:`, error);
    }
}

export async function optimizeImage(path: string, processedPath: string): Promise<{
    width: number;
    height: number;
    size: number;
}> {
    let simage = sharp(path);
    const stats = await simage.stats();
    if (!stats.isOpaque) {
        simage = simage.trim();
    }

    const s = await simage
        .resize({
            width: 1200,
            height: 1200,
            fit: 'inside',
            withoutEnlargement: true,
        })
        .png({
            compressionLevel: 9,
            palette: true,
            effort: 8
        })
        .toFile(processedPath);
    return {
        width: s.width,
        height: s.height,
        size: s.size,
    };
}

export async function processImages(images: Image[], download_folder: string, processed_folder: string, bot: Bot): Promise<Image[]> {
    if (images.length > 0) {
        // Check if the folders exist, if not, create them
        if (!await fs.access(download_folder).then(() => true).catch(() => false)) {
            await fs.mkdir(download_folder, { recursive: true });
        }
        if (!await fs.access(processed_folder).then(() => true).catch(() => false)) {
            await fs.mkdir(processed_folder, { recursive: true });
        }
    }

    // Remove images that are already processed but not in the current list
    const existingFiles = await fs.readdir(processed_folder);
    await Promise.all(existingFiles.map(async file => {
        // check if the file is in the images list
        const fileKey = file.toLowerCase();
        if (!images.some(image => getFileKey(image, 'png') === fileKey)) {
            const filePath = safeJoinPath(processed_folder, file);
            try {
                await fs.unlink(filePath);
            } catch (err) {
                console.error(`Failed to remove file ${filePath}:`, err);
            }
        }
    }));

    const imageURLs = images.map(image => image.url);
    const refreshedURLs = await refreshAttachments(imageURLs, bot);

    await Promise.all(images.map(async (image, i) => {
        const processedKey = getFileKey(image, 'png');
        const processedPath = safeJoinPath(processed_folder, processedKey);
        // If the processed image already exists, skip processing
        if (await fs.access(processedPath).then(() => true).catch(() => false)) {
            // set path though
            image.path = processedKey;
            return;
        }

        const downloadPath = safeJoinPath(download_folder, getFileKey(image));
        let imageData;
        try {
            imageData = await got(refreshedURLs[i], { responseType: 'buffer' });
        } catch (error) {
            throw new Error(`Failed to download image ${image.name} at ${refreshedURLs[i]}, try reuploading the file directly to the thread.`);
        }
        await fs.writeFile(downloadPath, imageData.body);
        const metadata = await optimizeImage(downloadPath, processedPath);
        image.width = metadata.width;
        image.height = metadata.height;
        image.size = metadata.size;
        image.path = processedKey;
        const optimizedData = await fs.readFile(processedPath);
        image.hash = createHash('sha256').update(optimizedData).digest('hex');


        await fs.unlink(downloadPath); // Remove the original file after processing
    }));

    // Remove the download folder if it was created
    try {
        await fs.rm(download_folder, { recursive: true, force: true });
    } catch (err) {

    }

    return images;

}


export function filterAttachments<T>(attachments: (T & {
    contentType: string;
    name: string;
})[]): T[] {
    return attachments.filter(attachment => {
        if (!attachment.contentType) {
            return false;
        }
        if (attachment.contentType === 'application/x-msdos-program') {
            return false;
        }
        // make sure .exe files are excluded
        if (attachment.name.endsWith('.exe')) {
            return false;
        }
        return true;
    });
}

export function filterImages<T extends BaseAttachment>(attachments: T[]): T[] {
    return attachments.filter(attachment => {
        return isAttachmentImage(attachment);
    });
}


export async function processImageForDiscord(file_path: string, temp_dir: string, num_images: number, image_idx: number, isGalleryView: boolean): Promise<string> {
    const output_path = safeJoinPath(temp_dir, `processed_${image_idx}.png`);
    let newWidth = 386 * 2;
    let newHeight = 258 * 2;
    let padding = 0;

    if (isGalleryView) {
        if (num_images === 1) { // Single image, use larger size
            padding = 60;
            newHeight = newHeight - padding;
        } else if (num_images === 2) { // Two images, width is half
            newWidth = Math.floor(newWidth / 2) - 15;
            padding = 60;
            newHeight = newHeight - padding;
        } else if (num_images === 3) { // Three images
            if (image_idx === 0) { // First image is large
                newWidth = Math.floor(newWidth / 2) - 15;
                newHeight = newHeight;
            } else { // Other two images are small
                newWidth = Math.floor(newWidth / 2) - 15;
                newHeight = Math.floor(newHeight / 2) - 10;
            }
            padding = 0;
        } else { // More than or equal to four images, all are tiny
            if (image_idx > 3) {
                newWidth = 546; // discord quad image size
                newHeight = 346;
            }
            padding = 0;
        }
    } else { // not gallery view, use 1:1 aspect ratio for first image
        if (image_idx === 0 || num_images < 4) {
            newWidth = 800;
            newHeight = 800;
        } else {
            newWidth = 546; // discord quad image size
            newHeight = 346;
        }
    }

    // Scale so that largest dimension is 1200px
    if (newWidth > newHeight) {
        const scale = 1200 / newWidth;
        newWidth = 1200;
        newHeight = Math.floor(newHeight * scale);
        // also scale padding
        padding = Math.floor(padding * scale);
    } else {
        const scale = 1200 / newHeight;
        newHeight = 1200;
        newWidth = Math.floor(newWidth * scale);
        // also scale padding
        padding = Math.floor(padding * scale);
    }

    await sharp(file_path)
        .resize({
            width: newWidth,
            height: newHeight,
            fit: 'contain',
            // withoutEnlargement: true,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .extend({
            bottom: padding,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png({
            compressionLevel: 9,
            palette: true,
        })
        .toFile(output_path);

    return output_path;
}

export async function analyzeYoutube(attachment: Attachment) {
    // https://noembed.com/embed?dataType=json&
    const url = attachment.url;
    const noEmbedAPI = 'https://noembed.com/embed?dataType=json&url=' + encodeURIComponent(url);
    try {
        const response = await got(noEmbedAPI, { responseType: 'json' });
        if (response.statusCode !== 200) {
            console.error(`Failed to fetch YouTube link details for ${url}: HTTP ${response.statusCode}`);
            return;
        }
        const data = response.body as any;
        attachment.youtube = {
            title: data.title || 'Unknown Title',
            author_name: data.author_name || 'Unknown Author',
            author_url: data.author_url || '#',
            thumbnail_url: data.thumbnail_url || '',
            thumbnail_width: data.thumbnail_width || 0,
            thumbnail_height: data.thumbnail_height || 0,
            width: data.width || 0,
            height: data.height || 0,
        };
    } catch (error) {
        console.error(`Failed to fetch YouTube link details for ${url}:`, error);
    }
}

export async function processAttachments(attachments: Attachment[], attachments_folder: string, bot: Bot, remove_old: boolean = true): Promise<Attachment[]> {
    // Check if the folder exists, if not, create it
    if (attachments.length > 0) {
        if (!await fs.access(attachments_folder).then(() => true).catch(() => false)) {
            await fs.mkdir(attachments_folder, { recursive: true });
        }
    }

    // Remove attachments that are already processed but not in the current list
    if (remove_old) {
        const existingFiles = await fs.readdir(attachments_folder);
        await Promise.all(existingFiles.map(async file => {
            // check if the file is in the attachments list
            const fileKey = file.toLowerCase();
            if (!attachments.some(attachment => getFileKey(attachment) === fileKey)) {
                const filePath = safeJoinPath(attachments_folder, file);
                try {
                    await fs.unlink(filePath);
                } catch (err) {
                    console.error(`Failed to remove file ${filePath}:`, err);
                }
            }
        }));
    }

    const attachmentURLs = attachments.map(a => a.url);
    const attachmentURLsRefreshed = await refreshAttachments(attachmentURLs, bot);

    // Process each attachment
    await Promise.all(attachments.map(async (attachment, index) => {
        const key = getFileKey(attachment);
        if (attachment.canDownload && !attachment.path) {
            const attachmentPath = safeJoinPath(attachments_folder, key);

            // If the attachment already exists, skip download
            if (!await fs.access(attachmentPath).then(() => true).catch(() => false)) {
                try {
                    const attachmentData = await got(attachmentURLsRefreshed[index], { responseType: 'buffer' });
                    await fs.writeFile(attachmentPath, attachmentData.body);
                    attachment.hash = createHash('sha256').update(attachmentData.body).digest('hex');
                    attachment.path = key;
                } catch (error) {
                    throw new Error(`Failed to download attachment ${attachment.name} at ${attachmentURLsRefreshed[index]}, try reuploading the file directly to the thread.`);
                }
            }
        }
    }));

    // Analyze attachments
    await analyzeAttachments(attachments, attachments_folder);

    return attachments;
}

export async function analyzeAttachments(attachments: Attachment[], attachments_folder: string): Promise<Attachment[]> {
    const mcMeta = new MCMeta();
    await mcMeta.fetchVersionData();

    await Promise.all(attachments.map(async (attachment) => {
        if (attachment.canDownload && attachment.path) {
            const attachmentPath = safeJoinPath(attachments_folder, attachment.path);
            if (!attachment.size) {
                const fileMetadata = await fs.stat(attachmentPath).catch(() => null);
                if (fileMetadata) {
                    attachment.size = fileMetadata.size;
                }
            }
            if (isAttachmentLitematic(attachment)) {
                // Process litematic files
                await analyzeLitematic(attachment, attachmentPath, mcMeta);
            } else if (isAttachmentSchematic(attachment)) {
                // Process schematic files
                await analyzeSchematic(attachment, attachmentPath, mcMeta);
            } else if (isAttachmentZip(attachment)) {
                // Process zip files
                await analyzeWDL(attachment, attachmentPath);
            } else if (isAttachmentImage(attachment)) {
                // Process image files
                await analyzeImage(attachment, attachmentPath);
            }
        } else if (attachment.contentType === 'youtube') {
            // Process YouTube links
            await analyzeYoutube(attachment);
        }
    }));
    return attachments;
}

async function analyzeImage(attachment: Attachment, attachmentPath: string): Promise<void> {
    try {
        const image = sharp(attachmentPath);
        const metadata = await image.metadata();
        if (metadata.width && metadata.height) {
            attachment.image = {
                width: metadata.width,
                height: metadata.height,
            }
        }
    } catch (error) {
        console.error('Error processing image file:', error)
    }
}

async function analyzeLitematic(attachment: Attachment, attachmentPath: string, mcMeta: MCMeta): Promise<void> {
    try {
        const litematicFile = await fs.readFile(attachmentPath);
        const parsed = await nbt.parse(litematicFile);
        const data = parsed.parsed as any;
        const minecraftDataVersion = data?.value?.MinecraftDataVersion?.value;
        if (minecraftDataVersion === undefined) {
            throw new Error('Invalid litematic file: Missing MinecraftDataVersion');
        }

        const version = mcMeta.getByDataVersion(minecraftDataVersion);

        const metaDataTag = data?.value?.Metadata?.value;
        if (!metaDataTag) {
            throw new Error('Invalid litematic file: Missing Metadata tag');
        }

        const enclosingSizeTag = metaDataTag.EnclosingSize?.value;
        if (!enclosingSizeTag) {
            throw new Error('Invalid litematic file: Missing EnclosingSize tag');
        }

        const x = enclosingSizeTag.x?.value;
        const y = enclosingSizeTag.y?.value;
        const z = enclosingSizeTag.z?.value;
        if (x === undefined || y === undefined || z === undefined) {
            throw new Error('Invalid litematic file: Missing EnclosingSize dimensions');
        }

        const sizeString = `${x}x${y}x${z}`;

        attachment.litematic = {
            size: sizeString,
            version: version ? version.minecraftVersion : 'Unknown',
        }
    } catch (error) {
        console.error('Error processing litematic file:', error)
        attachment.litematic = {
            error: 'Error processing litematic file'
        }
    }
}


async function analyzeSchematic(attachment: Attachment, attachmentPath: string, mcMeta: MCMeta): Promise<void> {
    try {
        const schematicFile = await fs.readFile(attachmentPath);
        const parsed = await nbt.parse(schematicFile);
        const data = parsed.parsed as any;
        const schematicTag = data?.value?.Schematic?.value ?? data?.value;
        if (!schematicTag) {
            throw new Error('Invalid schematic file: Missing Schematic tag');
        }

        const dataVersion = schematicTag.DataVersion?.value;
        if (dataVersion === undefined) {
            throw new Error('Invalid schematic file: Missing DataVersion');
        }

        const version = mcMeta.getByDataVersion(dataVersion);

        const sizeTag = schematicTag.size?.value;

        let width, height, length;

        if (sizeTag) {
            width = sizeTag[0]?.value;
            height = sizeTag[1]?.value;
            length = sizeTag[2]?.value;
        } else {
            width = schematicTag.Width?.value;
            height = schematicTag.Height?.value;
            length = schematicTag.Length?.value;
        }

        if (width === undefined || height === undefined || length === undefined) {
            throw new Error('Invalid schematic file: Missing dimensions');
        }

        const sizeString = `${width}x${height}x${length}`;
        attachment.schematic = {
            size: sizeString,
            version: version ? version.minecraftVersion : 'Unknown',
        }
    } catch (error) {
        console.error('Error processing schematic file:', error)
        attachment.schematic = {
            error: 'Error processing schematic file'
        }
    }
}


export async function optimizeAttachments(
    attachments: Attachment[],
    attachments_folder: string, temp_folder: string,
    progressCallback: (message: string) => Promise<void>
): Promise<Attachment[]> {
    let tempIndex = 0;
    await fs.mkdir(temp_folder, { recursive: true });

    const optimized_folder = safeJoinPath(temp_folder, 'optimized');
    await fs.mkdir(optimized_folder, { recursive: true });

    for (const attachment of attachments) {
        if (attachment.wdl && attachment.path) {
            const attachmentPath = safeJoinPath(attachments_folder, attachment.path);
            const optimizedPath = safeJoinPath(optimized_folder, attachment.path);

            const existsInOptimized = await fs.access(optimizedPath).then(() => true).catch(() => false);
            if (existsInOptimized) { // do nothing if already optimized
                continue;
            }

            const existsInOriginal = await fs.access(attachmentPath).then(() => true).catch(() => false);
            if (!existsInOriginal) {
                continue;
            }

            const originalFileStats = await fs.stat(attachmentPath).catch(() => null);

            await progressCallback(`Optimizing attachment ${attachment.name}...`);
            // make temp folder

            const tempAttachmentPath = safeJoinPath(temp_folder, `temp_${tempIndex++}`);

            await fs.mkdir(tempAttachmentPath);
            try {
                const result = await optimizeWorldsInZip(attachmentPath, tempAttachmentPath, optimizedPath);
                if (result.zipPath) {
                    attachment.wdl.optimized = true;

                    // update size
                    const optimizedFileStats = await fs.stat(result.zipPath).catch(() => null);
                    if (optimizedFileStats) {
                        attachment.unoptimizedSize = originalFileStats?.size;
                        attachment.size = optimizedFileStats.size;
                    }

                    // overwrite attachment path to optimized file
                    await fs.copyFile(result.zipPath, attachmentPath);
                }
            } catch (error) {
                console.error('Error optimizing WDL file:', error);
            }

            const finalFileData = await fs.readFile(attachmentPath).catch(() => null);
            if (finalFileData) {
                attachment.hash = createHash('sha256').update(finalFileData).digest('hex');
            }
        }
    }

    // Remove temp folder
    await fs.rm(temp_folder, { recursive: true, force: true }).catch(() => { });

    return attachments;
}

export function filterAttachmentsForViewer(attachments: Attachment[]): Attachment[] {
    return attachments.filter((attachment) => {
        if (attachment.contentType.startsWith("image") || attachment.contentType.startsWith("video")) {
            return true;
        }

        if (attachment.contentType === 'youtube') {
            return true;
        }

        if (attachment.contentType !== 'discord') {
            return false;
        }

        const allowedExt = [
            ".png",
            ".jpg",
            ".jpeg",
            ".mp4",
            ".mp3"
        ]

        if (allowedExt.some((o) => attachment.name.endsWith(o))) {
            return true;
        }

        return false;
    })
}


function compareSemver(a: string, b: string): number {
    const parse = (v: string) => v.split('.').map(num => parseInt(num));
    const aParts = parse(a);
    const bParts = parse(b);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const aNum = aParts[i] || 0;
        const bNum = bParts[i] || 0;
        if (aNum > bNum) return -1;
        if (aNum < bNum) return 1;
    }
    return 0;
}

async function analyzeWDL(attachment: Attachment, attachmentPath: string): Promise<void> {
    try {
        const analysis = await findWorldsInZip(attachmentPath);

        if (analysis.length === 0) {
            return;
        }

        attachment.wdls = analysis;

        if (!attachment.wdl) {
            attachment.wdl = {};
        }

        let versions = new Set<string>();
        for (const world of analysis) {
            if (world.version) {
                versions.add(world.version);
            }
        }

        if (!versions.size) {
            attachment.wdl.error = analysis[0].error || 'No valid worlds found';
            return;
        }

        // sort versions descending
        const versionsArray = Array.from(versions);
        versionsArray.sort(compareSemver);

        attachment.wdl.version = versionsArray.join(', ');
    } catch (error) {
        console.error('Error processing WDL file:', error);
    }
}

export async function iterateAllMessages(channel: TextBasedChannel, iterator: (message: Message) => Promise<boolean>) {
    let messages = await channel.messages.fetch({ limit: 100 });
    while (messages.size > 0) {
        for (const msg of messages.values()) {
            // If the iterator returns false, stop iterating
            if (!await iterator(msg)) {
                return;
            }
        }
        messages = await channel.messages.fetch({ limit: 100, before: messages.last()?.id });
    }
}
export function getAttachmentsFromText(text: string, attachments: BaseAttachment[], timestamp: number, author: Author): BaseAttachment[] {
    // Find all URLs in the message
    const urls = text.match(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g)
    if (urls) {
        urls.forEach(urlCandidate => {
            const url = urlCandidate.endsWith(')') ? urlCandidate.slice(0, -1) : urlCandidate; // remove trailing parenthesis if exists
            // check first match location, if it is preceded by a colon + space, it has a description
            const index = text.indexOf(url);
            let description;
            if (index > 2 && text.charAt(index - 1) === ' ' && text.charAt(index - 2) === ':') {
                // then get whole line before that
                const lineStart = text.lastIndexOf('\n', index - 2) + 1;
                description = text.substring(lineStart, index - 2).trim();

                // make sure description doesn't start with a dash, or star (used for lists)
                if (description.startsWith('- ') || description.startsWith('* ')) {
                    description = description.substring(2).trim();
                }
            }

            // if description is too long, truncate it
            if (description && description.length > 300) {
                description = truncateStringWithEllipsis(description, 300);
            }

            // Check if mediafire
            // https://www.mediafire.com/file/idjbw9lc1kt4obj/1_17_Crafter-r2.zip/file
            // https://www.mediafire.com/folder/5ajiire4a6cs5/Scorpio+MIS
            if (url.startsWith('https://www.mediafire.com/file/') || url.startsWith('https://www.mediafire.com/folder/')) {
                const id = url.split('/')[4].substring(0, 20) // limit to first 20 characters
                const name = url.split('/')[5]
                // check if duplicate
                if (attachments.some(attachment => attachment.id === id)) {
                    return;
                }
                attachments.push({
                    id: id,
                    name: name,
                    contentType: 'mediafire',
                    url: url,
                    timestamp: timestamp,
                    author: author,
                    source: AttachmentSource.URLInMessage,
                    description: description || '',
                    canDownload: false // MediaFire links cannot be downloaded directly
                })
            } else if (url.startsWith('https://youtu.be/') || url.startsWith('https://www.youtube.com/watch')) {
                // YouTube links
                let videoId = (new URL(url).searchParams.get('v') || url.split('/').pop() || '').substring(0, 20);
                if (!videoId) return;

                // clean video id
                videoId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');

                if (attachments.some(attachment => attachment.id === videoId)) {
                    return;
                }

                const urlCleaned = new URL(url); // remove trailing parenthesis if exists

                // remove the si parameter if exists for anti-tracking
                urlCleaned.searchParams.delete('si');

                attachments.push({
                    id: videoId,
                    name: `YouTube Video ${videoId}`,
                    contentType: 'youtube',
                    url: urlCleaned.toString(),
                    timestamp: timestamp,
                    author: author,
                    source: AttachmentSource.URLInMessage,
                    description: description || '',
                    canDownload: false // YouTube links cannot be downloaded directly
                })
            } else if (DISCORD_ATTACHMENT_REGEX.test(url)) {
                // https://cdn.discordapp.com/attachments/749137321710059542/912059917106548746/Unbreakable_8gt_reset_6gt_box_replacement.litematic?ex=6832c4bd&is=6831733d&hm=1e5ff51ca94199d70f26ad2611715c86afbb095e3da120416e55352ccf43f7a4&
                const id = url.split('/')[5]
                const name = url.split('/')[6].split('?')[0]
                if (attachments.some(attachment => attachment.id === id)) {
                    return;
                }
                attachments.push({
                    id: id,
                    name: name,
                    contentType: 'discord',
                    url: url,
                    timestamp: timestamp,
                    author: author,
                    source: AttachmentSource.URLInMessage,
                    description: description || '',
                    canDownload: true // Discord CDN links can be downloaded directly
                })
            } else if (url.startsWith('https://bilibili.com/') || url.startsWith('https://www.bilibili.com/')) {
                // Bilibili links
                const urlObj = new URL(url);
                const videoId = (urlObj.pathname.split('/')[2] || urlObj.searchParams.get('bvid') || '').substring(0, 20);
                if (!videoId) return;
                if (attachments.some(attachment => attachment.id === videoId)) {
                    return;
                }
                attachments.push({
                    id: videoId,
                    name: `Bilibili Video ${videoId}`,
                    contentType: 'bilibili',
                    url: url,
                    timestamp: timestamp,
                    author: author,
                    source: AttachmentSource.URLInMessage,
                    description: description || '',
                    canDownload: false // Bilibili links cannot be downloaded directly
                })
            }
        })
    }
    return attachments;
}

export function getAttachmentsFromMessage(message: Message, attachments: BaseAttachment[] = []): BaseAttachment[] {

    const author = getMessageAuthor(message);

    if (message.content.length > 0) {
        // Get attachments from the message text
        getAttachmentsFromText(message.content, attachments, message.createdTimestamp, author);
    }
    if (message.attachments.size > 0) {
        const hasDescription = message.content.startsWith("Description:");
        let description = hasDescription ? message.content.substring(12).trim() : '';

        if (!description && message.content.length < 100 && message.attachments.size === 1) {
            // If only one attachment, use whole message as description
            description = message.content.split('\n')[0].trim(); // only first line
        }

        // if description is too long, truncate it
        if (description && description.length > 300) {
            description = truncateStringWithEllipsis(description, 300);
        }

        message.attachments.forEach(attachment => {
            const index = attachments.findIndex(attachment2 => attachment2.id === attachment.id);

            if (index !== -1) {
                return;
            }
            attachments.push({
                id: attachment.id,
                name: attachment.name,
                contentType: attachment.contentType || 'unknown',
                url: attachment.url,
                timestamp: message.createdTimestamp,
                author: author,
                source: AttachmentSource.MessageAttachment,
                description: attachment.description || description || '',
                size: attachment.size,
                canDownload: true, // Discord attachments can be downloaded directly
            });
        })
    }

    if (message.messageSnapshots.size > 0) {
        message.messageSnapshots.forEach(snapshot => {
            if (snapshot.content.length > 0) {
                // Get attachments from the message snapshot text
                getAttachmentsFromText(snapshot.content, attachments, message.createdTimestamp, author);
            }
            if (snapshot.attachments.size > 0) {
                snapshot.attachments.forEach(attachment => {
                    const index = attachments.findIndex(attachment2 => attachment2.id === attachment.id);

                    if (index !== -1) {
                        return;
                    }
                    attachments.push({
                        id: attachment.id,
                        name: attachment.name,
                        contentType: attachment.contentType || 'unknown',
                        url: attachment.url,
                        timestamp: message.createdTimestamp,
                        author: author,
                        source: AttachmentSource.MessageAttachment,
                        description: attachment.description || '',
                        size: attachment.size,
                        canDownload: true, // Discord attachments can be downloaded directly
                    });
                })
            }
        })
    }
    return attachments;
}

export async function getAllAttachments(channel: TextThreadChannel, selfID: Snowflake): Promise<BaseAttachment[]> {
    let attachments: Attachment[] = [];

    await iterateAllMessages(channel, async (message: Message) => {
        if (message.author.id === selfID) {
            return true;
        }
        // Get attachments from the message
        getAttachmentsFromMessage(message, attachments);

        return true;
    });
    return attachments;
}


export function isAttachmentImage(attachment: BaseAttachment): boolean {
    // check content type
    if (attachment.contentType.startsWith('image/')) {
        return true;
    }

    // check file name, the extension
    const ext = getFileExtension(attachment.name);
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];
    if (imageExts.includes(ext)) {
        return true;
    }

    return false;
}

export function isAttachmentLitematic(attachment: BaseAttachment): boolean {
    const ext = getFileExtension(attachment.name);
    return ext === 'litematic';
}

export function isAttachmentSchematic(attachment: BaseAttachment): boolean {
    const ext = getFileExtension(attachment.name);
    return ext === 'schematic' || ext === 'schem' || ext === 'nbt';
}

export function isAttachmentZip(attachment: BaseAttachment): boolean {
    const ext = getFileExtension(attachment.name);
    return ext === 'zip';
}

export function isAttachmentVideo(attachment: BaseAttachment): boolean {
    // check content type
    if (attachment.contentType.startsWith('video/')) {
        return true;
    }

    // check file name, the extension
    const ext = getFileExtension(attachment.name);
    const videoExts = ['mp4', 'mov', 'wmv', 'flv', 'avi', 'mkv', 'webm'];
    if (videoExts.includes(ext)) {
        return true;
    }

    return false;
}

export async function refreshAttachments(
    attachmentURLs: string[],
    bot: Bot
): Promise<string[]> {
    if (!attachmentURLs || attachmentURLs.length === 0) {
        return [];
    }

    const attachmentObjects: { url: string }[] = attachmentURLs.map(url => ({ url }));
    const expiringAttachments = attachmentObjects.filter(obj => {
        const url = obj.url;
        if (!url) return false; // No URL provided

        // Check if discord cdn (supports both cdn.discordapp.com and media.discordapp.net)
        if (!DISCORD_ATTACHMENT_REGEX.test(url)) {
            return false; // Not a Discord CDN URL
        }
        // get the `ex` parameter from the URL
        const urlObj = new URL(url);
        const exParam = urlObj.searchParams.get('ex');
        if (!exParam) return true; // No expiration parameter
        if (parseInt(exParam, 16) * 1000 > Date.now()) { // If the expiration is in the future, keep it
            return !(urlObj.searchParams.get("is") && urlObj.searchParams.get("hm"))
        }
        // check other parameters
        return true;
    });

    if (expiringAttachments.length > 0) {
        try {
            const result = await bot.client.rest.post('/attachments/refresh-urls', {
                body: {
                    attachment_urls: expiringAttachments.map(a => a.url)
                },
            }) as any;
            if (!result || !result.refreshed_urls || !Array.isArray(result.refreshed_urls)) {
                throw new Error('Invalid response from attachment refresh API');
            }

            result.refreshed_urls.forEach((data: { original: string, refreshed: string }) => {
                if (!data.original || !data.refreshed) {
                    console.warn(`Invalid data received for attachment refresh: ${JSON.stringify(data)}`);
                    return;
                }
                const index = attachmentObjects.findIndex(obj => obj.url === data.original);
                if (index !== -1) {
                    attachmentObjects[index].url = data.refreshed;
                } else {
                    console.warn(`Original URL ${data.original} not found in attachment objects.`);
                }
            });
        } catch (error: any) {
            console.error(`Failed to refresh attachment URLs: ${error.message}`);
            throw new Error(`Failed to refresh attachment URLs, try reuploading the files directly to the thread. Error: ${error.message}`);
        }
    }
    return attachmentObjects.map(obj => obj.url);
}

export function deduplicateAttachmentNames<T extends BaseAttachment>(attachments: T[], prefix: string, forceExtension?: string): T[] {
    const results: T[] = [];
    for (const attachment of attachments) {
        const dest = attachment.name.split('.');
        let ext = dest.length > 1 ? escapeString(dest.pop() || '') : '';
        if (!attachment.canDownload) {
            ext = 'url';
        }

        if (forceExtension) {
            ext = forceExtension;
        }

        const baseName = prefix + escapeString(dest.join('.'));
        let chosenBaseName = baseName;
        for (let i = 0; i < 15; i++) {
            const newBaseName = i === 0 ? baseName : `${baseName}_${i}`;
            const fullName = `${newBaseName}${ext ? '.' + ext : ''}`;
            if (!results.find(a => a.name === fullName)) {
                chosenBaseName = newBaseName;
                break;
            }
        }
        const newAttachment = deepClone(attachment);
        newAttachment.name = `${chosenBaseName}${ext ? '.' + ext : ''}`;
        results.push(newAttachment);
    }
    return results;
}

export function splitFileName(fileName: string): { basename: string; ext: string } {
    const split = fileName.split('.');
    let ext = split.length > 1 ? split.pop() || '' : '';
    const basename = split.join('.');
    return { basename, ext };
}

export function getFileKey(file: Attachment | Image, new_ext: string = '') {
    const name = `${file.id}-${escapeString(file.name)}`.toLowerCase();
    // First, get file extension if it exists
    const split = name.split('.')
    let ext = split.length > 1 ? split.pop() : '';
    if (new_ext) {
        ext = new_ext.toLowerCase();
    }
    const prefix = split.join('.');
    // Then, escape the string
    const escapedPrefix = escapeString(prefix)
    const escapedExt = ext ? `.${escapeString(ext)}` : ''
    return `${escapedPrefix}${escapedExt}`;
}


export function getFileExtension(fileName: string): string {
    return Path.extname(fileName).slice(1).toLowerCase();
}

export function getFileNameWithoutExtension(fileName: string): string {
    return Path.basename(fileName, Path.extname(fileName));
}

export function getAttachmentDescriptionForMenus(attachment: BaseAttachment): string {
    const dateTime = new Date(attachment.timestamp).toLocaleString([], {
        timeZoneName: 'short'
    });
    if (attachment.description) {
        return `${dateTime} - ${attachment.description}`;
    }
    return `${dateTime} - No description`;
}

export type AttachmentCategory = 'video' | 'image' | 'wdl' | 'litematic' | 'schematic' | 'other';

export function getAttachmentCategory(attachment: Attachment): AttachmentCategory {
    if (
        attachment.contentType === 'youtube' ||
        attachment.contentType === 'bilibili' ||
        isAttachmentVideo(attachment)
    ) {
        return 'video';
    }
    if (isAttachmentImage(attachment)) {
        return 'image';
    }
    if (attachment.wdl) {
        return 'wdl';
    }
    if (attachment.litematic || isAttachmentLitematic(attachment)) {
        return 'litematic';
    }

    if (attachment.schematic || isAttachmentSchematic(attachment)) {
        return 'schematic';
    }

    return 'other';
}

export type AttachmentPostMessageOptions = {
    uploadedURL?: string;
    githubLink?: string | null;
};

export function getAttachmentPostMessage(
    attachment: Attachment,
    options: AttachmentPostMessageOptions = {}
): string {
    const timestamp = `<t:${Math.floor(attachment.timestamp / 1000)}:s>`;
    const uploadedURL = options.uploadedURL || attachment.url;
    const githubMirror = options.githubLink ? ` [[Github Mirror]](${options.githubLink})` : '';

    let message = '';
    if (attachment.contentType === 'bilibili') {
        message = `- [${escapeDiscordString(attachment.name)}](${attachment.url}): Bilibili video\n`;
    } else if (attachment.contentType === 'youtube') {
        if (!attachment.youtube) {
            message = `- [${escapeDiscordString(attachment.name)}](${attachment.url}): YouTube link\n`;
        } else {
            const authorship = attachment.youtube.author_url !== '#' ? ` by [${escapeDiscordString(attachment.youtube.author_name)}](${attachment.youtube.author_url})` : ` by ${escapeDiscordString(attachment.youtube.author_name)}`;
            message = `- [${escapeDiscordString(attachment.youtube.title)}](${attachment.url}): YouTube video${authorship}\n`;
        }
    } else if (attachment.contentType === 'mediafire') {
        message = `- [${escapeDiscordString(attachment.name)}](${attachment.url}): Mediafire link, ${timestamp}\n`;
    } else if (attachment.litematic) {
        const viewerLink = options.githubLink
            ? ` [[View Schematic]](https://llamamc.org/renderer?url=${options.githubLink})`
            : '';
        message = `- ${uploadedURL}${viewerLink}: MC ${attachment.litematic?.version || "Version Unknown"}, Size ${attachment.litematic?.size || "Unknown"}, ${timestamp}\n`;
    } else if (attachment.schematic) {
        const viewerLink = options.githubLink
            ? ` [[View Schematic]](https://llamamc.org/renderer?url=${options.githubLink})`
            : '';
        message = `- ${uploadedURL}${viewerLink}: MC ${attachment.schematic?.version || "Version Unknown"}, Size ${attachment.schematic?.size || "Unknown"}, ${timestamp}\n`;
    } else if (attachment.wdl) {
        message = `- ${uploadedURL}${githubMirror}: MC ${attachment.wdl?.version || "Version Unknown"}, ${timestamp}\n`;
    } else if (attachment.image) {
        message = `- ${uploadedURL}${githubMirror}: Image, ${attachment.image.width}x${attachment.image.height}, ${timestamp}\n`;
    } else if (isAttachmentVideo(attachment)) {
        if (attachment.canDownload) {
            message = `- ${uploadedURL}${githubMirror}: Video, ${timestamp}\n`;
        } else {
            message = `- [${escapeDiscordString(attachment.name)}](${attachment.url}): Video link\n`;
        }
    } else if (attachment.contentType === 'discord') {
        message = `- ${uploadedURL}${githubMirror}: Discord attachment, ${timestamp}\n`;
    } else {
        message = `- ${uploadedURL}${githubMirror}: ContentType ${attachment.contentType}, ${timestamp}\n`;
    }

    if (attachment.description) {
        message += `  - ${attachment.description.trim()}\n`;
    }

    return message;
}

export function getAttachmentSetMessage(attachment: Attachment): string {
    const timestamp = `<t:${Math.floor(attachment.timestamp / 1000)}:s>`;
    const sizeSuffix = typeof attachment.size === 'number' ? `, ${formatSize(attachment.size)}${attachment.unoptimizedSize && attachment.unoptimizedSize !== attachment.size ? ` (was ${formatSize(attachment.unoptimizedSize)})` : ''}` : '';
    let linkOrName = `[${escapeDiscordString(escapeString(attachment.name))}](${attachment.url})`;
    if (attachment.canDownload) {
        // check url name
        let urlName = '';
        try {
            const url = new URL(attachment.url);
            urlName = url.pathname.split('/').pop() || '';
        } catch (error) {
            // not a valid url, ignore
        }
        if (urlName && urlName !== attachment.name) {
            linkOrName = attachment.url + ` (${escapeDiscordString(attachment.name)})`;
        } else {
            linkOrName = attachment.url;
        }
    }

    let message = '';
    if (attachment.contentType === 'bilibili') {
        message = `- [${escapeDiscordString(attachment.name)}](${attachment.url}): Bilibili video\n`;
    } else if (attachment.contentType === 'youtube') {
        if (!attachment.youtube) {
            message = `- [${escapeDiscordString(attachment.name)}](${attachment.url}): YouTube link\n`;
        } else {
            const authorship = attachment.youtube.author_url !== '#' ? ` by [${escapeDiscordString(attachment.youtube.author_name)}](${attachment.youtube.author_url})` : ` by ${escapeDiscordString(attachment.youtube.author_name)}`;
            message = `- [${escapeDiscordString(attachment.youtube.title)}](${attachment.url}): YouTube video${authorship}\n`;
        }
    } else if (attachment.wdl) {
        message = `- ${linkOrName}: ${attachment.wdl?.error || `MC ${attachment.wdl?.version}`}${sizeSuffix}, ${timestamp}\n`;
    } else if (attachment.litematic) {
        message = `- ${linkOrName}: ${attachment.litematic?.error || `MC ${attachment.litematic?.version}, ${attachment.litematic?.size}`}${sizeSuffix}, ${timestamp}\n`;
    } else if (attachment.schematic) {
        message = `- ${linkOrName}: ${attachment.schematic?.error || `MC ${attachment.schematic?.version}, ${attachment.schematic?.size}`}${sizeSuffix}, ${timestamp}\n`;
    } else if (attachment.image) {
        message = `- ${linkOrName}: Image ${attachment.image.width}x${attachment.image.height}${sizeSuffix}, ${timestamp}\n`;
    } else if (isAttachmentVideo(attachment)) {
        message = `- ${linkOrName}: Video${sizeSuffix}, ${timestamp}\n`;
    } else if (attachment.contentType === 'mediafire') {
        message = `- [${escapeDiscordString(escapeString(attachment.name))}](${attachment.url}): Mediafire link, ${timestamp}\n`;
    } else if (attachment.contentType === 'discord') {
        message = `- ${linkOrName}: Discord attachment${sizeSuffix}, ${timestamp}\n`;
    } else {
        message = `- ${linkOrName}: ContentType ${attachment.contentType}${sizeSuffix}, ${timestamp}\n`;
    }

    if (attachment.description) {
        message += `  - ${attachment.description}\n`;
    }

    return message;
}

export function getAttachmentsSetMessage(attachments: Attachment[]): string {
    if (attachments.length === 0) {
        return 'No attachments set.';
    }
    const litematics: Attachment[] = []
    const schematics: Attachment[] = []
    const wdls: Attachment[] = []
    const videos: Attachment[] = []
    const images: Attachment[] = []
    const others: Attachment[] = []
    attachments.forEach(attachment => {
        switch (getAttachmentCategory(attachment)) {
            case 'litematic':
                litematics.push(attachment);
                break;
            case 'schematic':
                schematics.push(attachment);
                break;
            case 'wdl':
                wdls.push(attachment);
                break;
            case 'video':
                videos.push(attachment);
                break;
            case 'image':
                images.push(attachment);
                break;
            case 'other':
                others.push(attachment);
                break;
        }
    })

    let description = '';
    if (litematics.length) {
        description += '**Litematics:**\n'
        litematics.forEach(attachment => {
            description += getAttachmentSetMessage(attachment);
        })
    }

    if (schematics.length) {
        description += '**Schematics:**\n'
        schematics.forEach(attachment => {
            description += getAttachmentSetMessage(attachment);
        })
    }

    if (wdls.length) {
        description += '**WDLs:**\n'
        wdls.forEach(attachment => {
            description += getAttachmentSetMessage(attachment);
        })
    }

    if (videos.length) {
        description += '**Videos:**\n'
        videos.forEach(attachment => {
            description += getAttachmentSetMessage(attachment);
        })
    }

    if (images.length) {
        description += '**Images:**\n'
        images.forEach(attachment => {
            description += getAttachmentSetMessage(attachment);
        })
    }

    if (others.length) {
        description += '**Other files:**\n'
        others.forEach(attachment => {
            description += getAttachmentSetMessage(attachment);
        })
    }
    return description;
}
