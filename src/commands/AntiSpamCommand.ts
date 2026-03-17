import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits, InteractionContextType, ChannelType, ActionRowBuilder, EmbedBuilder, MessageFlags } from "discord.js";
import { GuildHolder } from "../GuildHolder.js";
import { Command } from "../interface/Command.js";
import { GuildConfigs } from "../config/GuildConfigs.js";
import { replyEphemeral } from "../utils/Util.js";
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
        } else {
            await replyEphemeral(interaction, 'Invalid subcommand. Use `/antispam sethoneypot`, `/antispam setmodlog`, `/antispam sendbotcheck`, `/antispam clearwarnings`, or `/antispam debugreset`.');
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
}
