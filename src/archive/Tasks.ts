import { Author, AuthorType, DiscordAuthor } from "../submissions/Author.js";
import { ArchiveEntry } from "./ArchiveEntry.js";
import { areAuthorsSameStrict, deepClone, getDiscordAuthorsFromIDs, splitIntoChunks } from "../utils/Util.js";
import { GuildHolder } from "../GuildHolder.js";
import { ArchiveChannelReference } from "./RepositoryConfigs.js";
import { ChannelType, ChatInputCommandInteraction, ForumChannel, GuildForumTag, GuildTextBasedChannel, Message, MessageFlags, Snowflake } from "discord.js";
import { ArchiveChannel, ArchiveEntryReference } from "./ArchiveChannel.js";
import { hasReferencesChanged, Reference, ReferenceType, tagReferences, tagReferencesInAcknowledgements, tagReferencesInSubmissionRecords } from "../utils/ReferenceUtils.js";
import { iterateAllMessages } from "../utils/AttachmentUtils.js";
import { safeJoinPath } from "../utils/SafePath.js";

export async function republishAllEntries(
    guildHolder: GuildHolder,
    doChannel: ForumChannel | null,
    replace: boolean, silent: boolean, reanalyze: boolean, reprocessImages: boolean,
    interaction: ChatInputCommandInteraction
): Promise<void> {
    const repositoryManager = guildHolder.getRepositoryManager();

    if (!repositoryManager.isReady()) {
        throw new Error("Git not initialized");
    }

    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildText) {
        throw new Error("Interaction channel is not a text channel");
    }

    await repositoryManager.getLock().acquire();
    try {
        const channelRefs = await repositoryManager.getChannelReferences();
        for (const channelRef of channelRefs) {
            const channelPath = safeJoinPath(repositoryManager.folderPath, channelRef.path);
            const archiveChannel = await ArchiveChannel.fromFolder(channelPath);
            if (doChannel && archiveChannel.getData().id !== doChannel.id) {
                continue;
            }
            for (const entryRef of archiveChannel.getData().entries) {
                const entryPath = safeJoinPath(channelPath, entryRef.path);
                const entry = await ArchiveEntry.fromFolder(entryPath);

                if (!entry) {
                    await channel.send({ content: `Entry ${entryRef.code} could not be loaded, skipping.` });
                    continue; // Skip if entry cannot be loaded
                }
                const entryData = entry.getData();

                const submission = await guildHolder.getSubmissionsManager().getSubmission(entryData.id);
                // Get channel
                const submissionChannel = submission ? await submission.getSubmissionChannel(true) : null;
                const wasArchived = submissionChannel && submissionChannel.archived;
                if (wasArchived) {
                    await submissionChannel.setArchived(false);
                }


                let result;
                if (!entryData.post) {
                    await channel.send({ content: `Entry ${entryData.code} does not have a post, skipping.` });
                } else {
                    try {
                        result = await repositoryManager.addOrUpdateEntryFromData(entryData, entryData.post.forumId, replace, reprocessImages, reanalyze, async () => { });
                        await channel.send({ content: `Entry ${entryData.code} republished: ${result.newEntryData.post?.threadURL}` });
                    } catch (e: any) {
                        console.error(e);
                        await channel.send({ content: `Error republishing entry ${entryData.code}: ${e.message}` });
                    }
                }

                // Get submission
                if (!submission || !submissionChannel) {
                    await channel.send({ content: `Submission for entry ${entryData.code} not found, skipping.` });
                    continue;
                }

                repositoryManager.updateSubmissionFromEntryData(submission, result?.newEntryData);

                try {
                    await submission.statusUpdated();
                    if (!silent) {
                        await submissionChannel.send(`Republished by bulk republish command, the post is now at ${result?.newEntryData?.post?.threadURL}`);
                    }
                } catch (e: any) {
                    await channel.send({ content: `Error updating submission ${entryData.code} status: ${e.message}` });
                }

                if (wasArchived) {
                    await submissionChannel.setArchived(true);
                }
            }
        }

        await repositoryManager.buildPersistentIndexAndEmbeddings();

        // Commit changes
        await repositoryManager.commit(`Republished all entries${doChannel ? ` in channel ${doChannel.name}` : ''}`);

        try {
            await repositoryManager.push();
        } catch (e: any) {
            console.error("Error pushing to remote:", e.message);
        }

        repositoryManager.getLock().release();
    } catch (e) {
        repositoryManager.getLock().release();
        throw e;
    }

}

export async function updateMetadataTask(guildHolder: GuildHolder): Promise<number> {
    const repositoryManager = guildHolder.getRepositoryManager();
    if (!repositoryManager.isReady()) {
        return 0;
    }

    await repositoryManager.getLock().acquire();

    let modifiedCount = 0;

    try {
        // First, collect authors & channels
        const authorIds: Set<Snowflake> = new Set();
        const channelIds: Set<Snowflake> = new Set();

        const collectFromRefs = (refs: Reference[]) => {
            refs.forEach(ref => {
                if (ref.type === ReferenceType.USER_MENTION) {
                    authorIds.add(ref.user.id);
                } else if (ref.type === ReferenceType.CHANNEL_MENTION) {
                    channelIds.add(ref.channelID);
                }
            });
        }

        await repositoryManager.iterateAllEntries(async (entry: ArchiveEntry) => {
            const entryData = entry.getData();
            for (const author of entryData.authors) {
                if (author.type !== AuthorType.Unknown) {
                    authorIds.add(author.id);
                }
            }
            for (const endorser of entryData.endorsers) {
                if (endorser.type !== AuthorType.Unknown) {
                    authorIds.add(endorser.id);
                }
            }

            collectFromRefs(entryData.references);
            collectFromRefs(entryData.author_references);
        });


        const dictionaryManager = guildHolder.getDictionaryManager();

        await dictionaryManager.iterateEntries(async (definition) => {
            collectFromRefs(definition.references);
        });

        const authorMap: Map<Snowflake, DiscordAuthor> = new Map();
        const chunkSize = 10;
        const authorIdsArray = Array.from(authorIds);
        for (let i = 0; i < authorIdsArray.length; i += chunkSize) {
            const chunk = authorIdsArray.slice(i, i + chunkSize);
            const fetchedAuthors = await getDiscordAuthorsFromIDs(guildHolder, chunk);

            fetchedAuthors.forEach(author => {
                authorMap.set(author.id, author);
            });
        }

        const channelMap: Map<Snowflake, {
            name: string;
            url: string;
        }> = new Map();
        for (const channelId of channelIds) {
            const channel = await guildHolder.getGuild().channels.fetch(channelId).catch(() => null);
            if (channel) {
                channelMap.set(channelId, {
                    name: channel.name,
                    url: channel.url,
                });
            }
        }

        const updateRefs = (refs: Reference[]): boolean => {
            let changed = false;
            refs.forEach(ref => {
                if (ref.type === ReferenceType.USER_MENTION) {
                    const updatedAuthor = authorMap.get(ref.user.id);
                    if (!updatedAuthor && ref.user.type !== AuthorType.DiscordDeleted) {
                        ref.user = {
                            type: AuthorType.DiscordDeleted,
                            id: ref.user.id,
                            username: ref.user.username,
                        };
                        changed = true;
                    } else if (updatedAuthor && !areAuthorsSameStrict(ref.user, updatedAuthor)) {
                        ref.user = deepClone(updatedAuthor);
                        changed = true;
                    }
                } else if (ref.type === ReferenceType.CHANNEL_MENTION) {
                    const updatedChannel = channelMap.get(ref.channelID);
                    if (updatedChannel && (ref.channelName !== updatedChannel.name || ref.channelURL !== updatedChannel.url)) {
                        ref.channelName = updatedChannel.name;
                        ref.channelURL = updatedChannel.url;
                        changed = true;
                    }
                }
            });
            return changed;
        }

        const getNewAuthors = (authors: Author[]): Author[] | null => {
            let changed = false;
            const newAuthors: Author[] = authors.map(author => {
                if (author.type === AuthorType.Unknown) {
                    return author;
                }

                const found = authorMap.get(author.id);
                if (author.type !== AuthorType.DiscordDeleted && !found) {
                    changed = true;
                    return {
                        ...author,
                        type: AuthorType.DiscordDeleted,
                    }
                } else if (found) {
                    if (!areAuthorsSameStrict(author, found)) {
                        changed = true;
                        const cloned = deepClone(found);
                        if (author.dontDisplay) {
                            cloned.dontDisplay = author.dontDisplay;
                        }
                        if (author.reason) {
                            cloned.reason = author.reason;
                        }
                        return cloned;
                    }
                }
                return author;
            });
            return changed ? newAuthors : null;
        }

        await repositoryManager.iterateAllEntries(async (entry: ArchiveEntry, _entryRef: ArchiveEntryReference, channelRef: ArchiveChannelReference) => {
            const data = entry.getData();
            const updatedReferences = updateRefs(data.references);
            const updatedAuthorReferences = updateRefs(data.author_references);
            const newAuthors = getNewAuthors(data.authors);
            const newEndorsers = getNewAuthors(data.endorsers);

            const changed = updatedReferences || updatedAuthorReferences || newAuthors !== null || newEndorsers !== null;
            if (!changed) {
                return;
            }

            // console.log(`For entry ${data.code}, updated, the changes are: references ${updatedReferences}, author references ${updatedAuthorReferences}, authors ${newAuthors ? 'yes' : 'no'}, endorsers ${newEndorsers ? 'yes' : 'no'}`);

            if (newAuthors) {
                data.authors = newAuthors;
            }
            if (newEndorsers) {
                data.endorsers = newEndorsers;
            }

            await repositoryManager.addOrUpdateEntryFromData(data, channelRef.id, false, false, false, async () => { }).catch((e) => {
                console.error(`Error updating references for entry ${data.name} in channel ${channelRef.name}:`, e.message);
            });

            modifiedCount++;
        });


        await dictionaryManager.iterateEntries(async (definition) => {
            const changed = updateRefs(definition.references);

            if (!changed) {
                return;
            }

            await dictionaryManager.saveEntry(definition).catch((e) => {
                console.error(`Error updating references for definition ${definition.terms[0]}:`, e.message);
            });
            await dictionaryManager.updateStatusMessage(definition).catch((e) => {
                console.error(`Error updating status message for definition ${definition.terms[0]}:`, e.message);
            });

            modifiedCount++;
        });

        if (modifiedCount > 0) {
            await repositoryManager.buildPersistentIndexAndEmbeddings();
            try {
                await repositoryManager.commit(`Updated metadata for ${modifiedCount} entries`);
                try {
                    await repositoryManager.push();
                } catch (e: any) {
                    console.error("Error pushing to remote:", e.message);
                }
            }
            catch (e: any) {
                console.error("Error committing updated authors:", e.message);
            }
        }
    } catch (e) {
        console.error("Error during metadata update:", e);
    }

    repositoryManager.getLock().release();
    return modifiedCount;
}

export async function retagEverythingTask(guildHolder: GuildHolder): Promise<void> {
    const repositoryManager = guildHolder.getRepositoryManager();
    if (!repositoryManager.isReady()) {
        return;
    }

    guildHolder.requestRetagging(false);

    await repositoryManager.getLock().acquire();

    try {
        const definitionToEntryCodes: Map<string, Set<string>> = new Map();

        let modifiedCount = 0;
        await repositoryManager.iterateAllEntries(async (entry: ArchiveEntry, _entryRef: ArchiveEntryReference, channelRef: ArchiveChannelReference) => {
            const data = entry.getData();
            const newReferences = await tagReferencesInSubmissionRecords(data.records, data.references, guildHolder, data.id);
            const newAuthorReferences = await tagReferencesInAcknowledgements(data.authors, data.author_references, guildHolder, data.id);

            newReferences.forEach((ref) => {
                if (ref.type !== ReferenceType.DICTIONARY_TERM) return;
                const defID = ref.id;
                if (!definitionToEntryCodes.has(defID)) {
                    definitionToEntryCodes.set(defID, new Set());
                }
                definitionToEntryCodes.get(defID)!.add(data.code);
            });

            const changed = hasReferencesChanged(data.references, newReferences).changed ||
                hasReferencesChanged(data.author_references, newAuthorReferences).changed;
            if (!changed) {
                return;
            }

            data.references = newReferences;


            data.author_references = newAuthorReferences;

            await repositoryManager.addOrUpdateEntryFromData(data, channelRef.id, false, false, false, async () => { }).catch((e) => {
                console.error(`Error updating references for entry ${data.name} in channel ${channelRef.name}:`, e.message);
            });
            modifiedCount++;
        }).catch((e) => {
            console.error("Error during retagging:", e);
        });

        // update definitions
        const dictionaryManager = guildHolder.getDictionaryManager();
        await dictionaryManager.iterateEntries(async (definition) => {
            const newReferences = await tagReferences(definition.definition, definition.references, guildHolder, definition.id);
            let changed = hasReferencesChanged(definition.references, newReferences).changed;
            const entryCodes = definitionToEntryCodes.get(definition.id);
            if (entryCodes && (entryCodes.size !== definition.referencedBy.length || entryCodes.intersection(new Set(definition.referencedBy)).size !== entryCodes.size)) {
                changed = true;
                definition.referencedBy = Array.from(entryCodes);
                definition.referencedBy.sort();
            } else if (!entryCodes && definition.referencedBy.length > 0) {
                changed = true;
                definition.referencedBy = [];
            }

            if (!changed) {
                return;
            }
            definition.references = newReferences;
            await dictionaryManager.saveEntry(definition).catch((e) => {
                console.error(`Error updating references for definition ${definition.terms[0]}:`, e.message);
            });
            await dictionaryManager.updateStatusMessage(definition).catch((e) => {
                console.error(`Error updating status message for definition ${definition.terms[0]}:`, e.message);
            });
            modifiedCount++;
        }).catch((e) => {
            console.error("Error during retagging definitions:", e);
        });

        if (modifiedCount > 0) {
            try {
                await repositoryManager.commit(`Retagged references for ${modifiedCount} items`);
                try {
                    await repositoryManager.push();
                } catch (e: any) {
                    console.error("Error pushing to remote:", e.message);
                }
            }
            catch (e: any) {
                console.error("Error committing retagged references:", e.message);
            }
        }
    } catch (e) {
        console.error("Error during retagging process:", e);
    }
    repositoryManager.getLock().release();
}

export async function importLRSChannelTask(
    guildHolder: GuildHolder,
    channel: GuildTextBasedChannel,
    setStatus: (status: string) => Promise<void>
) {
// get submission channel
    const submissionsChannelId = guildHolder.getSubmissionsChannelId();
    if (!submissionsChannelId) {
        throw new Error("Submissions channel not configured.");
    }

    const submissionsChannel = await guildHolder.getGuild().channels.fetch(submissionsChannelId).catch(() => null);
    if (!submissionsChannel || submissionsChannel.type !== ChannelType.GuildForum) {
        throw new Error("Submissions channel is not a forum channel.");
    }

    // make sure submissions channel has an import tag
    const importTag: GuildForumTag = {
        name: 'LRS Import',
        moderated: true,
        emoji: { name: '📥' }
    } as GuildForumTag;

    let existingImportTag = submissionsChannel.availableTags.find(tag => tag.name === importTag.name);
    if (!existingImportTag) {
        const newTags = submissionsChannel.availableTags.slice();
        newTags.push(importTag);
        await submissionsChannel.setAvailableTags(newTags);

        await submissionsChannel.fetch();
    }

    const importTagId = submissionsChannel.availableTags.find(tag => tag.name === importTag.name)?.id;
    if (!importTagId) {
        throw new Error("Failed to create or find import tag in submissions channel.");
    }

   
    let importedCount = 0;

    const webhook = await submissionsChannel.createWebhook({
        name: 'Llamabot Importer',
        reason: 'Importing LRS submissions',
    })


    // get all messages
    const messages: Message[] = [];
    const seenSet = new Set<Snowflake>();
    await iterateAllMessages(channel, async (message: Message) => {
        if (seenSet.has(message.id)) {
            return true;
        }
        seenSet.add(message.id);

        messages.push(message);
        return true;
    });

    // sort messages by oldest first
    messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    console.log(`Fetched ${messages.length} messages from channel ${channel.name}, starting import...`);

    // group messages by whether they have Title:
    const titleGroups: { title: string; messages: Message[] }[] = [];
    let currentGroup: { title: string; messages: Message[] } | null = null;
    for (const message of messages) {
        const titleMatch = message.content.match(/^Title:\s*(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : null;
        if (title) {
            currentGroup = { title, messages: [message] };
            titleGroups.push(currentGroup);
        } else if (currentGroup) {
            currentGroup.messages.push(message);
        }
    }

    for (const group of titleGroups) {
        await setStatus(`Importing submission ${group.title}...`);
        try {
            // fetch all attachments in the group
            const attachments = group.messages.flatMap(m => Array.from(m.attachments.values()));
          
            const content = group.messages.map(m => m.content).join('\n');
            const splitContent = splitIntoChunks(content, 2000);

            const newThreadMessage = await webhook.send({
                threadName: group.title,
                appliedTags: [importTagId],
                content: splitContent[0] || "(no content)",
                files: attachments,
                flags: [MessageFlags.SuppressNotifications],
                allowedMentions: { parse: [] },
                username: group.messages[0].author.username,
                avatarURL: group.messages[0].author.displayAvatarURL(),
            });

            const thread = await submissionsChannel.threads.fetch(newThreadMessage.id).catch(() => null);
            if (!thread) {
                console.error(`Failed to create thread for ${group.title}, skipping.`);
                continue;
            }

            // send remaining content if any
            for (let i = 1; i < splitContent.length; i++) {
                await webhook.send({
                    threadId: thread.id,
                    content: splitContent[i] || "(no content)",
                    flags: [MessageFlags.SuppressNotifications],
                    allowedMentions: { parse: [] },
                    username: group.messages[0].author.username,
                    avatarURL: group.messages[0].author.displayAvatarURL(),
                });
            }

            importedCount++;

        } catch (e: any) {
            console.error(`Error importing submission ${group.title}:`, e);
        }
    }
    await webhook.delete('Import complete');
}


export async function importACAChannelTask(
    guildHolder: GuildHolder,
    channel: ForumChannel,
    setStatus: (status: string) => Promise<void>
) {
    // get submission channel
    const submissionsChannelId = guildHolder.getSubmissionsChannelId();
    if (!submissionsChannelId) {
        throw new Error("Submissions channel not configured.");
    }

    const submissionsChannel = await guildHolder.getGuild().channels.fetch(submissionsChannelId).catch(() => null);
    if (!submissionsChannel || submissionsChannel.type !== ChannelType.GuildForum) {
        throw new Error("Submissions channel is not a forum channel.");
    }

    // make sure submissions channel has an import tag
    const importTag: GuildForumTag = {
        name: 'ACA Import',
        moderated: true,
        emoji: { name: '📥' }
    } as GuildForumTag;

    let existingImportTag = submissionsChannel.availableTags.find(tag => tag.name === importTag.name);
    if (!existingImportTag) {
        const newTags = submissionsChannel.availableTags.slice();
        newTags.push(importTag);
        await submissionsChannel.setAvailableTags(newTags);

        await submissionsChannel.fetch();
    }

    const importTagId = submissionsChannel.availableTags.find(tag => tag.name === importTag.name)?.id;
    if (!importTagId) {
        throw new Error("Failed to create or find import tag in submissions channel.");
    }

    // get threads
    const threadsActive = await channel.threads.fetchActive();
    const threadsArchived = await channel.threads.fetchArchived();
    const threads = [...threadsActive.threads, ...threadsArchived.threads];

    let importedCount = 0;

    const webhook = await submissionsChannel.createWebhook({
        name: 'Llamabot Importer',
        reason: 'Importing ACA submissions',
    })



    for (const [_, thread] of threads) {
        await thread.fetch();

        // sure thread isn't authored by the bot
        if (thread.ownerId === guildHolder.getBot().client.user?.id) {
            continue;
        }

        await setStatus(`Importing thread ${thread.name}...`);
        try {

            // fetch starter message
            const starterMessage = await thread.fetchStarterMessage();
            if (!starterMessage) {
                console.error(`Thread ${thread.name} has no starter message, skipping.`);
                continue;
            }



            const threadName = thread.name;
            const threadStarterAttachments = starterMessage.attachments;

            const contentSplit = splitIntoChunks(starterMessage.content, 2000);

            const newThreadMessage = await webhook.send({
                threadName: threadName,
                appliedTags: [importTagId],
                content: contentSplit[0],
                files: Array.from(threadStarterAttachments.values()),
                flags: [MessageFlags.SuppressNotifications],
                allowedMentions: { parse: [] },
                username: starterMessage.author.username,
                avatarURL: starterMessage.author.displayAvatarURL(),
            });

            // try to find thead with same name and message id
            const activeThreads = (await submissionsChannel.threads.fetchActive()).threads;
            // first try to find by message id
            const withSameName = activeThreads.filter(t => t.name === threadName);
            let newThread;
            if (withSameName.size === 1) {
                newThread = withSameName.first();
            } else {
                for (const [_, t] of withSameName) {
                    const tStarter = await t.fetchStarterMessage();
                    if (tStarter && tStarter.id === newThreadMessage.id) {
                        newThread = t;
                        break;
                    }
                }
            }

            if (!newThreadMessage || !newThread) {
                console.error(`Failed to create new thread for ${thread.name}, skipping.`);
                continue;
            }

            // send remaining content if any
            for (let i = 1; i < contentSplit.length; i++) {
                await webhook.send({
                    threadId: newThread.id,
                    content: contentSplit[i],
                    flags: [MessageFlags.SuppressNotifications],
                    allowedMentions: { parse: [] },
                    username: starterMessage.author.username,
                    avatarURL: starterMessage.author.displayAvatarURL(),
                });
            }

            // collect messages
            const messages: Message[] = [];
            await iterateAllMessages(thread, async (message: Message) => {
                if (message.id === starterMessage.id) {
                    return true; // skip starter message
                }

                messages.push(message);
                return true;
            });

            // sort messages by oldest first
            messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);

            for (const message of messages) {
                await message.fetch();

                const messageAttachments = message.attachments;
                const messageContentSplit = splitIntoChunks(message.content, 2000);

                // send first part with attachments
                await webhook.send({
                    threadId: newThread.id,
                    content: messageContentSplit[0] || "(no content)",
                    files: Array.from(messageAttachments.values()),
                    flags: [MessageFlags.SuppressNotifications],
                    allowedMentions: { parse: [] },
                    username: message.author.username,
                    avatarURL: message.author.displayAvatarURL(),
                });

                // send remaining parts
                for (let i = 1; i < messageContentSplit.length; i++) {
                    await webhook.send({
                        threadId: newThread.id,
                        content: messageContentSplit[i],
                        flags: [MessageFlags.SuppressNotifications],
                        allowedMentions: { parse: [] },
                        username: message.author.username,
                        avatarURL: message.author.displayAvatarURL(),
                    });
                }
            }

            importedCount++;
        } catch (e: any) {
            console.error(`Error importing thread ${thread.name}:`, e);
        }
    }

    await webhook.delete('Import complete');
}

export async function deleteACAImportThreadsTask(
    guildHolder: GuildHolder,
    _interaction: ChatInputCommandInteraction
): Promise<number> {
    const submissionsChannelId = guildHolder.getSubmissionsChannelId();
    if (!submissionsChannelId) {
        throw new Error("Submissions channel not configured.");
    }

    const submissionsChannel = await guildHolder.getGuild().channels.fetch(submissionsChannelId).catch(() => null);
    if (!submissionsChannel || submissionsChannel.type !== ChannelType.GuildForum) {
        throw new Error("Submissions channel is not a forum channel.");
    }

    const importTag = submissionsChannel.availableTags.find(tag => tag.name === 'ACA Import' || tag.name === 'LRS Import');
    if (!importTag) {
        throw new Error("Import tag not found in submissions channel.");
    }

    let deletedCount = 0;

    const threadsActive = await submissionsChannel.threads.fetchActive();
    const threadsArchived = await submissionsChannel.threads.fetchArchived();
    const threads = [...threadsActive.threads, ...threadsArchived.threads];

    for (const [_, thread] of threads) {
        await thread.fetch();

        if (thread.appliedTags.includes(importTag.id)) {
            await thread.delete('Deleting ACA import thread');
            deletedCount++;
        }
    }

    return deletedCount;
}
