import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, InteractionContextType, ChannelType, ActionRowBuilder, ForumChannel, GuildForumTag, SortOrderType, Snowflake, MessageFlags } from "discord.js";
import { GuildHolder } from "../GuildHolder.js";
import { Command } from "../interface/Command.js";
import { areAuthorsSame, getAuthorFromIdentifier, getAuthorsString, getCodeAndDescriptionFromTopic, replyEphemeral, splitIntoChunks } from "../utils/Util.js";
import { GuildConfigs } from "../config/GuildConfigs.js";
import { SetArchiveCategoriesMenu } from "../components/menus/SetArchiveCategoriesMenu.js";
import { SetEndorseRolesMenu } from "../components/menus/SetEndorseRolesMenu.js";
import { SubmissionTags } from "../submissions/SubmissionTags.js";
import { SetEditorRolesMenu } from "../components/menus/SetEditorRolesMenu.js";
import { SetHelperRoleMenu } from "../components/menus/SetHelperRoleMenu.js";
import { SetDesignerRoleMenu } from "../components/menus/SetDesignerRoleMenu.js";
import { SetScriptModal } from "../components/modals/SetScriptModal.js";
import { republishAllEntries } from "../archive/Tasks.js";
import { GlobalTag, RepositoryConfigs } from "../archive/RepositoryConfigs.js";
import { GlobalTagSelectMenu } from "../components/menus/GlobalTagSelectMenu.js";
import { GlobalTagModal } from "../components/modals/GlobalTagModal.js";

export class Mwa implements Command {
    getID(): string {
        return "mwa";
    }

    getBuilder(): SlashCommandBuilder {
        const data = new SlashCommandBuilder()
        data
            .setName('mwa')
            .setDescription('Llamabot setup for administrators')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .setContexts(InteractionContextType.Guild)
            .addSubcommand(subcommand =>
                subcommand
                    .setName('setsubmissions')
                    .setDescription('Setup Llamabot to listen to a channel')
                    .addChannelOption(option =>
                        option
                            .setName('channel')
                            .setDescription('Channel to listen to')
                            .setRequired(true)
                            .addChannelTypes(ChannelType.GuildForum)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('setupdates')
                    .setDescription('Setup Llamabot to send archive updates to a channel')
                    .addChannelOption(option =>
                        option
                            .setName('channel')
                            .setDescription('Channel to send updates to')
                            .setRequired(true)
                            .addChannelTypes(ChannelType.GuildAnnouncement, ChannelType.GuildText)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('setendorseroles')
                    .setDescription('Setup Llamabot endorse roles')
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('seteditorroles')
                    .setDescription('Setup Llamabot editor roles')
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('sethelperrole')
                    .setDescription('Setup Llamabot helper role')
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('setarchives')
                    .setDescription('Setup archive channels for Llamabot')
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('setuparchives')
                    .setDescription('Setup forums for archive channels')
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('blacklistadd')
                    .setDescription('Add a user to the thank you blacklist')
                    .addStringOption(option =>
                        option
                            .setName('user')
                            .setDescription('User name or id to add to the thank you blacklist')
                            .setRequired(true)
                    )
                    .addStringOption(option =>
                        option
                            .setName('reason')
                            .setDescription('Reason for blacklisting the user')
                            .setRequired(false)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('blacklistremove')
                    .setDescription('Remove a user from the thank you blacklist')
                    .addStringOption(option =>
                        option
                            .setName('user')
                            .setDescription('User name or id to remove from the thank you blacklist')
                            .setRequired(true)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('blacklistlist')
                    .setDescription('List all users in the thank you blacklist')
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('alias')
                    .setDescription('Add an alias for a url')
                    .addStringOption(option =>
                        option
                            .setName('url')
                            .setDescription('The URL to alias')
                            .setRequired(true)   
                    )
                    .addStringOption(option =>
                        option
                            .setName('alias')
                            .setDescription('The post code to use as an alias (leave empty to remove alias)')
                            .setRequired(false)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('setrepo')
                    .setDescription('Set the GitHub repository for the archive')
                    .addStringOption(option =>
                        option
                            .setName('url')
                            .setDescription('GitHub repository URL')
                            .setRequired(true)
                    )
            )

            .addSubcommand(subcommand =>
                subcommand
                    .setName('setwebsite')
                    .setDescription('Set the website URL for the archive')
                    .addStringOption(option =>
                        option
                            .setName('url')
                            .setDescription('Website URL')
                            .setRequired(true)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('setdictionary')
                    .setDescription('Set the dictionary forum channel')
                    .addChannelOption(option =>
                        option
                            .setName('channel')
                            .setDescription('Dictionary forum channel')
                            .setRequired(true)
                            .addChannelTypes(ChannelType.GuildForum)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('globaltagadd')
                    .setDescription('Add a global archive tag')
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('globaltagedit')
                    .setDescription('Edit a global archive tag')
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('globaltagremove')
                    .setDescription('Remove a global archive tag')
                    .addBooleanOption(option =>
                        option
                            .setName('deletetag')
                            .setDescription('Also delete the tag from archive forums (default: true)')
                            .setRequired(false)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('applyglobaltags')
                    .setDescription('Apply pending global tag changes to archive forums')
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('republisheverything')
                    .setDescription('Republish all posts in the archive')
                    .addChannelOption(option =>
                        option
                            .setName('channel')
                            .setDescription('Which channel to republish in (defaults to every channel)')
                    )
                    .addBooleanOption(option =>
                        option
                            .setName('images')
                            .setDescription('Reprocess images during republishing')
                    )
                    .addBooleanOption(option =>
                        option
                            .setName('reanalyze')
                            .setDescription('Reanalyze attachments during republishing')
                    )
                    .addBooleanOption(option =>
                        option
                            .setName('upload')
                            .setDescription('Force re-upload of attachments during republishing')
                    )
                    .addBooleanOption(option =>
                        option
                            .setName('silent')
                            .setDescription('Do not send a message to the submission channels')
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('setdesignerrole')
                    .setDescription('Set the designer role for the archive')
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('refreshdesignerroles')
                    .setDescription('Refresh designer roles based on the current archive')
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('setscript')
                    .setDescription('Set the rules script for a channel subscription')
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('setconfig')
                    .setDescription('Set a guild config value')
                    .addStringOption(option =>
                        option
                            .setName('name')
                            .setDescription('Config to set')
                            .setRequired(true)
                            .addChoices(
                                { name: 'Auto-join server links', value: 'autojoin' },
                                { name: 'Auto-lookup post codes', value: 'autolookup' },
                                { name: 'Minimum endorsements required', value: 'minendorsements' },
                                { name: 'Helper role threshold', value: 'helperrolethreshold' },
                                { name: 'Conversational LLM enabled', value: 'llmenabled' },
                                { name: 'Conversational LLM channel', value: 'llmchannel' },
                                { name: 'Editor rotation enabled', value: 'editorrotation' },
                                { name: 'Self endorsement disallowed', value: 'selfendorsementdisallowed' },
                            )
                    )
                    .addStringOption(option =>
                        option
                            .setName('value')
                            .setDescription('Value for the config (boolean, number, or channel id/mention)')
                            .setRequired(true)
                    )
            )
        return data;
    }

    async execute(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction): Promise<void> {
        if (interaction.options.getSubcommand() === 'setsubmissions') {
            this.setSubmissions(guildHolder, interaction)
        } else if (interaction.options.getSubcommand() === 'setarchives') {
            this.setArchives(guildHolder, interaction)
        } else if (interaction.options.getSubcommand() === 'setupdates') {
            this.setUpdates(guildHolder, interaction)
        } else if (interaction.options.getSubcommand() === 'setuparchives') {
            this.setupArchives(guildHolder, interaction)
        } else if (interaction.options.getSubcommand() === 'setendorseroles') {
            this.setEndorseRoles(guildHolder, interaction)
        } else if (interaction.options.getSubcommand() === 'seteditorroles') {
            this.setEditorRoles(guildHolder, interaction)
        } else if (interaction.options.getSubcommand() === 'sethelperrole') {
            this.setHelperRole(guildHolder, interaction)
        } else if (interaction.options.getSubcommand() === 'setrepo') {
            this.setRepo(guildHolder, interaction)
        } else if (interaction.options.getSubcommand() === 'setdictionary') {
            this.setDictionary(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'globaltagadd') {
            this.addGlobalTag(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'globaltagedit') {
            this.editGlobalTag(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'globaltagremove') {
            this.removeGlobalTag(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'applyglobaltags') {
            this.applyGlobalTags(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'blacklistadd') {
            this.addToBlacklist(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'blacklistremove') {
            this.removeFromBlacklist(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'blacklistlist') {
            this.listBlacklist(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'republisheverything') {
            this.republishEverything(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'setdesignerrole') {
            this.setDesignerRole(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'refreshdesignerroles') {
            this.refreshDesignerRoles(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'setwebsite') {
            this.setWebsite(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'setscript') {
            this.setScript(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'setconfig') {
            this.setConfig(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'alias') {
            this.setAlias(guildHolder, interaction);
        } else {
            await replyEphemeral(interaction, 'Invalid subcommand. Use a valid `/mwa` setup command.');
            return;
        }
    }

    async setWebsite(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const url = interaction.options.getString('url')
        if (!url) {
            await replyEphemeral(interaction, 'Invalid URL')
            return
        }

        // check url is valid
        try {
            new URL(url);
        } catch (e) {
            await replyEphemeral(interaction, 'Invalid URL')
            return
        }

        guildHolder.getConfigManager().setConfig(GuildConfigs.WEBSITE_URL, url)
        await interaction.reply(`Successfully set website URL to ${url}!`);
    }

    async addToBlacklist(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const identifier = interaction.options.getString('user');
        if (!identifier) {
            await replyEphemeral(interaction, 'Invalid user identifier');
            return;
        }

        const reason = interaction.options.getString('reason') || 'No reason provided';

        const author = await getAuthorFromIdentifier(guildHolder, identifier);
        if (!author) {
            await replyEphemeral(interaction, `Invalid identifier: ${identifier}. Please provide a valid Discord ID or username.`);
            return;
        }

        const blacklistedUsers = guildHolder.getConfigManager().getConfig(GuildConfigs.THANKS_BLACKLIST);
        if (blacklistedUsers.some(user => areAuthorsSame(user, author))) {
            await replyEphemeral(interaction, `User ${getAuthorsString([author])} is already in the thank you blacklist.`);
            return;
        }

        author.reason = reason; // Add reason to the author object
        blacklistedUsers.push(author);
        guildHolder.getConfigManager().setConfig(GuildConfigs.THANKS_BLACKLIST, blacklistedUsers);

        interaction.reply({
            content: `Successfully added ${getAuthorsString([author])} to the thank you blacklist for reason: ${reason}`,
        });

        const member = await guildHolder.getGuild().members.fetch(author.id || '').catch(() => null);
        if (!member) {
            return;
        }

        const userData = await guildHolder.getUserManager().getUserData(member.id);
        if (!userData) {
            return;
        }

        await guildHolder.checkHelper(userData, member).catch(e => {
            console.error(`Error checking helper role for user ${author.id}:`, e);
        });
    }

    async removeFromBlacklist(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const identifier = interaction.options.getString('user');
        if (!identifier) {
            await replyEphemeral(interaction, 'Invalid user identifier');
            return;
        }

        const author = await getAuthorFromIdentifier(guildHolder, identifier);
        if (!author) {
            await replyEphemeral(interaction, `Invalid identifier: ${identifier}. Please provide a valid Discord ID or username.`);
            return;
        }

        const blacklistedUsers = guildHolder.getConfigManager().getConfig(GuildConfigs.THANKS_BLACKLIST);
        const index = blacklistedUsers.findIndex(user => areAuthorsSame(user, author));
        if (index === -1) {
            await replyEphemeral(interaction, `User ${getAuthorsString([author])} is not in the thank you blacklist.`);
            return;
        }

        blacklistedUsers.splice(index, 1);
        guildHolder.getConfigManager().setConfig(GuildConfigs.THANKS_BLACKLIST, blacklistedUsers);

        interaction.reply({
            content: `Successfully removed ${getAuthorsString([author])} from the thank you blacklist.`,
        });

        const member = await guildHolder.getGuild().members.fetch(author.id || '').catch(() => null);
        if (!member) {
            return;
        }

        const userData = await guildHolder.getUserManager().getUserData(member.id);
        if (!userData) {
            return;
        }

        await guildHolder.checkHelper(userData, member).catch(e => {
            console.error(`Error checking helper role for user ${author.id}:`, e);
        });
    }

    async listBlacklist(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const blacklistedUsers = guildHolder.getConfigManager().getConfig(GuildConfigs.THANKS_BLACKLIST);
        if (blacklistedUsers.length === 0) {
            await replyEphemeral(interaction, 'The thank you blacklist is empty.');
            return;
        }

        const response = `## Current Thank You Blacklist:\n` + blacklistedUsers.map(user => {
            return `- ${getAuthorsString([user])}: ${user.reason}`;
        }).join('\n');

        const chunks = splitIntoChunks(response, 2000);
        const message = await interaction.reply({ content: 'pending...', flags: MessageFlags.SuppressNotifications });
        await message.edit({ content: chunks[0] });
        for (let i = 1; i < chunks.length; i++) {
            const message = await interaction.followUp({ content: 'pending...', flags: MessageFlags.SuppressNotifications });
            await message.edit({ content: chunks[i] });
        }
    }

    async setRepo(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const url = interaction.options.getString('url')

        if (!url) {
            await replyEphemeral(interaction, 'Invalid URL')
            return
        }

        guildHolder.getConfigManager().setConfig(GuildConfigs.GITHUB_REPO_URL, url)
        await replyEphemeral(interaction, `Successfully set Git repository URL to ${url}!`);
        interaction.followUp({
            content: `<@${interaction.user.id}> Set the Git repository to ${url}!`,
        });

        try {
            await guildHolder.getRepositoryManager().updateRemote();
            await guildHolder.getRepositoryManager().push();
        } catch (error) {
            console.error('Error setting remote repository:', error)
            await replyEphemeral(interaction, 'Error setting remote repository. Please check the URL and try again.')
            return
        }
    }

    async setSubmissions(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const channel = interaction.options.getChannel('channel')
        if (!channel) {
            await replyEphemeral(interaction, 'Invalid channel')
            return
        }

        guildHolder.getConfigManager().setConfig(GuildConfigs.SUBMISSION_CHANNEL_ID, channel.id)
        await interaction.reply(`Llamabot will now listen to ${channel.name} for submissions!`);
    }

    async setArchives(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        // Get all channels in the guild
        const currentCategories = guildHolder.getConfigManager().getConfig(GuildConfigs.ARCHIVE_CATEGORY_IDS);
        const dt = await (new SetArchiveCategoriesMenu()).getBuilder(guildHolder, currentCategories);
        const row = new ActionRowBuilder()
            .addComponents(dt);
        await replyEphemeral(interaction, 'Select archive categories', { components: [row] })
    }

    async setDictionary(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const channel = interaction.options.getChannel('channel');
        if (!channel || channel.type !== ChannelType.GuildForum) {
            await replyEphemeral(interaction, 'Dictionary channel must be a forum.');
            return;
        }

        guildHolder.getConfigManager().setConfig(GuildConfigs.DICTIONARY_CHANNEL_ID, channel.id);
        await interaction.reply(`Dictionary channel set to ${channel.name}.`);
    }

    async setConfig(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const configName = interaction.options.getString('name');
        const rawValue = interaction.options.getString('value');

        if (!configName || rawValue === null) {
            await replyEphemeral(interaction, 'Invalid config name or value');
            return;
        }

        if (configName === 'autojoin' || configName === 'autolookup' || configName === 'acknowledgethanks' || configName === 'llmenabled' || configName === 'editorrotation' || configName === 'selfendorsementdisallowed') {
            const normalized = rawValue.toLowerCase();
            if (normalized !== 'true' && normalized !== 'false') {
                await replyEphemeral(interaction, 'Provide a boolean value (true/false) for this config.');
                return;
            }

            const value = normalized === 'true';
            const configMap = {
                autojoin: GuildConfigs.AUTOJOIN_ENABLED,
                autolookup: GuildConfigs.AUTOLOOKUP_ENABLED,
                acknowledgethanks: GuildConfigs.ACKNOWLEDGE_THANKS,
                llmenabled: GuildConfigs.CONVERSATIONAL_LLM_ENABLED,
                editorrotation: GuildConfigs.EDITOR_ROTATION_ENABLED,
                selfendorsementdisallowed: GuildConfigs.SELF_ENDORSEMENT_DISALLOWED,
            } as const;

            guildHolder.getConfigManager().setConfig(configMap[configName], value);
            await interaction.reply(`Set \`${configName}\` to ${value ? 'enabled' : 'disabled'}.`);
            return;
        }

        if (configName === 'llmchannel') {
            const normalized = rawValue.trim();
            const lower = normalized.toLowerCase();
            const clear = lower === 'clear' || lower === 'none';

            if (clear || normalized === '') {
                guildHolder.getConfigManager().setConfig(GuildConfigs.CONVERSATIONAL_LLM_CHANNEL, '');
                await interaction.reply('Cleared the conversational LLM channel.');
                return;
            }

            const mentionMatch = normalized.match(/^<#(\d+)>$/);
            const channelId = mentionMatch ? mentionMatch[1] : normalized;

            if (!/^[0-9]{17,20}$/.test(channelId)) {
                await replyEphemeral(interaction, 'Provide a valid text channel mention or ID for this config.');
                return;
            }

            const channel = await guildHolder.getGuild().channels.fetch(channelId).catch(() => null);
            if (!channel || channel.type !== ChannelType.GuildText) {
                await replyEphemeral(interaction, 'Conversational LLM channel must be a text channel.');
                return;
            }

            guildHolder.getConfigManager().setConfig(GuildConfigs.CONVERSATIONAL_LLM_CHANNEL, channel.id);
            await interaction.reply(`Set conversational LLM channel to <#${channel.id}>.`);
            return;
        }

        if (configName === 'minendorsements') {
            const parsed = Number(rawValue);
            if (!Number.isInteger(parsed) || parsed < 0) {
                await replyEphemeral(interaction, 'Provide a non-negative integer for minimum endorsements.');
                return;
            }

            guildHolder.getConfigManager().setConfig(GuildConfigs.MIN_ENDORSEMENTS_REQUIRED, parsed);
            await interaction.reply(`Set \`minEndorsements\` to ${parsed}.`);
            return;
        }

        if (configName === 'helperrolethreshold') {
            const parsed = Number(rawValue);
            if (!Number.isInteger(parsed) || parsed < 0) {
                await replyEphemeral(interaction, 'Provide a non-negative integer for the helper role threshold.');
                return;
            }

            guildHolder.getConfigManager().setConfig(GuildConfigs.HELPER_ROLE_THRESHOLD, parsed);
            await interaction.reply(`Set \`helperRoleThreshold\` to ${parsed}.`);
            return;
        }

        await replyEphemeral(interaction, 'Invalid config name. Valid options: autojoin, autolookup, minendorsements, helperrolethreshold, llmenabled, llmchannel, editorrotation, selfendorsementdisallowed.');
    }

    async setScript(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const channelSubscriptions = await guildHolder.getChannelSubscriptionManager().getSubscriptions();
        const modal = new SetScriptModal().getBuilder(channelSubscriptions[interaction.channelId]?.code || '');
        await interaction.showModal(modal);
    }

    async setEndorseRoles(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const dt = await (new SetEndorseRolesMenu()).getBuilder(guildHolder);
        const row = new ActionRowBuilder()
            .addComponents(dt);
        await replyEphemeral(interaction, 'Select endorsement roles', { components: [row] })
    }

    async setEditorRoles(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const dt = await (new SetEditorRolesMenu()).getBuilder(guildHolder);
        const row = new ActionRowBuilder()
            .addComponents(dt);
        await replyEphemeral(interaction, 'Select editor roles', { components: [row] })
    }

    async refreshDesignerRoles(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();
        await guildHolder.rebuildDesignerRoles();
        await interaction.editReply('Designer roles have been refreshed.');
    }

    async setHelperRole(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const dt = await (new SetHelperRoleMenu()).getBuilder(guildHolder);
        const row = new ActionRowBuilder()
            .addComponents(dt);
        await replyEphemeral(interaction, 'Select helper role', { components: [row] })
    }

    async setDesignerRole(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const dt = await (new SetDesignerRoleMenu()).getBuilder(guildHolder);
        const row = new ActionRowBuilder()
            .addComponents(dt);
        await replyEphemeral(interaction, 'Select designer role', { components: [row] })
    }

    async setUpdates(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const channel = interaction.options.getChannel('channel')
        if (!channel) {
            await replyEphemeral(interaction, 'Invalid channel')
            return
        }

        guildHolder.getConfigManager().setConfig(GuildConfigs.LOGS_CHANNEL_ID, channel.id)
        await interaction.reply(`Llamabot will now send updates to ${channel.name}!`);
    }

    async setupArchives(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        if (!interaction.channel || !interaction.channel.isTextBased() || !interaction.inGuild()) {
            await replyEphemeral(interaction, 'This command can only be used in a text channel.')
            return;
        }

        // Setup submission channel
        const submissionChannelId = guildHolder.getConfigManager().getConfig(GuildConfigs.SUBMISSION_CHANNEL_ID);
        if (!submissionChannelId) {
            await replyEphemeral(interaction, 'Submission channel is not set. Please set it using `/mwa setsubmissions` command.');
            return;
        }

        const submissionChannel = await guildHolder.getGuild().channels.fetch(submissionChannelId);
        if (!submissionChannel || submissionChannel.type !== ChannelType.GuildForum) {
            await replyEphemeral(interaction, 'Submission channel is not a valid forum channel. Please set it using `/mwa setsubmissions` command.');
            return;
        }

        await interaction.deferReply()

        let channels;
        try {

            const tags = submissionChannel.availableTags.filter(tag => {
                return !SubmissionTags.some(t => t.name === tag.name)
            })
            const newTags = SubmissionTags.map((t) => {
                const existingTag = submissionChannel.availableTags.find(tag => tag.name === t.name);
                if (existingTag) {
                    return existingTag;
                }
                return t;
            }).concat(tags);

            await submissionChannel.setAvailableTags(newTags);
            await submissionChannel.setDefaultReactionEmoji({
                name: '👍',
                id: null
            });

            const dictionaryChannelId = guildHolder.getConfigManager().getConfig(GuildConfigs.DICTIONARY_CHANNEL_ID);
            if (dictionaryChannelId) {
                const dictionaryChannel = await guildHolder.getGuild().channels.fetch(dictionaryChannelId).catch(() => null);
                if (dictionaryChannel && dictionaryChannel.type === ChannelType.GuildForum) {
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

                    await dictionaryChannel.setAvailableTags(mergedDictionaryTags);
                }
            }

            const currentCategories = guildHolder.getConfigManager().getConfig(GuildConfigs.ARCHIVE_CATEGORY_IDS);

            const allchannels = await guildHolder.getGuild().channels.fetch()

            // get all categories in the guild
            const categories = guildHolder.getGuild().channels.cache.filter(channel => {
                return channel && channel.type === ChannelType.GuildCategory && currentCategories.includes(channel.id)
            });

            const endorserRoles = guildHolder.getConfigManager().getConfig(GuildConfigs.ENDORSE_ROLE_IDS);
            const editorRoles = guildHolder.getConfigManager().getConfig(GuildConfigs.EDITOR_ROLE_IDS);

            const me = guildHolder.getGuild().members.me;

            if (!me) {
                await replyEphemeral(interaction, 'Bot is not in the guild. Please invite the bot to the guild and try again.');
                return;
            }

            for (const category of categories.values()) {
                // set permissions
                if (category.type !== ChannelType.GuildCategory) {
                    continue;
                }

                const permissions = category.permissionOverwrites;

                // set permissions for the bot
                await permissions.edit(me, {
                    SendMessages: true,
                    SendMessagesInThreads: true,
                    CreatePrivateThreads: true,
                    CreatePublicThreads: true,
                    ManageMessages: true,
                    ManageThreads: true,
                    AttachFiles: true,
                    ReadMessageHistory: true,
                    ViewChannel: true,
                    ManageChannels: true,
                    ManageWebhooks: true,
                    ManageRoles: true,
                    EmbedLinks: true,
                });

                await permissions.edit(guildHolder.getGuild().roles.everyone, {
                    SendMessages: false,
                    SendMessagesInThreads: false,
                    AddReactions: true,
                    CreatePrivateThreads: false,
                    CreatePublicThreads: false,
                });


                for (const endorserRole of endorserRoles) {
                    await permissions.edit(endorserRole, {
                        SendMessagesInThreads: true,
                    })
                }

                for (const editorRole of editorRoles) {
                    await permissions.edit(editorRole, {
                        SendMessagesInThreads: true,
                        ManageThreads: true,
                        ManageMessages: true,
                        ManageChannels: true,
                    })
                }
            }

            // get all channels in categories
            channels = allchannels.filter(channel => {
                return channel && channel.type === ChannelType.GuildForum && channel.parentId && currentCategories.includes(channel.parentId)
            }) as unknown as ForumChannel[];

            const basicTagsConfig: GlobalTag[] = guildHolder.getRepositoryManager().getConfigManager().getConfig(RepositoryConfigs.GLOBAL_TAGS);
            // check each channel

            const basicTags: GuildForumTag[] = basicTagsConfig.map(t => ({
                name: t.name,
                emoji: t.emoji ? { name: t.emoji } : null,
                moderated: !!t.moderated,
            })) as GuildForumTag[];

            const codeMap = new Map<Snowflake, string>();
            for (const channel of channels.values()) {
                const tags = channel.availableTags.filter(tag => {
                    return !basicTags.some(t => t.name === tag.name)
                })
                const newTags = basicTags.map((t) => {
                    const existingTag = channel.availableTags.find(tag => tag.name === t.name);
                    if (existingTag) {
                        return existingTag;
                    }
                    return t;
                }).concat(tags);
                await channel.setAvailableTags(newTags)
                await channel.setDefaultReactionEmoji({
                    name: '👍',
                    id: null
                })
                // await channel.setDefaultForumLayout(ForumLayoutType.ListView)
                await channel.setDefaultSortOrder(SortOrderType.CreationDate)

                // check if topic exists
                if (channel.topic) {
                    const { code } = getCodeAndDescriptionFromTopic(channel.topic);
                    if (code) {
                        codeMap.set(channel.id, code);
                    } else {
                        interaction.editReply(`Error: Channel ${channel.name} does not have a valid code in the topic. Please set the topic to include a code in the format "Code: <code>"`);
                        return;
                    }
                } else {
                    interaction.editReply(`Error: Channel ${channel.name} does not have a topic set. Please set the topic to include a code in the format "Code: <code>"`)
                    return;
                }
            }


            // Check if codemap has duplicates
            const codes = Array.from(codeMap.values());
            const duplicates = codes.filter((code, index) => codes.indexOf(code) !== index);
            if (duplicates.length > 0) {
                await interaction.editReply(`Error: The following codes are duplicated across channels: ${duplicates.join(', ')}`);
                return;
            }

        } catch (error: any) {
            console.error('Error setting up archives:', error);
            await interaction.editReply(`An error occurred while setting up archives. ${error.message}`);
            return;
        }


        // Print each channel and its code
        // let response = 'Channel codes:\n';
        // codeMap.forEach((code, channelId) => {
        //     const channel = guildHolder.getGuild().channels.cache.get(channelId);
        //     if (channel) {
        //         response += `- ${channel.name}: ${code}\n`;
        //     } else {
        //         response += `- Channel with ID ${channelId} not found.\n`;
        //     }
        // });
        // await interaction.channel.send(response);

        try {
            await guildHolder.getRepositoryManager().setupArchives(channels)
        } catch (error) {
            console.error('Error setting up archives:', error);
            await interaction.channel.send('An error occurred while setting up archives. Please check the console for details.');
            return;
        }

        await interaction.editReply('Archives setup complete! Please check the channels for the new tags and settings.');
    }

    async addGlobalTag(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        guildHolder.beginGlobalTagQueue();
        const modal = new GlobalTagModal().getBuilder('add');
        await interaction.showModal(modal);
    }

    async editGlobalTag(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        guildHolder.beginGlobalTagQueue();
        const tags = guildHolder.getGlobalTagSnapshot();
        if (!tags.length) {
            await replyEphemeral(interaction, 'No global tags have been configured yet.');
            return;
        }

        const row = new ActionRowBuilder()
            .addComponents(await new GlobalTagSelectMenu().getBuilder(guildHolder, 'edit'));

        await replyEphemeral(interaction, 'Select a global tag to edit', {
            components: [row]
        });
    }

    async removeGlobalTag(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        guildHolder.beginGlobalTagQueue();
        const tags = guildHolder.getGlobalTagSnapshot();
        if (!tags.length) {
            await replyEphemeral(interaction, 'No global tags are configured.');
            return;
        }

        const deleteTag = interaction.options.getBoolean('deletetag') ?? true;

        const row = new ActionRowBuilder()
            .addComponents(await new GlobalTagSelectMenu().getBuilder(guildHolder, 'remove', deleteTag));

        const prompt = deleteTag
            ? 'Select a global tag to remove. It will also be removed from archive forums.'
            : 'Select a global tag to remove. The tag will stay on archive forums/posts but will no longer be global.';

        await replyEphemeral(interaction, prompt, {
            components: [row]
        });
    }

    async applyGlobalTags(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        if (!guildHolder.hasGlobalTagQueue()) {
            await replyEphemeral(interaction, 'No pending global tag changes to apply.');
            return;
        }

        await interaction.reply('Applying pending global tag changes. This may take a moment...');
        try {
            const applied = await guildHolder.applyGlobalTagQueue();
            if (!applied) {
                await interaction.editReply('No global tag changes to apply.');
                return;
            }
        } catch (error: any) {
            console.error('Error applying global tag changes:', error);
            await interaction.editReply(`Failed to apply global tag changes: ${error?.message || error}`);
            return;
        }

        await interaction.editReply('Applied pending global tag changes to archive forums.');
    }

    async republishEverything(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        // Get all entries from the archive
        const channelInfo = interaction.options.getChannel('channel');
        const channel = channelInfo ? await guildHolder.getGuild().channels.fetch(channelInfo.id) : null;
        if (channel && (channel.type !== ChannelType.GuildForum)) {
            await replyEphemeral(interaction, 'Channel must be a forum channel.');
            return;
        }

        if (channel && channel.type === ChannelType.GuildForum) {
            const currentCategories = guildHolder.getConfigManager().getConfig(GuildConfigs.ARCHIVE_CATEGORY_IDS);
            if (!channel.parentId || !currentCategories.includes(channel.parentId)) {
                await replyEphemeral(interaction, 'Channel must be in an archive category.');
                return;
            }
        }

        // const replace = interaction.options.getBoolean('replace') || false;
        const reupload = interaction.options.getBoolean('upload') || false;
        const silent = interaction.options.getBoolean('silent') || false;
        const reanalyze = interaction.options.getBoolean('reanalyze') || false;
        const reprocessImages = interaction.options.getBoolean('images') || false;

        await interaction.reply('Starting to republish all entries. This may take a while depending on the size of the archive. You will be notified when it is complete.');
        try {
            await republishAllEntries(guildHolder, channel, reupload, silent, reanalyze, reprocessImages, interaction);
        } catch (error) {
            console.error('Error republishing all entries:', error);
            await interaction.followUp('An error occurred while republishing all entries. Please check the console for details.');
            return;
        }

        await interaction.followUp(`<@${interaction.user.id}> Republishing all entries complete!`);
    }

    async setAlias(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const url = interaction.options.getString('url', true).trim();
        const alias = (interaction.options.getString('alias', false) || "").trim();

        const aliasManager = guildHolder.getAliasManager();

        // try to find post
        const repositoryManager = guildHolder.getRepositoryManager();
        const entry = await repositoryManager.getEntryByPostCode(alias);
        if (!entry) {
            await replyEphemeral(interaction, `No post found with code "${alias}". Please ensure the code is correct.`);
            return;
        }
        try {
            await aliasManager.setAlias(url, alias);
        } catch (error: any) {
            console.error('Error setting alias:', error);
            await replyEphemeral(interaction, `Error setting alias: ${error.message || error}`);
            return;
        }
        replyEphemeral(interaction, `Successfully set alias for URL ${url} to code "${alias}".`);
    }
}
