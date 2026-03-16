import { AnyThreadChannel, ChannelType, ChatInputCommandInteraction, ForumChannel, InteractionContextType, SlashCommandBuilder } from "discord.js";
import { GuildHolder } from "../GuildHolder.js";
import { Command } from "../interface/Command.js";
import { GuildConfigs } from "../config/GuildConfigs.js";
import { DictionaryEntryStatus } from "../archive/DictionaryManager.js";
import { isEditor, isModerator, replyEphemeral, splitIntoChunks, truncateStringWithEllipsis } from "../utils/Util.js";
import { DictionaryEditModal } from "../components/modals/DictionaryEditModal.js";

export class DictionaryEditCommand implements Command {
    getID(): string {
        return "dictionary";
    }

    getBuilder(_guildHolder: GuildHolder): SlashCommandBuilder {
        const data = new SlashCommandBuilder();
        data
            .setName(this.getID())
            .setDescription('Edit or review a dictionary entry')
            .setContexts(InteractionContextType.Guild)
            .addSubcommand(sub =>
                sub
                    .setName('edit')
                    .setDescription('Edit dictionary terms/definition via modal')
            )
            .addSubcommand(sub =>
                sub
                    .setName('approve')
                    .setDescription('Approve this dictionary entry')
            )
            .addSubcommand(sub =>
                sub
                    .setName('reject')
                    .setDescription('Reject this dictionary entry')
            )
            .addSubcommand(sub =>
                sub
                    .setName('references')
                    .setDescription('Show the archive entries that reference this dictionary entry')
            )
            .addSubcommand(sub =>
                sub
                    .setName('forceresync')
                    .setDescription('Rename dictionary threads to match their terms')
            )
            .addSubcommand(sub =>
                sub
                    .setName('closedictionary')
                    .setDescription('Close all open dictionary threads')
            );
        return data;
    }

    async execute(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction): Promise<void> {
        if (!interaction.inGuild()) {
            await replyEphemeral(interaction, 'This command can only be used in a guild.');
            return;
        }

        const subcommand = interaction.options.getSubcommand();

        const dictionaryChannelId = guildHolder.getConfigManager().getConfig(GuildConfigs.DICTIONARY_CHANNEL_ID);
        if (!dictionaryChannelId) {
            await replyEphemeral(interaction, 'Dictionary channel is not configured.');
            return;
        }

        if (subcommand === 'forceresync') {
            if (!isEditor(interaction, guildHolder) && !isModerator(interaction)) {
                await replyEphemeral(interaction, 'You do not have permission to use this command.');
                return;
            }

            const dictionaryChannel = await guildHolder.getGuild().channels.fetch(dictionaryChannelId).catch(() => null) as ForumChannel | null;
            if (!dictionaryChannel || dictionaryChannel.type !== ChannelType.GuildForum) {
                await replyEphemeral(interaction, 'Dictionary channel is not configured as a forum.');
                return;
            }

            await interaction.deferReply();

            const dictionaryManager = guildHolder.getDictionaryManager();
            const entries = await dictionaryManager.listEntries();

            const results: string[] = [];
            let renamed = 0;
            let skipped = 0;
            let missing = 0;

            for (const entry of entries) {
                const thread = await dictionaryManager.fetchThread(entry.id);
                if (!thread || thread.parentId !== dictionaryChannelId) {
                    missing++;
                    results.push(`Entry ${entry.terms[0] || entry.id}: thread not found or not in dictionary forum. Removing entry.`);
                    await dictionaryManager.deleteEntry(entry).catch(() => { /* ignore delete errors */ });
                    continue;
                }

                const desiredName = truncateStringWithEllipsis(entry.terms.join(', '), 100);
                if (!desiredName) {
                    skipped++;
                    results.push(`Entry ${entry.terms[0] || entry.id}: skipped (no terms).`);
                    continue;
                }

                if (thread.name === desiredName) {

                    await dictionaryManager.updateStatusMessage(entry, thread);
                    skipped++;
                    continue;
                }

                const previousName = thread.name;
                const wasArchived = thread.archived;
                if (wasArchived) {
                    await thread.setArchived(false).catch(() => { /* ignore unarchive errors */ });
                }

                await dictionaryManager.updateStatusMessage(entry, thread);

                try {
                    await thread.setName(desiredName);
                    renamed++;
                    results.push(`Renamed "${previousName}" -> "${desiredName}".`);
                } catch (error: any) {
                    skipped++;
                    results.push(`Entry ${entry.terms[0] || entry.id}: failed to rename (${error?.message || error}).`);
                } finally {
                    if (wasArchived) {
                        await thread.setArchived(true).catch(() => { /* ignore re-archive errors */ });
                    }
                }
            }

            if (results.length === 0) {
                results.push('No dictionary entries found to resync.');
            }
            results.unshift(`Force resync complete: renamed ${renamed}, skipped ${skipped}, missing ${missing}.`);

            const chunks = splitIntoChunks(results.join('\n'), 2000);
            if (chunks.length === 0) {
                await interaction.editReply('Force resync complete.');
                return;
            }

            await interaction.editReply({ content: chunks[0], allowedMentions: { parse: [] } });
            for (let i = 1; i < chunks.length; i++) {
                await interaction.followUp({ content: chunks[i], allowedMentions: { parse: [] } });
            }
            return;
        }

        if (subcommand === 'closedictionary') {
            if (!isEditor(interaction, guildHolder) && !isModerator(interaction)) {
                await replyEphemeral(interaction, 'You do not have permission to use this command.');
                return;
            }

            const dictionaryChannel = await guildHolder.getGuild().channels.fetch(dictionaryChannelId).catch(() => null) as ForumChannel | null;
            if (!dictionaryChannel || dictionaryChannel.type !== ChannelType.GuildForum) {
                await replyEphemeral(interaction, 'Dictionary channel is not configured as a forum.');
                return;
            }

            await interaction.reply('Starting to close all dictionary threads. This may take a while depending on the number of open threads. You will be notified when it is complete.');

            const dictionaryManager = guildHolder.getDictionaryManager();
            const threads = await dictionaryChannel.threads.fetchActive();
            for (const thread of threads.threads.values()) {
                const entry = await dictionaryManager.getEntry(thread.id);
                if (entry && entry.status === DictionaryEntryStatus.PENDING) {
                    continue;
                }

                try {
                    if (thread.flags.has("Pinned")) {
                        continue;
                    }
                    await thread.setArchived(true, 'Closing dictionary thread via closeposts command');
                } catch (error) {
                    console.error(`Error closing dictionary thread ${thread.name} (${thread.id}):`, error);
                }
            }

            await interaction.followUp(`<@${interaction.user.id}> Closing all dictionary threads complete!`);
            return;
        }

        if (!interaction.channel || !interaction.channel.isThread()) {
            await replyEphemeral(interaction, 'This command can only be used inside a dictionary thread.');
            return;
        }

        if (interaction.channel.parentId !== dictionaryChannelId) {
            await replyEphemeral(interaction, 'This command can only be used inside a dictionary thread.');
            return;
        }

        const dictionaryManager = guildHolder.getDictionaryManager();
        const thread = interaction.channel as AnyThreadChannel;
        const entry = await dictionaryManager.ensureEntryForThread(thread);
        if (!entry) {
            await replyEphemeral(interaction, 'Could not load a dictionary entry for this thread.');
            return;
        }

        const isPrivileged = isEditor(interaction, guildHolder) || isModerator(interaction);
        const isAllowed = isPrivileged || (subcommand === 'edit' && entry.status !== DictionaryEntryStatus.APPROVED);
        if (!isAllowed) {
            await replyEphemeral(interaction, 'You do not have permission to use this command.');
            return;
        }

        if (subcommand === 'references') {

            const matches: { name: string; url: string }[] = [];
            for (const code of entry.referencedBy) {
                const archiveEntry = await guildHolder.getRepositoryManager().getEntryByPostCode(code);
                if (!archiveEntry) continue;
                const data = archiveEntry.entry.getData();
                matches.push({
                    name: data.name,
                    url: data.post?.threadURL || ''
                });
            }

            if (matches.length === 0) {
                await replyEphemeral(interaction, 'No archive entries reference this dictionary entry.');
                return;
            }

            let response = `Archive entries referencing this dictionary entry:\n`;
            for (const match of matches) {
                response += `- [${match.name}](${match.url})\n`;
            }

            const split = splitIntoChunks(response, 2000);
            let first = true;
            for (const chunk of split) {
                if (first) {
                    await interaction.reply({
                        content: chunk,
                        allowedMentions: { parse: [] }
                    });
                    first = false;
                    continue;
                }

                await interaction.channel.send({
                    content: chunk,
                    allowedMentions: { parse: [] }
                });
            }
            return;
        } else if (subcommand === 'edit') {
            const modal = await new DictionaryEditModal().getBuilder(entry);
            await interaction.showModal(modal);
            return;
        }

        const newStatus = subcommand === 'approve' ? DictionaryEntryStatus.APPROVED : DictionaryEntryStatus.REJECTED;
        entry.status = newStatus;
        entry.updatedAt = Date.now();

        await interaction.deferReply();

        await dictionaryManager.saveEntryAndPush(entry);
        await dictionaryManager.updateStatusMessage(entry, thread);
        await interaction.editReply({
            content:
                newStatus === DictionaryEntryStatus.APPROVED ?
                    `<@${interaction.user.id}> has approved this dictionary entry.` :
                    `<@${interaction.user.id}> has rejected this dictionary entry.`,
            allowedMentions: { parse: [] }
        });
    }
}
