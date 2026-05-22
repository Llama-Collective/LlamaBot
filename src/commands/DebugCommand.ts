import { AttachmentBuilder, ChatInputCommandInteraction, ChannelType, Collection, ForumChannel, GuildForumTag, GuildMember, InteractionContextType, MessageFlags, SlashCommandBuilder, Snowflake, PermissionFlagsBits } from "discord.js";
import { GuildHolder } from "../GuildHolder.js";
import { Command } from "../interface/Command.js";
import { SysAdmin } from "../Bot.js";
import { getAuthorKey, getAuthorName, replyEphemeral, splitIntoChunks, truncateStringWithEllipsis } from "../utils/Util.js";
import { deleteACAImportThreadsTask, importACAChannelTask, importLRSChannelTask } from "../archive/Tasks.js";
import { SetTemplateModal } from "../components/modals/SetTemplateModal.js";
import { Reference, tagReferencesInSubmissionRecords } from "../utils/ReferenceUtils.js";
import { RevisionEmbed } from "../embed/RevisionEmbed.js";
import { AuthorType, DiscordAuthor } from "../submissions/Author.js";
import { findWorldsInZip, optimizeWorldsInZip } from "../utils/WDLUtils.js";
import { getFileKey, optimizeImage } from "../utils/AttachmentUtils.js";
import { GuildConfigs } from "../config/GuildConfigs.js";
import { DictionaryEntryStatus } from "../archive/DictionaryManager.js";
import got from "got";
import Path from "path";
import fs from "fs/promises";
import { SubmissionConfigs } from "../submissions/SubmissionConfigs.js";
import { createHash } from "crypto";
import { safeJoinPath } from "../utils/SafePath.js";
import { SubmissionStatus } from "../submissions/SubmissionStatus.js";

export class DebugCommand implements Command {
    getID(): string {
        return "debug";
    }

    getBuilder(_guildHolder: GuildHolder): SlashCommandBuilder {
        const data = new SlashCommandBuilder()
            .setName(this.getID())
            .setDescription('Debug utilities (SysAdmin only)')
            .setContexts(InteractionContextType.Guild)
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
        data
            .addSubcommand(sub =>
                sub
                    .setName('importaca')
                    .setDescription('Import an ACA forum channel into submissions')
                    .addChannelOption(opt =>
                        opt
                            .setName('channel')
                            .setDescription('ACA forum channel to import from')
                            .setRequired(true)
                            .addChannelTypes(ChannelType.GuildForum)
                    )
            )
            .addSubcommand(sub =>
                sub
                    .setName('importlrs')
                    .setDescription('Import an LRS forum channel into submissions')
                    .addChannelOption(opt =>
                        opt
                            .setName('channel')
                            .setDescription('LRS forum channel to import from')
                            .setRequired(true)
                            .addChannelTypes(ChannelType.GuildText)
                    )
            )
            .addSubcommand(sub =>
                sub
                    .setName('deleteaca')
                    .setDescription('Delete all ACA import threads from the submissions forum')
            )
            .addSubcommand(sub =>
                sub
                    .setName('settemplate')
                    .setDescription('Open the post template modal')
            )
            .addSubcommand(sub =>
                sub
                    .setName('importdictionary')
                    .setDescription('Import dictionary entries from a JSON attachment')
                    .addAttachmentOption(option =>
                        option
                            .setName('file')
                            .setDescription('JSON file to import')
                            .setRequired(true)
                    )
            )
            .addSubcommand(sub =>
                sub
                    .setName('updatesubmissionsstatus')
                    .setDescription('Update the status of all submissions based on their archive status')
            )
            // .addSubcommand(sub =>
            //     sub
            //         .setName('attachhashes')
            //         .setDescription('Compute attachment hashes for archived posts and submissions')
            // )
            .addSubcommand(sub =>
                sub.setName('fixattachments')
                    .setDescription('Fix missing attachments in archived posts and submissions by re-downloading them from Discord')
            )
            .addSubcommand(sub =>
                sub
                    .setName('backfillthumbnails')
                    .setDescription('Populate thumbnailURL from archived post starter messages')
            )
            .addSubcommand(sub =>
                sub
                    .setName('reextract')
                    .setDescription('Force re-run LLM extraction for this submission thread')
            )
            .addSubcommand(sub =>
                sub
                    .setName('updaterevisions')
                    .setDescription('Retag references and refresh revision embeds for all submissions')
            )
            .addSubcommand(sub =>
                sub
                    .setName('addthanks')
                    .setDescription('Add thank-you points to a user')
                    .addUserOption(opt =>
                        opt
                            .setName('user')
                            .setDescription('User to receive the points')
                            .setRequired(true)
                    )
                    .addIntegerOption(opt =>
                        opt
                            .setName('amount')
                            .setDescription('Number of points to add')
                            .setMinValue(1)
                    )
                    .addBooleanOption(opt =>
                        opt
                            .setName('add_to_buffer')
                            .setDescription('Also add entries to the 30-day buffer (default: yes)')
                    )
            )
            .addSubcommand(sub =>
                sub
                    .setName('removethanks')
                    .setDescription('Remove thank-you points from a user')
                    .addUserOption(opt =>
                        opt
                            .setName('user')
                            .setDescription('User to remove points from')
                            .setRequired(true)
                    )
                    .addIntegerOption(opt =>
                        opt
                            .setName('amount')
                            .setDescription('Number of points to remove')
                            .setMinValue(1)
                    )
                    .addBooleanOption(opt =>
                        opt
                            .setName('trim_buffer')
                            .setDescription('Also remove entries from the 30-day buffer (default: yes)')
                    )
            )
            .addSubcommand(sub =>
                sub
                    .setName('memberstats')
                    .setDescription('Export member usernames, roles, and join dates as JSON')
            )
            .addSubcommand(sub =>
                sub
                    .setName('listauthors')
                    .setDescription('List archived post authors who are not in the guild')
            )
            .addSubcommand(sub =>
                sub
                    .setName('optimizewdl')
                    .setDescription('Optimize a WDL zip using MCSelector and return the optimized zip')
                    .addAttachmentOption(opt =>
                        opt
                            .setName('zip')
                            .setDescription('Zip containing one or more world downloads')
                            .setRequired(true)
                    )
            )
            .addSubcommand(sub =>
                sub
                    .setName('analyzewdl')
                    .setDescription('Analyze a WDL zip and report world metadata (no writes)')
                    .addAttachmentOption(opt =>
                        opt
                            .setName('zip')
                            .setDescription('Zip containing one or more world downloads')
                            .setRequired(true)
                    )
            )
            .addSubcommand(sub =>
                sub
                    .setName('optimizeimage')
                    .setDescription('Optimize an image attachment and return the processed PNG')
                    .addAttachmentOption(opt =>
                        opt
                            .setName('image')
                            .setDescription('Image attachment to optimize')
                            .setRequired(true)
                    )
            )
            .addSubcommand(sub =>
                sub
                    .setName('getqueries')
                    .setDescription('Show the last conversational LLM tool calls')
            )

        return data;
    }

    async execute(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction): Promise<void> {
        if (interaction.user.id !== SysAdmin) {
            await replyEphemeral(interaction, 'You are not authorized to use this command.');
            return;
        }

        if (!interaction.inGuild()) {
            await replyEphemeral(interaction, 'This command can only be used in a guild.');
            return;
        }

        const sub = interaction.options.getSubcommand();
        switch (sub) {
            case 'importaca':
                await this.handleImportACA(guildHolder, interaction);
                break;
            case 'importlrs':
                await this.handleImportLRS(guildHolder, interaction);
                break;
            case 'deleteaca':
                await this.handleDeleteACA(guildHolder, interaction);
                break;
            case 'settemplate':
                await this.handleSetTemplate(guildHolder, interaction);
                break;
            case 'importdictionary':
                await this.handleImportDictionary(guildHolder, interaction);
                break;
            case 'updatesubmissionsstatus':
                await this.handleUpdateSubmissionsStatus(guildHolder, interaction);
                break;
            case 'attachhashes':
                await this.handleAttachHashes(guildHolder, interaction);
                break;
            case 'fixattachments':
                await this.handleAttachmentFix(guildHolder, interaction);
                break;
            case 'backfillthumbnails':
                await this.handleBackfillThumbnails(guildHolder, interaction);
                break;
            case 'reextract':
                await this.handleReextract(guildHolder, interaction);
                break;
            case 'updaterevisions':
                await this.handleUpdateRevisions(guildHolder, interaction);
                break;
            case 'addthanks':
                await this.handleAddThanks(guildHolder, interaction);
                break;
            case 'removethanks':
                await this.handleRemoveThanks(guildHolder, interaction);
                break;
            case 'memberstats':
                await this.handleMemberStats(guildHolder, interaction);
                break;
            case 'listauthors':
                await this.handleListAuthors(guildHolder, interaction);
                break;
            case 'optimizewdl':
                await this.handleOptimizeWdl(guildHolder, interaction);
                break;
            case 'analyzewdl':
                await this.handleAnalyzeWdl(guildHolder, interaction);
                break;
            case 'optimizeimage':
                await this.handleOptimizeImage(interaction);
                break;
            case 'getqueries':
                await this.handleGetQueries(guildHolder, interaction);
                break;
            case 'restoretags':
                await this.handleRestoreTags(guildHolder, interaction);
                break;
            case 'deletetag':
                await this.handleDeleteTag(guildHolder, interaction);
                break;
            default:
                await replyEphemeral(interaction, 'Unknown subcommand.');
        }
    }

    private async handleGetQueries(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const toolUsages = guildHolder.getLastToolUsages();
        if (!toolUsages || toolUsages.length === 0) {
            await replyEphemeral(interaction, 'No tool calls recorded for the last conversational response.');
            return;
        }

        const lines = toolUsages.map((usage, index) => {
            const query = usage.query.trim() || '(no query)';
            return `${index + 1}. ${usage.toolName}: ${truncateStringWithEllipsis(query, 1500)}`;
        });

        const chunks = splitIntoChunks(lines.join('\n'), 1900);
        await interaction.reply({ content: chunks[0], allowedMentions: { parse: [] } });
        for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({
                content: chunks[i],
                allowedMentions: { parse: [] },
            });
        }
    }

    private async handleImportACA(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const channel = interaction.options.getChannel('channel', true);
        if (channel.type !== ChannelType.GuildForum) {
            await replyEphemeral(interaction, 'Please select a forum channel to import from.');
            return;
        }


        const feedback = interaction.channel;
        if (!feedback || !feedback.isSendable()) {
            await replyEphemeral(interaction, 'Cannot send feedback messages in this channel.');
            return;
        }


        await interaction.reply({ content: `Starting ACA import for <#${channel.id}>...` });


        const setStatus = async (status: string) => {
            await feedback.send(status);
        };

        try {
            await importACAChannelTask(guildHolder, channel as ForumChannel, setStatus);
            await setStatus('ACA import complete.');
        } catch (error: any) {
            await interaction.editReply({ content: `Import failed: ${error?.message || 'Unknown error'}` });
        }
    }



    private async handleImportLRS(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const channel = interaction.options.getChannel('channel', true);
        if (channel.type !== ChannelType.GuildText) {
            await replyEphemeral(interaction, 'Please select a text channel to import from.');
            return;
        }

        const channelFetched = await guildHolder.getGuild().channels.fetch(channel.id).catch(() => null);
        if (!channelFetched || channelFetched.type !== ChannelType.GuildText) {
            await replyEphemeral(interaction, 'Failed to fetch the specified channel. Please try again.');
            return;
        }


        const feedback = interaction.channel;
        if (!feedback || !feedback.isSendable()) {
            await replyEphemeral(interaction, 'Cannot send feedback messages in this channel.');
            return;
        }


        await interaction.reply({ content: `Starting LRS import for <#${channel.id}>...` });


        const setStatus = async (status: string) => {
            await feedback.send(status);
        };

        try {
            await importLRSChannelTask(guildHolder, channelFetched, setStatus);
            await setStatus('LRS import complete.');
        } catch (error: any) {
            await interaction.editReply({ content: `Import failed: ${error?.message || 'Unknown error'}` });
        }
    }

    private async handleDeleteACA(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        try {
            const deleted = await deleteACAImportThreadsTask(guildHolder, interaction);
            await interaction.editReply({ content: `Deleted ${deleted} ACA import thread${deleted === 1 ? '' : 's'}.` });
        } catch (error: any) {
            await interaction.editReply({ content: `Delete failed: ${error?.message || 'Unknown error'}` });
        }
    }

    private async handleSetTemplate(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const modal = new SetTemplateModal().getBuilder(guildHolder);
        await interaction.showModal(modal);
    }

    private async handleImportDictionary(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const attachment = interaction.options.getAttachment('file');
        if (!attachment) {
            await replyEphemeral(interaction, 'Attach a JSON file to import.');
            return;
        }

        const dictionaryChannelId = guildHolder.getConfigManager().getConfig(GuildConfigs.DICTIONARY_CHANNEL_ID);
        if (!dictionaryChannelId) {
            await replyEphemeral(interaction, 'Dictionary channel is not configured.');
            return;
        }

        const dictionaryChannel = await guildHolder.getGuild().channels.fetch(dictionaryChannelId).catch(() => null);
        if (!dictionaryChannel || dictionaryChannel.type !== ChannelType.GuildForum) {
            await replyEphemeral(interaction, 'Dictionary channel is not a forum.');
            return;
        }

        const dictionaryStatusTags: GuildForumTag[] = [
            { name: 'Pending', emoji: { name: '🕒' }, moderated: true },
            { name: 'Approved', emoji: { name: '✅' }, moderated: true },
            { name: 'Rejected', emoji: { name: '🚫' }, moderated: true },
        ] as GuildForumTag[];

        const existingDictionaryTags = dictionaryChannel.availableTags.filter(tag => {
            return !dictionaryStatusTags.some(t => t.name === tag.name);
        });

        const mergedDictionaryTags = dictionaryStatusTags.map(t => {
            const existing = dictionaryChannel.availableTags.find(tag => tag.name === t.name);
            return existing || t;
        }).concat(existingDictionaryTags);

        await dictionaryChannel.setAvailableTags(mergedDictionaryTags).catch(() => { });

        await interaction.deferReply();

        let payload: any;
        try {
            const response = await got(attachment.url, { responseType: 'text' });
            payload = JSON.parse(response.body);
        } catch (e: any) {
            await interaction.editReply(`Failed to load or parse the JSON file: ${e.message || e}`);
            return;
        }

        if (!Array.isArray(payload)) {
            await interaction.editReply('Invalid JSON format. Expected an array of entries.');
            return;
        }

        const dictionaryManager = guildHolder.getDictionaryManager();
        const normalizeTerm = (term: string) => term.trim().toLowerCase();

        const existingEntries = await dictionaryManager.listEntries();
        const existingTerms = new Map<string, Snowflake>();
        for (const entry of existingEntries) {
            for (const term of entry.terms || []) {
                const normalized = normalizeTerm(term);
                if (normalized) {
                    existingTerms.set(normalized, entry.id);
                }
            }
        }

        const repositoryManager = guildHolder.getRepositoryManager();
        await repositoryManager.getLock().acquire();

        const results: string[] = [];
        let created = 0;
        let skipped = 0;

        try {
            for (let i = 0; i < payload.length; i++) {
                const rawEntry = payload[i];
                if (!rawEntry || typeof rawEntry !== 'object') {
                    results.push(`Entry #${i + 1}: skipped (not an object).`);
                    skipped++;
                    continue;
                }

                const termSource = Array.isArray(rawEntry.terms) ? rawEntry.terms : [];
                if (typeof rawEntry.term === 'string') {
                    termSource.push(rawEntry.term);
                }
                if (typeof rawEntry.id === 'string' && termSource.length === 0) {
                    termSource.push(rawEntry.id);
                }

                const terms = termSource.map((t: any) => String(t).trim()).filter(Boolean);
                if (terms.length === 0) {
                    results.push(`Entry #${i + 1}: skipped (no terms).`);
                    skipped++;
                    continue;
                }

                const normalizedTerms = terms.map(normalizeTerm).filter(Boolean) as string[];
                const duplicateTerm = normalizedTerms.find(t => existingTerms.has(t));
                if (duplicateTerm) {
                    results.push(`Entry "${terms[0]}": skipped (term already exists).`);
                    skipped++;
                    continue;
                }

                const definition = (rawEntry.definition ?? '').toString().trim();
                if (!definition) {
                    results.push(`Entry "${terms[0]}": skipped (no definition).`);
                    skipped++;
                    continue;
                }

                const threadName = truncateStringWithEllipsis(terms.join(', '), 100);

                try {
                    const thread = await dictionaryChannel.threads.create({
                        name: threadName,
                        message: {
                            content: definition,
                            allowedMentions: { parse: [] },
                        },
                    }).catch(() => null);

                    if (!thread) {
                        results.push(`Entry "${terms[0]}": failed to create a thread.`);
                        skipped++;
                        continue;
                    }

                    const entry = await dictionaryManager.ensureEntryForThread(thread).catch(() => null);
                    if (!entry) {
                        results.push(`Entry "${terms[0]}": failed to record dictionary entry.`);
                        skipped++;
                        continue;
                    }

                    entry.terms = terms;
                    entry.definition = definition;
                    entry.status = DictionaryEntryStatus.APPROVED;
                    entry.updatedAt = Date.now();
                    entry.references = [];

                    await dictionaryManager.saveEntry(entry);
                    await dictionaryManager.updateStatusMessage(entry, thread);

                    for (const term of normalizedTerms) {
                        existingTerms.set(term, entry.id);
                    }

                    created++;
                    results.push(`Entry "${terms[0]}": created at ${thread.url}`);
                } catch (e: any) {
                    results.push(`Entry "${terms[0]}": failed (${e.message || e}).`);
                    skipped++;
                }
            }

            if (created > 0) {
                let commitError: string | null = null;
                await repositoryManager.commit(`Imported ${created} dictionary ${created === 1 ? 'entry' : 'entries'}`).catch((e: any) => {
                    commitError = e.message || String(e);
                });
                if (commitError) {
                    results.push(`Warning: changes were staged but commit failed: ${commitError}`);
                } else {
                    await repositoryManager.push().catch((e: any) => {
                        results.push(`Warning: commit succeeded but push failed: ${e.message || e}`);
                    });
                }
            }
        } finally {
            repositoryManager.getLock().release();
        }

        if (results.length === 0) {
            results.push('No entries were imported.');
        } else {
            results.unshift(`Import complete: created ${created}, skipped ${skipped}.`);
        }

        const chunks = splitIntoChunks(results.join('\\n'), 2000);
        if (chunks.length === 0) {
            await interaction.editReply('Import complete.');
            return;
        }

        await interaction.editReply({ content: chunks[0] });
        for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp({ content: chunks[i], flags: MessageFlags.SuppressNotifications });
        }
    }

    private async handleReextract(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const channel = interaction.channel;
        if (!channel || !channel.isThread()) {
            await replyEphemeral(interaction, 'Run this inside a submission thread.');
            return;
        }

        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const submission = await guildHolder.getSubmissionsManager().getSubmission(channel.id);
        if (!submission) {
            await interaction.editReply({ content: 'Submission not found for that thread.' });
            return;
        }

        try {
            const response = await submission.forceLLMExtraction();
            await submission.createRevisionFromExtraction(response, true);
            await interaction.editReply({ content: `Re-extraction complete. New revision created.` });
        } catch (error: any) {
            await interaction.editReply({ content: `Re-extraction failed: ${error?.message || 'Unknown error'}` });
        }
    }

    private async handleUpdateRevisions(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const submissionIds = await guildHolder.getSubmissionsManager().getSubmissionsList();
        let submissionsTouched = 0;
        let revisionsUpdated = 0;
        let errors = 0;

        for (const submissionId of submissionIds) {
            const submission = await guildHolder.getSubmissionsManager().getSubmission(submissionId);
            if (!submission) {
                errors++;
                continue;
            }

            const revisionRefs = submission.getRevisionsManager().getRevisionsList();
            if (revisionRefs.length === 0) {
                continue;
            }

            const channel = await submission.getSubmissionChannel(true);
            if (!channel) {
                errors++;
                continue;
            }

            const shouldRearchive = channel.isThread() && channel.archived;
            if (shouldRearchive) {
                await channel.setArchived(false).catch(() => null);
            }

            const retaggedRefs = new Map<string, Reference[]>();
            const revisions = await Promise.all(revisionRefs.map(async ref => {
                const revision = await submission.getRevisionsManager().getRevisionById(ref.id);
                return { ref, revision };
            }));

            revisions.sort((a, b) => {
                const aTime = a.revision?.timestamp || 0;
                const bTime = b.revision?.timestamp || 0;
                return aTime - bTime;
            });

            for (const { ref, revision } of revisions) {
                if (!revision) {
                    errors++;
                    continue;
                }

                if (ref.isCurrent) {

                    const parentRefs = revision.parentRevision
                        ? (retaggedRefs.get(revision.parentRevision) || (await submission.getRevisionsManager().getRevisionById(revision.parentRevision))?.references || [])
                        : [];

                    let newReferences = revision.references || [];
                    try {
                        const previousRefs = [...parentRefs, ...newReferences];
                        newReferences = await tagReferencesInSubmissionRecords(revision.records, previousRefs, guildHolder, submission.getId());
                    } catch (e: any) {
                        console.error(`Failed to retag references for revision ${revision.id}:`, e);
                        errors++;
                        continue;
                    }

                    revision.references = newReferences;
                    retaggedRefs.set(revision.id, newReferences);
                }

                await submission.getRevisionsManager().updateRevision(revision);

                const messages = await Promise.all(revision.messageIds.map(async (messageId) => {
                    return await channel.messages.fetch(messageId);
                })).catch(() => null);
                if (!messages) {
                    errors++;
                    continue;
                }

                try {
                    await RevisionEmbed.editRevisionMessages(messages, submission, revision, ref.isCurrent);
                    revisionsUpdated++;
                } catch (e: any) {
                    console.error(`Failed to update revision messages for ${revision.id}:`, e);
                    errors++;
                }
            }

            submissionsTouched++;

            if (shouldRearchive) {
                await channel.setArchived(true).catch(() => null);
            }
        }

        const errorText = errors > 0 ? ` with ${errors} error${errors === 1 ? '' : 's'} (see logs)` : '';
        await interaction.editReply({ content: `Updated ${revisionsUpdated} revision${revisionsUpdated === 1 ? '' : 's'} across ${submissionsTouched} submission${submissionsTouched === 1 ? '' : 's'}${errorText}.` });
    }

    private async handleUpdateSubmissionsStatus(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        await interaction.reply('Starting to update status of all submissions. This may take a while depending on the number of submissions. You will be notified when it is complete.');

        const submissionsById = await guildHolder.getSubmissionsManager().getSubmissionsList();
        for (const submissionID of submissionsById) {
            const submission = await guildHolder.getSubmissionsManager().getSubmission(submissionID);
            if (!submission) {
                await interaction.followUp(`Submission with ID ${submissionID} not found, skipping.`);
                continue;
            }

            const channel = await submission.getSubmissionChannel(true);
            if (!channel) {
                console.error(`Submission channel for submission ${submissionID} not found.`);
                await interaction.followUp(`Submission channel for submission ${submissionID} not found, skipping.`);
                continue;
            }
            const isArchived = channel.archived;

            const entry = await guildHolder.getRepositoryManager().findEntryBySubmissionId(submissionID);
            if (entry) {
                guildHolder.getRepositoryManager().updateSubmissionFromEntryData(submission, entry.entry.getData());

                const tags = entry.entry.getData().tags || [];
                submission.getConfigManager().setConfig(SubmissionConfigs.TAGS, tags);
            }

            // update submission images
            // check if there are images
            if (submission.getConfigManager().getConfig(SubmissionConfigs.IMAGES)?.length) {
                await submission.processImages().catch((error) => {
                    console.error(`Error processing images for submission ${submissionID}:`, error);
                });
            }

            await submission.save();

            try {
                await submission.statusUpdated();
            } catch (error) {
                console.error(`Error updating status for submission ${submissionID}:`, error);
                await interaction.followUp(`Error updating status for submission ${submissionID}, check console for details.`);
            }

            if (isArchived) {
                await channel.setArchived(true, 'Re-archiving channel after status update');
            }
        }

        await interaction.followUp(`<@${interaction.user.id}> Updating status of all submissions complete!`);
    }

    private async hashAttachmentFile(filePath: string): Promise<string | null> {
        try {
            const data = await fs.readFile(filePath);
            return createHash('sha256').update(data).digest('hex');
        } catch {
            return null;
        }
    }

    private async handleAttachHashes(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const repositoryManager = guildHolder.getRepositoryManager();
        const submissionsManager = guildHolder.getSubmissionsManager();

        let scannedPosts = 0;
        let updatedPosts = 0;
        let scannedPostAttachments = 0;
        let updatedPostAttachments = 0;
        let scannedSubmissions = 0;
        let updatedSubmissions = 0;
        let scannedSubmissionAttachments = 0;
        let updatedSubmissionAttachments = 0;
        let missingFiles = 0;
        let errors = 0;
        let anyRepositoryChange = false;

        await repositoryManager.getLock().acquire();
        try {
            await repositoryManager.iterateAllEntries(async (entry) => {
                scannedPosts++;
                const entryData = entry.getData();
                let entryChanged = false;

                for (const attachment of entryData.images) {
                    scannedPostAttachments++;
                    if (!attachment.path) {
                        continue;
                    }

                    const attachmentPath = safeJoinPath(entry.getFolderPath(), attachment.path);
                    const hash = await this.hashAttachmentFile(attachmentPath);
                    if (!hash) {
                        missingFiles++;
                        continue;
                    }

                    if (attachment.hash !== hash) {
                        attachment.hash = hash;
                        entryChanged = true;
                        updatedPostAttachments++;
                    }
                }

                for (const attachment of entryData.attachments) {
                    scannedPostAttachments++;
                    if (!attachment.path) {
                        continue;
                    }

                    const attachmentPath = safeJoinPath(entry.getFolderPath(), attachment.path);
                    // git lfs is being used, check if file is a pointer file
                    const fileStats = await fs.stat(attachmentPath).catch(() => null);
                    if (fileStats && fileStats.size < 200) {
                        missingFiles++;
                        continue;
                    }

                    const hash = await this.hashAttachmentFile(attachmentPath);
                    if (!hash) {
                        missingFiles++;
                        continue;
                    }

                    if (attachment.hash !== hash) {
                        attachment.hash = hash;
                        entryChanged = true;
                        updatedPostAttachments++;
                    }
                }

                if (entryChanged) {
                    await entry.savePrivate();
                    await repositoryManager.add(entry.getDataPath());
                    updatedPosts++;
                    anyRepositoryChange = true;
                }
            });

            const submissionIds = await submissionsManager.getSubmissionsList();
            for (const submissionId of submissionIds) {
                scannedSubmissions++;
                const submission = await submissionsManager.getSubmission(submissionId);
                if (!submission) {
                    errors++;
                    continue;
                }

                const attachments = submission.getConfigManager().getConfig(SubmissionConfigs.ATTACHMENTS) || [];
                let submissionChanged = false;
                const attachmentsFolder = submission.getAttachmentFolder();
                const imagesFolder = submission.getProcessedImagesFolder();

                for (const attachment of attachments) {
                    scannedSubmissionAttachments++;
                    if (!attachment.path) {
                        continue;
                    }

                    const attachmentPath = safeJoinPath(attachmentsFolder, attachment.path);
                    const hash = await this.hashAttachmentFile(attachmentPath);
                    if (!hash) {
                        missingFiles++;
                        continue;
                    }

                    if (attachment.hash !== hash) {
                        attachment.hash = hash;
                        submissionChanged = true;
                        updatedSubmissionAttachments++;
                    }
                }


                const images = submission.getConfigManager().getConfig(SubmissionConfigs.IMAGES) || [];
                for (const image of images) {
                    scannedSubmissionAttachments++;
                    if (!image.path) {
                        continue;
                    }

                    const attachmentPath = safeJoinPath(imagesFolder, image.path);
                    const hash = await this.hashAttachmentFile(attachmentPath);
                    if (!hash) {
                        missingFiles++;
                        continue;
                    }

                    if (image.hash !== hash) {
                        image.hash = hash;
                        submissionChanged = true;
                        updatedSubmissionAttachments++;
                    }
                }


                if (submissionChanged) {
                    submission.getConfigManager().setConfig(SubmissionConfigs.ATTACHMENTS, attachments);
                    submission.getConfigManager().setConfig(SubmissionConfigs.IMAGES, images);
                    await submission.save();
                    updatedSubmissions++;
                }
            }

            if (anyRepositoryChange) {
                await repositoryManager.commit(`Backfill attachment hashes for archived posts (${updatedPosts} updated post${updatedPosts === 1 ? '' : 's'})`);
                await repositoryManager.push().catch((e: any) => {
                    errors++;
                    console.error('Failed to push attachhashes commit:', e);
                });
            }
        } catch (error: any) {
            errors++;
            console.error('Error while attaching hashes:', error);
            await interaction.editReply({ content: `attachHashes failed: ${error?.message || 'Unknown error'}` });
            return;
        } finally {
            repositoryManager.getLock().release();
        }

        await interaction.editReply({
            content:
                `attachHashes complete.\n` +
                `Archived posts: ${updatedPosts}/${scannedPosts} updated, attachments changed ${updatedPostAttachments}/${scannedPostAttachments}.\n` +
                `Submissions: ${updatedSubmissions}/${scannedSubmissions} updated, attachments changed ${updatedSubmissionAttachments}/${scannedSubmissionAttachments}.\n` +
                `Missing files: ${missingFiles}. Errors: ${errors}.`
        });
    }


    private async handleAttachmentFix(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const repositoryManager = guildHolder.getRepositoryManager();
        const submissionsManager = guildHolder.getSubmissionsManager();

        let scannedSubmissions = 0;
        let updatedSubmissions = 0;
        let scannedSubmissionAttachments = 0;
        let updatedSubmissionAttachments = 0;
        let republishedSubmissions = 0;
        let missingFiles = 0;
        let errors = 0;

        try {
            const submissionIds = await submissionsManager.getSubmissionsList();
            for (const submissionId of submissionIds) {
                scannedSubmissions++;
                const submission = await submissionsManager.getSubmission(submissionId);
                if (!submission) {
                    errors++;
                    continue;
                }

                const attachments = submission.getConfigManager().getConfig(SubmissionConfigs.ATTACHMENTS) || [];
                let submissionChanged = false;

                for (const attachment of attachments) {
                    scannedSubmissionAttachments++;
                    if (!attachment.path) {
                        // try make path
                        const potentialPath = getFileKey(attachment);
                        // check if file exists
                        const attachmentPath = safeJoinPath(submission.getAttachmentFolder(), potentialPath);
                        const fileExists = await fs.access(attachmentPath).then(() => true).catch(() => false);
                        if (fileExists) {
                            attachment.path = potentialPath;
                            submissionChanged = true;
                        } else {
                            continue;
                        }
                    }

                    const attachmentPath = safeJoinPath(submission.getAttachmentFolder(), attachment.path);
                    const hash = await this.hashAttachmentFile(attachmentPath);
                    if (!hash) {
                        missingFiles++;
                        continue;
                    }

                    if (attachment.hash !== hash) {
                        attachment.hash = hash;
                        submissionChanged = true;
                        updatedSubmissionAttachments++;
                    }
                }

                if (submissionChanged) {
                    submission.getConfigManager().setConfig(SubmissionConfigs.ATTACHMENTS, attachments);
                    await submission.save();


                    updatedSubmissions++;
                }

                // check if published
                if (submission.getConfigManager().getConfig(SubmissionConfigs.STATUS) === SubmissionStatus.ACCEPTED) {

                    // fixup the repository entry if it exists
                    const entry = await repositoryManager.findEntryBySubmissionId(submissionId);
                    if (entry && entry.entry.getData().attachments.length > 0) {

                        // check each attachment, if it canDownload but no path then we need to republish to fix the attachment
                        if (entry.entry.getData().attachments.some(a => {
                            return a.canDownload && !a.path;
                        })) {
                            // do nothing, its fine

                            // we need to republish
                            await submission.publish(
                                true,
                                false,
                                false,
                                {
                                    message: `Fix broken attachments`,
                                }
                            )
                            republishedSubmissions++;
                        }
                    }
                }
            }

        } catch (error: any) {
            errors++;
            console.error('Error while fixing attachments:', error);
            await interaction.editReply({ content: `attachmentFix failed: ${error?.message || 'Unknown error'}` });
            return;
        }

        await interaction.editReply({
            content:
                `attachmentFix complete.\n` +
                `Submissions: ${updatedSubmissions}/${scannedSubmissions} updated, attachments changed ${updatedSubmissionAttachments}/${scannedSubmissionAttachments}.\n` +
                `Missing files: ${missingFiles}. Errors: ${errors}. Republished: ${republishedSubmissions}.`
        });
    }

    private async handleBackfillThumbnails(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const repositoryManager = guildHolder.getRepositoryManager();

        let scannedPosts = 0;
        let updatedPosts = 0;
        let missingPostReferences = 0;
        let missingThreads = 0;
        let missingStarterMessages = 0;
        let missingThumbnails = 0;
        let errors = 0;
        let anyRepositoryChange = false;

        await repositoryManager.getLock().acquire();
        try {
            await repositoryManager.iterateAllEntries(async (entry) => {
                scannedPosts++;

                try {
                    const entryData = entry.getData();
                    const post = entryData.post;

                    if (!post?.threadId) {
                        missingPostReferences++;
                        return;
                    }

                    const forumChannel = await guildHolder.getGuild().channels.fetch(post.forumId).catch(() => null);
                    let thread = null;
                    if (forumChannel && forumChannel.type === ChannelType.GuildForum) {
                        thread = await forumChannel.threads.fetch(post.threadId).catch(() => null);
                    }

                    if (!thread) {
                        const fallbackThread = await guildHolder.getGuild().channels.fetch(post.threadId).catch(() => null);
                        if (fallbackThread && fallbackThread.isThread()) {
                            thread = fallbackThread;
                        }
                    }

                    if (!thread) {
                        missingThreads++;
                        return;
                    }

                    const starterMessage = await thread.fetchStarterMessage().catch(() => null);
                    if (!starterMessage) {
                        missingStarterMessages++;
                        return;
                    }

                    const thumbnailURL = starterMessage.attachments.first()?.url;
                    if (!thumbnailURL) {
                        missingThumbnails++;
                        return;
                    }

                    if (post.thumbnailURL !== thumbnailURL) {
                        post.thumbnailURL = thumbnailURL;
                        await entry.savePrivate();
                        await repositoryManager.add(entry.getDataPath());
                        updatedPosts++;
                        anyRepositoryChange = true;
                    }
                } catch (error) {
                    errors++;
                    console.error(`Failed to backfill thumbnail URL for ${entry.getData().code}:`, error);
                }
            });

            if (anyRepositoryChange) {
                await repositoryManager.commit(`Backfill thumbnail URLs for archived posts (${updatedPosts} updated post${updatedPosts === 1 ? '' : 's'})`);
                await repositoryManager.push().catch((error) => {
                    errors++;
                    console.error('Failed to push backfillthumbnails commit:', error);
                });
            }
        } catch (error: any) {
            errors++;
            console.error('Error while backfilling archived post thumbnail URLs:', error);
            await interaction.editReply({ content: `backfillThumbnails failed: ${error?.message || 'Unknown error'}` });
            return;
        } finally {
            repositoryManager.getLock().release();
        }

        await interaction.editReply({
            content:
                `backfillThumbnails complete.\n` +
                `Archived posts scanned: ${scannedPosts}. Updated: ${updatedPosts}.\n` +
                `Missing post references: ${missingPostReferences}. Missing threads: ${missingThreads}. Missing starter messages: ${missingStarterMessages}. Missing thumbnails: ${missingThumbnails}.\n` +
                `Errors: ${errors}.`
        });
    }

    private async handleAddThanks(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const targetUser = interaction.options.getUser('user', true);
        const amount = interaction.options.getInteger('amount') ?? 1;
        const addToBuffer = interaction.options.getBoolean('add_to_buffer') ?? true;

        const userData = await guildHolder.getUserManager().getOrCreateUserData(targetUser.id, targetUser.username);
        userData.username = targetUser.username;

        const timestamp = Date.now();
        const channelId = interaction.channel?.id as Snowflake | undefined;
        const messageId = interaction.id as Snowflake;

        userData.thankedCountTotal += amount;

        if (addToBuffer) {
            for (let i = 0; i < amount; i++) {
                userData.thankedBuffer.push({
                    thankedBy: interaction.user.id as Snowflake,
                    timestamp,
                    channelId: channelId ?? guildHolder.getGuild().id as Snowflake,
                    messageId: messageId,
                });
            }
        }

        await guildHolder.getUserManager().saveUserData(userData);
        await guildHolder.checkHelper(userData).catch(() => null);

        await replyEphemeral(interaction, `Added ${amount} thank-you point${amount === 1 ? '' : 's'} to <@${targetUser.id}>${addToBuffer ? ' (buffer updated).' : '.'}`);
    }

    private async handleRemoveThanks(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const targetUser = interaction.options.getUser('user', true);
        const amount = interaction.options.getInteger('amount') ?? 1;
        const trimBuffer = interaction.options.getBoolean('trim_buffer') ?? true;

        const userData = await guildHolder.getUserManager().getUserData(targetUser.id);
        if (!userData) {
            await replyEphemeral(interaction, `No data found for user <@${targetUser.id}>.`);
            return;
        }

        const originalTotal = userData.thankedCountTotal;
        userData.thankedCountTotal = Math.max(0, userData.thankedCountTotal - amount);

        let removedFromBuffer = 0;
        if (trimBuffer && userData.thankedBuffer.length > 0) {
            removedFromBuffer = Math.min(amount, userData.thankedBuffer.length);
            userData.thankedBuffer.splice(-removedFromBuffer, removedFromBuffer);
        }

        await guildHolder.getUserManager().saveUserData(userData);
        await guildHolder.checkHelper(userData).catch(() => null);

        await replyEphemeral(
            interaction,
            `Removed ${amount} thank-you point${amount === 1 ? '' : 's'} from <@${targetUser.id}> (total ${originalTotal} → ${userData.thankedCountTotal})${trimBuffer ? `. Trimmed ${removedFromBuffer} buffer entr${removedFromBuffer === 1 ? 'y' : 'ies'}.` : '.'}`
        );
    }

    private async handleMemberStats(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const guild = guildHolder.getGuild();
        let members: Collection<Snowflake, GuildMember>;
        try {
            members = await guild.members.fetch();
        } catch (error: any) {
            await interaction.editReply({ content: `Failed to fetch members: ${error?.message || 'Unknown error'}` });
            return;
        }

        const stats = members.map(member => ({
            username: member.user.username,
            roles: member.roles.cache
                .filter(role => role.id !== guild.id)
                .map(role => role.name),
            joinedAt: member.joinedAt ? member.joinedAt.toISOString() : null,
        }));

        const buffer = Buffer.from(JSON.stringify(stats, null, 2));
        const attachment = new AttachmentBuilder(buffer, { name: `memberstats-${guild.id}.json` });

        await interaction.editReply({
            content: `Exported ${stats.length} member${stats.length === 1 ? '' : 's'}.`,
            files: [attachment]
        });
    }

    private async handleListAuthors(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const guild = guildHolder.getGuild();

        const repositoryManager = guildHolder.getRepositoryManager();
        if ((await repositoryManager.getChannelReferences()).length === 0) {
            await interaction.editReply({ content: 'No archive channels configured.' });
            return;
        }

        type AuthorPosts = { author: DiscordAuthor; posts: Map<string, string> };

        const authorMap = new Map<string, AuthorPosts>();
        const postsWithMissingAuthors = new Set<string>();
        let postsScanned = 0;

        try {
            await repositoryManager.iterateAllEntries(async (entry, entryRef) => {
                const data = entry.getData();
                postsScanned++;

                const postCode = data.code || entryRef.code;
                const postTitle = data.name || postCode;
                const authors = data.authors || [];

                for (const author of authors) {
                    if (author.type === AuthorType.Unknown) {
                        continue;
                    }

                    const key = getAuthorKey(author);
                    const existing = authorMap.get(key);
                    if (existing) {
                        if (!existing.posts.has(postCode)) {
                            existing.posts.set(postCode, postTitle);
                        }
                    } else {
                        const posts = new Map<string, string>();
                        posts.set(postCode, postTitle);
                        authorMap.set(key, { author, posts });
                    }
                }
            });
        } catch (error: any) {
            await interaction.editReply({ content: `Failed to scan archive entries: ${error?.message || 'Unknown error'}` });
            return;
        }

        if (authorMap.size === 0) {
            await interaction.editReply({ content: `No archived post authors found outside of ${guild.name}.` });
            return;
        }

        const report = Array.from(authorMap.values())
            .map(({ author, posts }) => {
                const postList = Array.from(posts.values()).sort((a, b) => a.localeCompare(b));
                return {
                    name: getAuthorName(author),
                    type: author.type,
                    posts: postList
                };
            });

        // sort by name
        report.sort((a, b) => a.name.localeCompare(b.name));

        const escapeCsv = (value: string) => {
            const safe = value.replace(/"/g, '""');
            return `"${safe}"`;
        };
        const csvLines = [
            'Username,Status,Archived Posts',
            ...report.map(item => {
                const posts = item.posts.join(' | ');
                return [
                    escapeCsv(item.name),
                    escapeCsv(item.type),
                    escapeCsv(posts)
                ].join(',');
            })
        ];

        const buffer = Buffer.from(csvLines.join('\n'));
        const attachment = new AttachmentBuilder(buffer, { name: `authors-${guild.id}.csv` });

        const summary = `Found ${report.length} author${report.length === 1 ? '' : 's'} not in ${guild.name} across ${postsWithMissingAuthors.size} post${postsWithMissingAuthors.size === 1 ? '' : 's'} (scanned ${postsScanned} total).`;

        await interaction.editReply({
            content: summary,
            files: [attachment]
        });
    }

    private async handleOptimizeWdl(_guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const attachment = interaction.options.getAttachment('zip', true);
        const nameLower = (attachment.name || '').toLowerCase();
        if (!nameLower.endsWith('.zip')) {
            await replyEphemeral(interaction, 'Please provide a .zip file.');
            return;
        }

        await interaction.deferReply();

        const workRoot = process.cwd();
        const session = safeJoinPath(workRoot, 'debug', `${Date.now().toString(36)}-${attachment.id}`);
        const inputPath = safeJoinPath(session, 'input.zip');

        try {
            await fs.mkdir(session, { recursive: true });

            const res = await got(attachment.url, { responseType: 'buffer' });
            await fs.writeFile(inputPath, res.body);
            const inputStats = await fs.stat(inputPath).catch(() => null);

            const outputTarget = safeJoinPath(session, 'optimized.zip');
            const { zipPath, worlds } = await optimizeWorldsInZip(inputPath, session, outputTarget);
            const optimizedBuffer = await fs.readFile(zipPath);
            const outName = Path.basename(zipPath);

            const file = new AttachmentBuilder(optimizedBuffer, { name: outName });
            const worldSummary = worlds.map(w => `${Path.basename(w.path)}: ${w.version || w.error || 'Unknown'}`).join('\n');
            const analysisJson = Buffer.from(JSON.stringify(worlds, null, 2));
            const analysisAttachment = new AttachmentBuilder(analysisJson, { name: 'wdl-analysis.json' });

            const formatSize = (bytes: number | null | undefined) => {
                if (!bytes && bytes !== 0) {
                    return 'Unknown';
                }
                const mb = bytes / (1024 * 1024);
                if (mb >= 1) {
                    return `${mb.toFixed(2)} MB`;
                }
                return `${(bytes / 1024).toFixed(1)} KB`;
            };
            const beforeSize = formatSize(inputStats?.size ?? attachment.size);
            const afterSize = formatSize(optimizedBuffer.length);

            await interaction.editReply({
                content: `Optimized WDL created (${outName}).\nSize: ${beforeSize} → ${afterSize}.\n${worldSummary ? `Worlds:\n${worldSummary}` : ''}`,
                files: [file, analysisAttachment]
            });
        } catch (error: any) {
            await interaction.editReply({ content: `Optimization failed: ${error?.message || 'Unknown error'}` });
        } finally {
            await fs.rm(session, { recursive: true, force: true }).catch(() => null);
        }
    }

    private async handleAnalyzeWdl(_guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const attachment = interaction.options.getAttachment('zip', true);
        const nameLower = (attachment.name || '').toLowerCase();
        if (!nameLower.endsWith('.zip')) {
            await replyEphemeral(interaction, 'Please provide a .zip file.');
            return;
        }

        await interaction.deferReply();
        const workRoot = process.cwd();
        const session = safeJoinPath(workRoot, 'debug', `${Date.now().toString(36)}-${attachment.id}`);
        const inputPath = safeJoinPath(session, 'input.zip');


        try {


            await fs.mkdir(session, { recursive: true });

            const res = await got(attachment.url, { responseType: 'buffer' });
            await fs.writeFile(inputPath, res.body);

            const worlds = await findWorldsInZip(inputPath);

            const summaryLines = worlds.map((w, idx) => {
                const label = Path.basename(w.path) || `world-${idx + 1}`;
                const details = w.version || w.error || 'Unknown';
                const name = w.levelName ? ` (${w.levelName})` : '';
                return `${label}${name}: ${details}`;
            });

            const limitedSummary = summaryLines.slice(0, 20).join('\n');
            const truncated = summaryLines.length > 20 ? `\n...and ${summaryLines.length - 20} more` : '';

            const analysisJson = Buffer.from(JSON.stringify(worlds, null, 2));
            const analysisAttachment = new AttachmentBuilder(analysisJson, { name: 'wdl-analysis.json' });

            await interaction.editReply({
                content: `Found ${worlds.length} world${worlds.length === 1 ? '' : 's'}.\n${limitedSummary}${truncated}`,
                files: [analysisAttachment]
            });
        } catch (error: any) {
            await interaction.editReply({ content: `Analysis failed: ${error?.message || 'Unknown error'}` });
        } finally {
            await fs.rm(session, { recursive: true, force: true }).catch(() => null);
        }
    }

    private async handleOptimizeImage(interaction: ChatInputCommandInteraction) {
        const attachment = interaction.options.getAttachment('image', true);
        const nameLower = (attachment.name || '').toLowerCase();
        const isLikelyImage = (attachment.contentType && attachment.contentType.startsWith('image/'))
            || nameLower.endsWith('.png')
            || nameLower.endsWith('.jpg')
            || nameLower.endsWith('.jpeg')
            || nameLower.endsWith('.webp')
            || nameLower.endsWith('.gif')
            || nameLower.endsWith('.bmp')
            || nameLower.endsWith('.tif')
            || nameLower.endsWith('.tiff');

        if (!isLikelyImage) {
            await replyEphemeral(interaction, 'Please provide an image attachment.');
            return;
        }

        await interaction.deferReply();

        const workRoot = process.cwd();
        const session = safeJoinPath(workRoot, 'debug', `${Date.now().toString(36)}-${attachment.id}`);
        const safeName = Path.basename(attachment.name || `image-${attachment.id}`);
        const ext = Path.extname(safeName);
        const inputPath = safeJoinPath(session, `input${ext || ''}`);
        const outputName = `${Path.parse(safeName).name || 'image'}-optimized.png`;
        const outputPath = safeJoinPath(session, outputName);

        try {
            await fs.mkdir(session, { recursive: true });

            const res = await got(attachment.url, { responseType: 'buffer' });
            await fs.writeFile(inputPath, res.body);

            const metadata = await optimizeImage(inputPath, outputPath);
            const optimizedBuffer = await fs.readFile(outputPath);
            const file = new AttachmentBuilder(optimizedBuffer, { name: outputName });

            const sizeKb = (metadata.size / 1024).toFixed(1);
            const originalSizeKb = attachment.size ? (attachment.size / 1024).toFixed(1) : null;
            const originalSummary = originalSizeKb ? `Original: ${originalSizeKb} KB.` : '';

            await interaction.editReply({
                content: `Optimized image: ${metadata.width}x${metadata.height}, ${sizeKb} KB. ${originalSummary}`.trim(),
                files: [file]
            });
        } catch (error: any) {
            await interaction.editReply({ content: `Image optimization failed: ${error?.message || 'Unknown error'}` });
        } finally {
            await fs.rm(session, { recursive: true, force: true }).catch(() => null);
        }
    }

    private async handleRestoreTags(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        await guildHolder.getRepositoryManager().restoreTags();

        await interaction.editReply({ content: 'Global tags restored to archive entries and Discord threads.' });

    }

    private async handleDeleteTag(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const tagName = interaction.options.getString('tag', true);

        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        await guildHolder.getRepositoryManager().deleteTag(tagName);
        await interaction.editReply({ content: `Tag "${tagName}" has been deleted from archive entries and Discord threads.` });
    }
}
