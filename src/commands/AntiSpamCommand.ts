import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, InteractionContextType, ChannelType, ActionRowBuilder, EmbedBuilder, MessageFlags } from "discord.js";
import { GuildHolder } from "../GuildHolder.js";
import { Command } from "../interface/Command.js";
import { GuildConfigs } from "../config/GuildConfigs.js";
import { escapeDiscordString, replyEphemeral, splitIntoChunks } from "../utils/Util.js";
import { NotABotButton } from "../components/buttons/NotABotButton.js";

export class AntiSpamCommand implements Command {
    getID(): string {
        return "antispam";
    }

    getBuilder(_guildHolder: GuildHolder): SlashCommandBuilder {
        const data = new SlashCommandBuilder();
        data
            .setName(this.getID())
            .setDescription('Anti-spam tools for administrators')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .setContexts(InteractionContextType.Guild)
            .addSubcommand(subcommand =>
                subcommand
                    .setName('setmodlog')
                    .setDescription('Setup Llamabot to send moderation logs to a channel')
                    .addChannelOption(option =>
                        option
                            .setName('channel')
                            .setDescription('Channel to send moderation logs to')
                            .setRequired(true)
                            .addChannelTypes(ChannelType.GuildAnnouncement, ChannelType.GuildText)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('sethoneypot')
                    .setDescription('Setup Llamabot to timeout anyone who sends a message to a channel')
                    .addChannelOption(option =>
                        option
                            .setName('channel')
                            .setDescription('Honeypot channel')
                            .setRequired(true)
                            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('sendbotcheck')
                    .setDescription('Send a bot check button in the current channel')
                    .addUserOption(option =>
                        option
                            .setName('user')
                            .setDescription('Optionally auto delete the message when this user verifies')
                            .setRequired(false)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('clearwarnings')
                    .setDescription('Clear Llamabot warnings for a user')
                    .addUserOption(option =>
                        option
                            .setName('user')
                            .setDescription('Clear warnings for a specific user')
                            .setRequired(true)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('debugreset')
                    .setDescription('Debug: reset anti-spam state for a user')
                    .addUserOption(option =>
                        option
                            .setName('user')
                            .setDescription('Reset anti-spam state for a specific user')
                            .setRequired(true)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('togglealtdetection')
                    .setDescription('Enable or disable alt account detection')
                    .addBooleanOption(option =>
                        option
                            .setName('enabled')
                            .setDescription('Enable or disable alt account detection')
                            .setRequired(true)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('setaltthreshold')
                    .setDescription('Set the account age threshold for alt account detection')
                    .addNumberOption(option =>
                        option
                            .setName('days')
                            .setDescription('Accounts younger than this (in days) at join time will be flagged')
                            .setRequired(true)
                            .setMinValue(0.1)
                            .setMaxValue(365)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName('scanmembers')
                    .setDescription('Scan all existing members for potential alt accounts')
            );
        return data;
    }

    async execute(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction): Promise<void> {
        if (interaction.options.getSubcommand() === 'setmodlog') {
            await this.setModLog(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'sethoneypot') {
            await this.setHoneypot(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'sendbotcheck') {
            await this.sendBotCheck(interaction);
        } else if (interaction.options.getSubcommand() === 'clearwarnings') {
            const user = interaction.options.getUser('user');
            if (!user) {
                await replyEphemeral(interaction, 'Invalid user');
                return;
            }

            const data = await guildHolder.getUserManager().getUserData(user.id);
            if (!data || !data.llmWarnings || data.llmWarnings.length === 0) {
                await replyEphemeral(interaction, 'User has no warnings.');
                return;
            }

            data.llmWarnings = [];
            await guildHolder.getUserManager().saveUserData(data);
            await interaction.reply(`Cleared all Llamabot warnings for ${user.tag}.`);
        } else if (interaction.options.getSubcommand() === 'debugreset') {
            const user = interaction.options.getUser('user');
            if (!user) {
                await replyEphemeral(interaction, 'Invalid user');
                return;
            }

            await guildHolder.getAntiSpamSystem().resetUserState(user.id, user.username);
            await interaction.reply(`Reset anti-spam state for ${user.tag}.`);
        } else if (interaction.options.getSubcommand() === 'togglealtdetection') {
            await this.toggleAltDetection(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'setaltthreshold') {
            await this.setAltThreshold(guildHolder, interaction);
        } else if (interaction.options.getSubcommand() === 'scanmembers') {
            await this.scanMembers(guildHolder, interaction);
        } else {
            await replyEphemeral(interaction, 'Invalid subcommand.');
            return;
        }
    }

    private async setHoneypot(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const channel = interaction.options.getChannel('channel');
        if (!channel) {
            await replyEphemeral(interaction, 'Invalid channel');
            return;
        }

        guildHolder.getConfigManager().setConfig(GuildConfigs.HONEYPOT_CHANNEL_ID, channel.id);
        await interaction.reply(`Llamabot will now timeout anyone who sends a message to ${channel.name}!`);
    }

    private async setModLog(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const channel = interaction.options.getChannel('channel');
        if (!channel) {
            await replyEphemeral(interaction, 'Invalid channel');
            return;
        }

        guildHolder.getConfigManager().setConfig(GuildConfigs.MOD_LOG_CHANNEL_ID, channel.id);
        await interaction.reply(`Llamabot will now send moderation logs to ${channel.name}!`);
    }

    private async sendBotCheck(interaction: ChatInputCommandInteraction) {
        const chosenUser = interaction.options.getUser('user');
        if (!interaction.channel || !interaction.channel.isTextBased() || !interaction.channel.isSendable()) {
            await replyEphemeral(interaction, 'This command can only be used in text channels.');
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(0xFFFF00)
            .setTitle('Spam Check!')
            .setDescription(`To prevent spam, attachments are not allowed until you verify that you're not a bot. To enable attachments, please click the "I am not a bot" button below.`);
        const row = new ActionRowBuilder()
            .addComponents(await new NotABotButton().getBuilder(chosenUser ? chosenUser.id : interaction.user.id));
        await interaction.channel.send({ embeds: [embed], components: [row as any], flags: [MessageFlags.SuppressNotifications] });
    }

    private async toggleAltDetection(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const enabled = interaction.options.getBoolean('enabled', true);
        guildHolder.getConfigManager().setConfig(GuildConfigs.ALT_ACCOUNT_DETECTION_ENABLED, enabled);
        await interaction.reply(enabled
            ? 'Alt account detection is now **enabled**. New members with recently created accounts will be flagged in the mod log channel.'
            : 'Alt account detection is now **disabled**.');
    }

    private async setAltThreshold(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        const days = interaction.options.getNumber('days', true);
        const ms = Math.round(days * 24 * 60 * 60 * 1000);
        guildHolder.getConfigManager().setConfig(GuildConfigs.ALT_ACCOUNT_DETECTION_CREATION_THRESHOLD, ms);
        await interaction.reply(`Alt account detection threshold set to **${days} day${days !== 1 ? 's' : ''}**. Accounts younger than this at join time will be flagged.`);
    }

    private async scanMembers(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction) {
        await interaction.deferReply();

        const { total, flagged } = await guildHolder.scanMembersForAltAccounts().catch(error => {
            console.error('Error scanning members for alt accounts:', error);
            return { total: null, flagged: null };
        });

        if (total === null || flagged === null) {
            await interaction.editReply('An error occurred while scanning members for alt accounts. Please try again later.');
            return;
        }

        if (flagged.length === 0) {
            await interaction.editReply(`Scan complete: no potential alt accounts found out of ${total} members.`);
            return;
        }

        const threshold = guildHolder.getConfigManager().getConfig(GuildConfigs.ALT_ACCOUNT_DETECTION_CREATION_THRESHOLD);
        const thresholdDays = Math.round(threshold / (1000 * 60 * 60 * 24));

        // sort flagged members by join timestamp, newest to oldest
        flagged.sort((a, b) => {
            const aJoined = a.joinedTimestamp ?? 0;
            const bJoined = b.joinedTimestamp ?? 0;
            return bJoined - aJoined;
        });

        const lines = flagged.map(member => {
            const createdAt = member.user.createdAt;
            const joinedAt = member.joinedAt ?? new Date();
            const accountAge = joinedAt.getTime() - createdAt.getTime();
            const ageDays = Math.floor(accountAge / (1000 * 60 * 60 * 24));
            const ageHours = Math.floor(accountAge / (1000 * 60 * 60));
            const ageStr = ageDays >= 1 ? `${ageDays}d` : `${ageHours}h`;
            return `<@${member.id}> (${escapeDiscordString(member.displayName ?? member.user.displayName ?? member.user.username)}) — age at join: **${ageStr}**, joined: <t:${Math.floor((member.joinedTimestamp ?? Date.now()) / 1000)}:R>`;
        }).join('\n');

        const chunks: string[] = splitIntoChunks(lines, 2000);

        if (!interaction.channel?.isSendable()) {
            await interaction.editReply('Scan complete, but unable to send results to the current channel. Please check the mod log channel for results.');
            return;
        }

        for (let i = 0; i < chunks.length; i++) {
            await interaction.channel.send({ content: chunks[i], flags: [MessageFlags.SuppressNotifications], allowedMentions: { users: [] } });
        }

        await interaction.editReply(`Scan complete: **${flagged.length}** potential alt account${flagged.length !== 1 ? 's' : ''} found out of ${total} members with account age at join less than ${thresholdDays} day${thresholdDays !== 1 ? 's' : ''}.`);
    }
}
