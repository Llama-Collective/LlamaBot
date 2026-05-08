import { Command } from '../interface/Command.js'
import { Button } from '../interface/Button.js'
import { Menu } from '../interface/Menu.js'
import { Modal } from '../interface/Modal.js'
import { Secrets, SysAdmin } from '../Bot.js'
import { ActionRowBuilder, Interaction, Message, MessageFlags, PermissionFlagsBits, REST, Routes, Snowflake } from 'discord.js'
import { GuildHolder } from '../GuildHolder.js'
import { Attachment, BaseAttachment } from '../submissions/Attachment.js'
import { Image } from '../submissions/Image.js'
import Path from 'path'
import { AllAuthorPropertiesAccessor, Author, AuthorType, DiscordAuthor } from '../submissions/Author.js'
import { ArchiveEntryData } from '../archive/ArchiveEntry.js'
import { GuildConfigs } from '../config/GuildConfigs.js'
import { Submission } from '../submissions/Submission.js'
import { SubmissionConfigs } from '../submissions/SubmissionConfigs.js'
import { Tag } from '../submissions/Tag.js'
import { SubmissionStatus } from '../submissions/SubmissionStatus.js'
import { SubmissionRecord } from './MarkdownUtils.js'
import { ContextMenuCommand } from '../interface/ContextMenuCommand.js'
import { getFileKey } from './AttachmentUtils.js'

export function getItemsFromArray<T extends (Button | Menu | Modal | Command | ContextMenuCommand)>(itemArray: T[]): Map<string, T> {
    const items = new Map()
    for (const item of itemArray) {
        if (items.has(item.getID())) {
            throw new Error('Duplicate item ' + item.getID())
        }
        items.set(item.getID(), item)
    }
    return items
}

export async function deployCommands(
    commandsMap: Map<string, Command | ContextMenuCommand>,
    guildHolder: GuildHolder,
    secrets: Secrets
) {
    const commands = Array.from(commandsMap, command => command[1].getBuilder(guildHolder).toJSON())

    const rest = new REST().setToken(secrets.token)

    return rest.put(Routes.applicationGuildCommands(secrets.clientId, guildHolder.getGuildId()), { body: commands })
}

export async function replyReplace(doUpdate: boolean, interaction: Interaction, content: string, components: ActionRowBuilder<any>[] = []) {
    try {
        if (doUpdate && interaction.isRepliable() && interaction.deferred) {
            return await interaction.editReply({
                content: content,
                components: components,
                embeds: [],
                allowedMentions: { parse: [] }
            })
        } else if ((interaction.isButton() || interaction.isStringSelectMenu()) && doUpdate) {
            return await interaction.update({
                content: content,
                components: components,
                embeds: [],
                allowedMentions: { parse: [] }
            })
        } else if (interaction.isRepliable() && !interaction.replied) {
            await interaction.reply({
                content: content,
                components: components,
                flags: [MessageFlags.SuppressNotifications, MessageFlags.Ephemeral],
                embeds: [],
                allowedMentions: { parse: [] }
            })
        } else if (interaction.isRepliable()) {
            return await interaction.followUp({
                content: content,
                components: components,
                flags: [MessageFlags.SuppressNotifications, MessageFlags.Ephemeral],
                embeds: [],
                allowedMentions: { parse: [] }
            })
        } else {
            throw new Error('Cannot reply to interaction')
        }

    } catch (error: any) {
        console.error('Error replying replace:', error);
    }
}

export async function replyEphemeral(interaction: any, content: string, options = {}) {
    try {
        if (!interaction.replied) {
            return await interaction.reply({
                ...options,
                content: content,
                flags: MessageFlags.Ephemeral
            })
        } else {
            return await interaction.followUp({
                ...options,
                content: content,
                flags: MessageFlags.Ephemeral
            })
        }
    } catch (error: any) {
        console.error('Error replying ephemeral:', error);
        return null;
    }
}

export function escapeString(str: string): string {
    if (!str) return '';
    return str
        .trim()
        .replace(/ +/g, '_')
        .replace(/[^a-zA-Z0-9_\-.]/g, '')
}

export function getAuthorsString(authors: Author[] | null): string {
    if (!authors || authors.length === 0) {
        return 'No authors';
    }
    return authors.map(author => {
        if (author.type === AuthorType.DiscordInGuild) {
            // return `<@${author.id}>`;
            // Because of https://support.discord.com/hc/en-us/community/posts/22954438916375--Suggestion-Make-mentions-of-user-IDs-visible-again-Now-they-just-show-unknown-user
            // we must show the username as well or else it will just show unknown user which is not helpful at all
            return `${author.url ? `[${escapeDiscordString(author.displayName)}](${author.url})` : escapeDiscordString(author.displayName)} (<@${author.id}>)`;
        } else if (author.type === AuthorType.DiscordLeftGuild) {
            return `${author.url ? `[${escapeDiscordString(author.displayName)}](${author.url})` : escapeDiscordString(author.displayName)} (<@${author.id}>)`;
        } else if (author.type === AuthorType.DiscordExternal) {
            return `${author.url ? `[${escapeDiscordString(author.username)}](${author.url})` : escapeDiscordString(author.username)} (<@${author.id}>)`;
        } else if (author.type === AuthorType.DiscordDeleted) {
            // check if username is deleted_user_*
            if (author.username.startsWith('deleted_user_')) {
                // then just return "Deleted User (<@id>)"
                return `${author.url ? `[Deleted User](${author.url})` : 'Deleted User'} (<@${author.id}>)`;
            } else {
                return `${author.url ? `[${escapeDiscordString(author.displayName || author.username)}](${author.url})` : escapeDiscordString(author.displayName || author.username)} (<@${author.id}>)`;
            }
        } else if (author.url) {
            return `[${escapeDiscordString(author.username)}](${author.url})`;
        } else {
            return escapeDiscordString(author.username);
        }
    }).join(', ');
}

export function getAuthorName(author: Author): string {
    if (author.type === AuthorType.DiscordInGuild || author.type === AuthorType.DiscordLeftGuild) {
        return author.displayName;
    } else {
        return author.username;
    }
}

export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const results: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
        results.push(array.slice(i, i + chunkSize));
    }
    return results;
}

export function getAuthorIconURL(author: Author): string | undefined {
    return (author as AllAuthorPropertiesAccessor).iconURL;
}

export function mergeTwoArraysUnique<T>(array1: T[], array2: T[]): T[] {
    const set = new Set<T>(array1);
    for (const item of array2) {
        set.add(item);
    }
    return Array.from(set);
}

export function getCodeAndDescriptionFromTopic(topic: string): { code: string | null, description: string } {
    if (!topic) {
        return { code: null, description: '' };
    }
    // /Code: ([a-zA-Z]*)/
    // description is everything other than the code
    const codeMatch = topic.match(/(Code: ([a-zA-Z0-9_]*))/);
    let code = null;
    let description = topic;
    if (codeMatch) {
        code = codeMatch[2].toUpperCase();
        description = topic.replace(codeMatch[1], '').trim();
    }
    return { code, description };
}

export function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj)) as T;
}

export function areObjectsIdentical<T>(obj1: T, obj2: T): boolean {
    // walk
    let stack = [[obj1, obj2]];
    while (stack.length > 0) {
        const [a, b] = stack.pop() as [any, any];

        if (a === b) continue; // same reference or both null

        if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
            return false; // different types or one is null
        }

        if (Array.isArray(a) !== Array.isArray(b)) {
            return false; // one is array, the other is not
        }

        if (Array.isArray(a)) {
            if (a.length !== b.length) {
                return false; // different array lengths
            }
            for (let i = 0; i < a.length; i++) {
                stack.push([a[i], b[i]]); // push each element for comparison
            }
        } else {
            const keysA = Object.keys(a);
            const keysB = Object.keys(b);

            if (keysA.length !== keysB.length) {
                return false; // different number of keys
            }

            for (const key of keysA) {
                if (!Object.hasOwn(b, key)) {
                    return false; // key exists in a but not in b
                }
                stack.push([a[key], b[key]]); // push each value for comparison
            }
        }
    }
    return true; // all keys and values match
}

export type Change<T> = {
    old: T;
    new: T;
}

export type Changes = {
    name?: Change<string>;
    code?: Change<string>;
    authors?: Change<Author[]>;
    endorsers?: Change<Author[]>;
    tags?: Change<Tag[]>;
    records?: Record<string, Change<SubmissionRecord | null>>;
    images?: Change<Image[]>;
    attachments?: Change<Attachment[]>;
}

export function getChange<T>(old: T, updated: T): Change<T> | undefined {
    if (areObjectsIdentical(old, updated)) {
        return undefined;
    }
    return { old, new: updated };
}

export function hasAttachmentNameChanged(old: BaseAttachment[], updated: BaseAttachment[]): Change<BaseAttachment[]> | undefined {
    // Create sets for old and new arrays
    const oldSet = new Set(old.map(item => getFileKey(item)));
    const newSet = new Set(updated.map(item => getFileKey(item)));

    // Check if the sets are identical
    if (newSet.size === oldSet.size && oldSet.intersection(newSet).size === oldSet.size) {
        return undefined; // No changes
    }
    return { old, new: updated };
}

export function getChangeNames<T extends { name: string }>(old: T[], updated: T[]): Change<T[]> | undefined {
    // Create sets for old and new arrays
    const oldSet = new Set(old.map(item => item.name));
    const newSet = new Set(updated.map(item => item.name));

    // Check if the sets are identical
    if (newSet.size === oldSet.size && oldSet.intersection(newSet).size === oldSet.size) {
        return undefined; // No changes
    }
    return { old, new: updated };
}


export function getChanges(
    existing: ArchiveEntryData,
    updated: ArchiveEntryData,
): Changes {
    return {
        name: getChange(existing.name, updated.name),
        code: getChange(existing.code, updated.code),
        authors: getChange(existing.authors, updated.authors),
        endorsers: getChange(existing.endorsers, updated.endorsers),
        tags: getChangeNames(existing.tags, updated.tags),
        records: getChangeRecords(existing.records, updated.records),
        images: hasAttachmentNameChanged(existing.images, updated.images),
        attachments: hasAttachmentNameChanged(existing.attachments, updated.attachments)
    }
}

export function getChangeRecords(
    existing: Record<string, SubmissionRecord>,
    updated: Record<string, SubmissionRecord>,
): Record<string, Change<SubmissionRecord | null>> {
    const changes: Record<string, Change<SubmissionRecord | null>> = {};
    const allKeys = new Set([...Object.keys(existing), ...Object.keys(updated)]);

    for (const key of allKeys) {
        const oldRecord = existing[key];
        const newRecord = updated[key];

        if (oldRecord && newRecord) {
            // Both exist, check for changes
            if (!areObjectsIdentical(oldRecord, newRecord)) {
                changes[key] = { old: oldRecord, new: newRecord };
            }
        } else if (oldRecord) {
            // Only in existing
            changes[key] = { old: oldRecord, new: null };
        } else if (newRecord) {
            // Only in updated
            changes[key] = { old: null, new: newRecord };
        }
    }
    return changes;
}

export function truncateStringWithEllipsis(str: string, maxLength: number): string {
    const ellipsis = '...';

    if (str.length <= maxLength) {
        return str;
    }

    if (maxLength <= ellipsis.length) {
        return ellipsis.slice(0, maxLength);
    }

    const sliceLength = maxLength - ellipsis.length;
    const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;

    let adjusted = str;
    let match: RegExpExecArray | null;

    while ((match = markdownLinkRegex.exec(adjusted)) !== null) {
        const start = match.index;
        const end = start + match[0].length;

        if (start < sliceLength && sliceLength < end) {
            // Remove the Markdown wrapper when the cut would land inside a link.
            adjusted = adjusted.slice(0, start) + match[1] + adjusted.slice(end);

            if (adjusted.length <= maxLength) {
                return adjusted;
            }

            markdownLinkRegex.lastIndex = start;
            continue;
        }

        if (start >= sliceLength) {
            break;
        }
    }

    return adjusted.slice(0, sliceLength) + ellipsis;
}

export function generateCommitMessage(
    existing: ArchiveEntryData,
    updated: ArchiveEntryData,
): string {
    // --- Diff checks ---------------------------------------------------------
    const changes = getChanges(existing, updated);
    // --- Build message fragments --------------------------------------------
    const fragments: string[] = [];

    if (changes.code) {
        fragments.push(`code changed from “${changes.code.old}” to “${changes.code.new}”`);
    }
    if (changes.name) {
        fragments.push(`renamed “${changes.name.old}” to “${changes.name.new}”`);
    }
    if (changes.authors) fragments.push("updated authors");
    if (changes.endorsers) fragments.push("updated endorsers");
    if (changes.tags) fragments.push("updated tags");
    if (changes.records) {
        for (const [key, change] of Object.entries(changes.records)) {
            if (change.old && change.new) {
                fragments.push(`updated ${key}`);
            } else if (change.old) {
                fragments.push(`removed ${key}`);
            } else if (change.new) {
                fragments.push(`added ${key}`);
            }
        }
    }

    if (changes.images) fragments.push("updated images");
    if (changes.attachments) fragments.push("updated attachments");

    // --- Assemble final commit message --------------------------------------
    if (fragments.length === 0) {
        return "No changes";
    }

    // Capitalize first fragment for a cleaner message.
    fragments[0] =
        fragments[0].charAt(0).toUpperCase() + fragments[0].slice(1);

    // Join with commas, inserting “and” before the last item if we have >1.
    let message: string;
    if (fragments.length === 1) {
        message = fragments[0];
    } else {
        const last = fragments.pop();
        message = `${fragments.join(", ")} and ${last}`;
    }

    return message;
}

export function getGithubOwnerAndProject(url: string): { owner: string, project: string } {
    const parsedUrl = new URL(url);
    const pathParts = parsedUrl.pathname.split('/').filter(part => part.length > 0);

    if (pathParts.length < 2) {
        throw new Error('Invalid GitHub URL');
    }

    const owner = pathParts[0];
    const project = pathParts[1].replace(/\.git$/, ''); // Remove .git if present
    return { owner, project };
}

function trimSlashes(path: string): string {
    return path.replace(/^\/+|\/+$/g, '');
}

export function buildGithubRawContentURL(owner: string, project: string, branchName: string, path: string = ''): string {
    const base = `https://raw.githubusercontent.com/${owner}/${project}/refs/heads/${branchName}`;
    const cleanPath = trimSlashes(path);
    return cleanPath ? `${base}/${cleanPath}` : base;
}

export function buildGithubMediaContentURL(owner: string, project: string, branchName: string, path: string = ''): string {
    const base = `https://media.githubusercontent.com/media/${owner}/${project}/refs/heads/${branchName}`;
    const cleanPath = trimSlashes(path);
    return cleanPath ? `${base}/${cleanPath}` : base;
}

export function formatSize(sizeInBytes: number): string {
    if (sizeInBytes < 1024) {
        return `${sizeInBytes} B`;
    } else if (sizeInBytes < 1024 * 1024) {
        return `${(sizeInBytes / 1024).toFixed(2)} KB`;
    } else if (sizeInBytes < 1024 * 1024 * 1024) {
        return `${(sizeInBytes / (1024 * 1024)).toFixed(2)} MB`;
    } else {
        return `${(sizeInBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
}

/**
 * Checks if the interaction has admin permissions.
 */
export function isAdmin(interaction: Interaction): boolean {
    if (interaction.user.id === SysAdmin) {
        return true
    }
    if (!interaction.member || !interaction.inGuild()) {
        return false
    }
    if (interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return true
    }
    return false
}

/**
 * Checks if the interaction has moderator permissions.
 */
export function isModerator(interaction: Interaction): boolean {
    if (interaction.user.id === SysAdmin) {
        return true
    }
    if (!interaction.member || !interaction.inGuild()) {
        return false
    }
    if (interaction.memberPermissions.has(PermissionFlagsBits.ManageMessages)) {
        return true
    }
    return false
}

/**
 * Check if the interaction is from the owner of the thread.
 */
export function isAuthor(interaction: Interaction, submission: Submission): boolean {
    if (!interaction.member || !interaction.inGuild() || !interaction.channel) {
        return false
    }

    if (!interaction.channel.isThread()) {
        return false
    }

    if (interaction.channel.ownerId === interaction.member.user.id) {
        return true
    }

    // Check if the interaction is from the author of the submission
    const authors = submission.getConfigManager().getConfig(SubmissionConfigs.AUTHORS);
    if (authors && authors.length > 0) {
        for (const author of authors) {
            if (author.type === AuthorType.Unknown) continue; // Skip unknown authors
            if (author.dontDisplay) continue; // Skip authors that don't want to be displayed
            if (author.id === interaction.member.user.id) {
                return true;
            }
        }
    }

    return false
}

/**
 * Check if the interaction has an endorser role.
 */
export function isEndorser(interaction: Interaction, guildHolder: GuildHolder): boolean {
    if (interaction.user.id === SysAdmin) {
        return true
    }
    if (!interaction.member || !interaction.inCachedGuild()) {
        return false
    }
    const member = interaction.member;
    const endorseRoleIds = guildHolder.getConfigManager().getConfig(GuildConfigs.ENDORSE_ROLE_IDS);
    if (!endorseRoleIds || endorseRoleIds.length === 0) {
        return false;
    }
    for (const roleId of endorseRoleIds) {
        if (member.roles.cache.has(roleId)) {
            return true;
        }
    }
    return false;
}

/**
 * Check if the interaction has an editor role.
 */
export function isEditor(interaction: Interaction, guildHolder: GuildHolder): boolean {
    if (interaction.user.id === SysAdmin) {
        return true
    }
    if (!interaction.member || !interaction.inCachedGuild()) {
        return false
    }
    const member = interaction.member;
    const editorRoleIds = guildHolder.getConfigManager().getConfig(GuildConfigs.EDITOR_ROLE_IDS);
    if (!editorRoleIds || editorRoleIds.length === 0) {
        return false;
    }
    for (const roleId of editorRoleIds) {
        if (member.roles.cache.has(roleId)) {
            return true;
        }
    }
    return false;
}


export function canEditSubmission(interaction: Interaction, submission: Submission): boolean {
    if (!interaction.inCachedGuild() || !interaction.member) {
        return false;
    }

    if (isAdmin(interaction) || isModerator(interaction) || isEditor(interaction, submission.getGuildHolder()) || isEndorser(interaction, submission.getGuildHolder())) {
        return true;
    }

    if (submission.getConfigManager().getConfig(SubmissionConfigs.IS_LOCKED)) {
        return false;
    }

    if (isAuthor(interaction, submission)) {
        return true;
    }

    return false;
}

export function canPublishSubmission(interaction: Interaction, submission: Submission): boolean {
    if (!interaction.inCachedGuild() || !interaction.member) {
        return false;
    }

    if (isAdmin(interaction) || isModerator(interaction) || isEditor(interaction, submission.getGuildHolder())) {
        return true;
    }

    if (isAuthor(interaction, submission) && isEndorser(interaction, submission.getGuildHolder())) {
        return true;
    }

    if (submission.getConfigManager().getConfig(SubmissionConfigs.ON_HOLD) || (submission.getConfigManager().getConfig(SubmissionConfigs.STATUS) !== SubmissionStatus.WAITING && submission.getConfigManager().getConfig(SubmissionConfigs.IS_LOCKED))) {
        return false;
    }

    if (isAuthor(interaction, submission)) {
        return true;
    }

    return false;
}

export function canSetPrivilegedTags(interaction: Interaction, submission: Submission): boolean {
    if (!interaction.inCachedGuild() || !interaction.member) {
        return false;
    }

    if (isAdmin(interaction) || isModerator(interaction) || isEditor(interaction, submission.getGuildHolder())) {
        return true;
    }

    return false
}

export async function getDiscordAuthorsFromIDs(guildHolder: GuildHolder, ids: Snowflake[]): Promise<DiscordAuthor[]> {
    const authors: DiscordAuthor[] = [];
    for (const id of ids) {
        const member = await guildHolder.getGuild().members.fetch(id).catch(() => null);
        if (member) {
            authors.push({
                type: AuthorType.DiscordInGuild,
                id: id,
                username: member.user.username,
                displayName: member.displayName,
                iconURL: member.user.displayAvatarURL()
            });
            continue;
        }

        const user = await guildHolder.getBot().client.users.fetch(id).catch(() => null);
        if (user) {
            authors.push({
                type: AuthorType.DiscordExternal,
                id: id,
                username: user.username,
                iconURL: user.displayAvatarURL()
            });
        }
    }
    return authors;
}

export async function reclassifyAuthors<T extends (DiscordAuthor | Author)>(guildHolder: GuildHolder, list: T[]): Promise<T[]> {
    return Promise.all(list.map(async author => {
        const newAuthor: T = { ...author };
        if (author.type === AuthorType.Unknown) {
            // keep as is
            return newAuthor;
        }

        const member = await guildHolder.getGuild().members.fetch(author.id).catch(() => null);
        if (member) { // is a member of the guild
            newAuthor.type = AuthorType.DiscordInGuild;
            if (newAuthor.type === AuthorType.DiscordInGuild) { // to avoid casting
                newAuthor.displayName = member.displayName;
                newAuthor.username = member.user.username;
                newAuthor.iconURL = member.user.displayAvatarURL();
            }
        } else {
            const user = await guildHolder.getBot().client.users.fetch(author.id).catch(() => null);
            if (user && !user.username.startsWith("deleted_user_")) { // is a user but not a member of the guild
                if (newAuthor.type === AuthorType.DiscordInGuild) {
                    // just change type
                    newAuthor.type = AuthorType.DiscordLeftGuild;
                } else {
                    newAuthor.type = AuthorType.DiscordExternal;
                    if (newAuthor.type === AuthorType.DiscordExternal) { // to avoid casting
                        newAuthor.username = user.username;
                        newAuthor.iconURL = user.displayAvatarURL();
                    }
                }
            } else {
                newAuthor.type = AuthorType.DiscordDeleted;
            }
        }
        return newAuthor;
    }));
}

export function splitCode(code: string): { channelCode: string, entryNumber: number } {
    // code is in the format "[a-zA-Z]*[0-9]+"
    const match = code.match(/^([a-zA-Z]+)(\d+)$/);
    if (!match) {
        return { channelCode: '', entryNumber: -1 }
    }
    const channelCode = match[1];
    const entryNumber = parseInt(match[2]);
    if (isNaN(entryNumber)) {
        return { channelCode: '', entryNumber: -1 }
    }

    return { channelCode, entryNumber };
}

export function splitIntoChunks(text: string, max: number): string[] {
    if (max < 2) {
        throw new Error("`max` must be ≥ 2 so a hyphen can be added on hard splits.");
    }

    const chunks = [];
    let i = 0;

    while (i < text.length) {
        // Take at most `max` characters as a window to inspect
        const windowEnd = Math.min(i + max, text.length);
        const window = text.slice(i, windowEnd);

        if (windowEnd === text.length) {
            // If we reached the end of the text, take the rest
            chunks.push(window);
            break; // Exit the loop
        }

        // 1️⃣ Look for the right-most newline inside the window
        let breakPos = window.lastIndexOf("\n");

        // 2️⃣ If none, look for the right-most space
        if (breakPos === -1) breakPos = window.lastIndexOf(" ");

        // 3️⃣ If still none *and* we are not at the very end, force-split the word
        if (breakPos === -1 && windowEnd < text.length) {
            const hardSplitPos = max - 1;            // leave room for a hyphen
            chunks.push(window.slice(0, hardSplitPos) + "-");
            i += hardSplitPos;                        // advance by the piece we kept
            continue;                                // loop again, same index now points to remainder
        }

        // If there was no delimiter but we reached the true end, take the rest
        if (breakPos === -1) breakPos = window.length;

        chunks.push(window.slice(0, breakPos));
        i += breakPos;

        // Skip over the delimiter we split on (newline or space)
        if (text[i] === "\n" || text[i] === " ") i += 1;
    }

    return chunks;
}

export function extractUserIdsFromText(text: string): Snowflake[] {
    const userIds: Snowflake[] = [];
    const regex = /<@!?(\d{17,19})>/g; // Matches <@123456789012345678> or <@!123456789012345678>
    let match;
    while ((match = regex.exec(text)) !== null) {
        const userId = match[1]; // The first capturing group contains the user ID
        if (userId && !userIds.includes(userId)) {
            userIds.push(userId as Snowflake);
        }
    }
    return userIds;
}

export function escapeDiscordString(str: string): string {
    if (!str) return '';
    return str
        .replace(/\\/g, '\\\\') // Escape backslashes
        .replace(/`/g, '\\`')   // Escape backticks
        .replace(/_/g, '\\_')   // Escape underscores
        .replace(/\*/g, '\\*')   // Escape asterisks
        .replace(/~/g, '\\~')   // Escape tildes
        .replace(/>/g, '\\>')   // Escape greater than
        .replace(/</g, '\\<')   // Escape less than
        .replace(/!/g, '\\!');  // Escape exclamation marks
}

export function truncateFileName(fileName: string, maxLength: number): string {
    if (fileName.length <= maxLength) {
        return fileName;
    }
    const extension = Path.extname(fileName);
    const baseName = Path.basename(fileName, extension);
    const truncatedBaseName = baseName.slice(0, Math.max(0, maxLength - extension.length - 3)); // Leave space for "..."
    let newName = `${truncatedBaseName}...${extension}`;
    if (newName.length > maxLength) {
        // If the truncated name is still too long, truncate further
        newName = newName.slice(0, maxLength);
    }
    return newName;
}

export async function getAuthorFromIdentifier(guildHolder: GuildHolder, identifier: string): Promise<DiscordAuthor | null> {
    // check if identifier is a valid Discord ID
    const isId = /^\d{17,19}$/.test(identifier) || (identifier.startsWith('<@') && identifier.endsWith('>'));
    if (isId) {
        const userId = identifier.replace(/<@!?/, '').replace(/>/, '');
        const user = await guildHolder.getGuild().members.fetch(userId).catch(() => null);
        if (user) {
            return {
                type: AuthorType.DiscordInGuild,
                id: user.id,
                username: user.user.username,
                displayName: user.displayName,
                iconURL: user.user.displayAvatarURL(),
            }
        } else {
            // try to fetch the user from the client
            const user = await guildHolder.getBot().client.users.fetch(userId).catch(() => null);
            if (user) {
                return {
                    type: AuthorType.DiscordExternal,
                    id: user.id,
                    username: user.username,
                    iconURL: user.displayAvatarURL(),
                }
            }
        }
    }
    return null;
}

export function getAuthorKey(author: Author): string {
    if (author.type === AuthorType.Unknown) {
        return `unknown:${author.username}`;
    } else {
        return `discord:${author.id}`;
    }
}

export function areAuthorsSame(
    author1: Author | null,
    author2: Author | null,
): boolean {
    if (!author1 && !author2) return true; // Both are null
    if (!author1 || !author2) return false; // One is null, the other is not
    return getAuthorKey(author1) === getAuthorKey(author2);
}

export function areAuthorsSameStrict(
    author1: Author | null,
    author2: Author | null,
): boolean {
    if (!author1 && !author2) return true; // Both are null
    if (!author1 || !author2) return false; // One is null, the other is not

    const fullAccess1 = author1 as AllAuthorPropertiesAccessor;
    const fullAccess2 = author2 as AllAuthorPropertiesAccessor;

    return fullAccess1.type === fullAccess2.type &&
        fullAccess1.id === fullAccess2.id &&
        fullAccess1.username === fullAccess2.username &&
        fullAccess1.displayName === fullAccess2.displayName &&
        fullAccess1.iconURL === fullAccess2.iconURL;
}

export function areAuthorsListEqual(
    list1: Author[] | null,
    list2: Author[] | null,
    checkSharedFields: boolean = false,
    checkReason: boolean = false,
): boolean {
    if (!list1 && !list2) return true; // Both are null
    if (!list1 || !list2) return false; // One is null, the other is not

    if (list1.length !== list2.length) return false; // Different lengths

    const list2Map = new Map<string, Author>();
    for (const author of list2) {
        list2Map.set(getAuthorKey(author), author);
    }

    for (let i = 0; i < list1.length; i++) {
        const author1 = list1[i];
        const otherFound = list2Map.get(getAuthorKey(author1));
        if (!otherFound) {
            return false; // No matching author found
        }

        if (checkSharedFields) {
            if (!areAuthorsSameStrict(author1, otherFound)) {
                return false; // Shared fields are not the same
            }
        }

        if (checkReason) {
            if (author1.dontDisplay !== otherFound.dontDisplay || author1.reason !== otherFound.reason) {
                return false; // Unique fields are not the same
            }
        }
    }

    return true;
}

export function getMessageAuthor(message: Message): DiscordAuthor {
    if (message.member) {
        return {
            type: AuthorType.DiscordInGuild,
            id: message.author.id,
            username: message.author.username,
            displayName: message.member.displayName,
            iconURL: message.author.displayAvatarURL(),
        };
    } else {
        return {
            type: AuthorType.DiscordExternal,
            id: message.author.id,
            username: message.author.username,
            iconURL: message.author.displayAvatarURL(),
        };
    }
}

export function reorderToPreserveOldOrder<T>(oldList: T[], newList: T[]): T[] {
    const newListWithOrder = newList.map(item => ({ item, index: oldList.findIndex(oldItem => oldItem === item) }));
    newListWithOrder.sort((a, b) => {
        if (a.index === -1 && b.index === -1) {
            return 0; // Both are new, keep original order
        } else if (a.index === -1) {
            return 1; // a is new, put after b
        } else if (b.index === -1) {
            return -1; // b is new, put after a
        } else {
            return a.index - b.index; // Both exist, preserve original order
        }
    });
    return newListWithOrder.map(entry => entry.item);
}