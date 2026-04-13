import { ActionRowBuilder, Attachment, ButtonBuilder, ButtonInteraction, EmbedBuilder, GuildTextBasedChannel, Message, MessageFlags, Snowflake, TextBasedChannel } from "discord.js";
import type { GuildHolder } from "../GuildHolder.js";
import { GuildConfigs } from "../config/GuildConfigs.js";
import { NotABotButton } from "../components/buttons/NotABotButton.js";
import { BanUserButton } from "../components/buttons/BanUserButton.js";
import { LiftTimeoutButton } from "../components/buttons/LiftTimeoutButton.js";
import { AttachmentsState, UserData } from "./UserData.js";
import { replyEphemeral, truncateStringWithEllipsis } from "../utils/Util.js";

type PendingSpamUser = {
    state: 'warned' | 'verifying' | 'timing_out';
    messageRefs: Set<string>;
    timeoutHandle?: ReturnType<typeof setTimeout>;
};

export class AntiSpamSystem {
    private pendingSpamUsers = new Map<Snowflake, PendingSpamUser>();

    constructor(private guildHolder: GuildHolder) {}

    private getMessageRef(message: Message | { channel: { id: Snowflake }, id: Snowflake }): string {
        return [message.channel.id, message.id].join('-');
    }

    private getOrCreatePendingSpamUser(userId: Snowflake): PendingSpamUser {
        let pendingUser = this.pendingSpamUsers.get(userId);
        if (!pendingUser) {
            pendingUser = {
                state: 'warned',
                messageRefs: new Set<string>(),
            };
            this.pendingSpamUsers.set(userId, pendingUser);
        }
        return pendingUser;
    }

    private clearPendingSpamUser(userId: Snowflake) {
        const pendingUser = this.pendingSpamUsers.get(userId);
        if (!pendingUser) {
            return;
        }

        if (pendingUser.timeoutHandle) {
            clearTimeout(pendingUser.timeoutHandle);
        }

        this.pendingSpamUsers.delete(userId);
    }

    private mergePendingMessageRefs(userData: UserData) {
        const pendingUser = this.pendingSpamUsers.get(userData.id);
        if (!pendingUser) {
            return;
        }

        if (!userData.messagesToDeleteOnTimeout) {
            userData.messagesToDeleteOnTimeout = [];
        }

        for (const messageRef of pendingUser.messageRefs) {
            if (!userData.messagesToDeleteOnTimeout.includes(messageRef)) {
                userData.messagesToDeleteOnTimeout.push(messageRef);
            }
        }
    }

    private async deleteMessageWithRetry(message: Message, context: string): Promise<boolean> {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                await message.delete();
                return true;
            } catch (error) {
                if (attempt === 2) {
                    console.error(`Failed to delete message ${message.id} (${context}) after retry:`, error);
                }
            }
        }

        return false;
    }

    private async deleteMessageByRefWithRetry(channel: TextBasedChannel, messageId: Snowflake, context: string): Promise<Message | null> {
        const msg = await channel.messages.fetch(messageId).catch(() => null);
        if (!msg) {
            return null;
        }

        await this.deleteMessageWithRetry(msg, context);
        return msg;
    }

    private async bulkDeleteWithFallback(channel: GuildTextBasedChannel, messageIds: Snowflake[], context: string): Promise<number> {
        if (messageIds.length === 0) {
            return 0;
        }

        try {
            const deleted = await channel.bulkDelete(messageIds, true);
            return deleted.size;
        } catch (error) {
            console.error(`Bulk delete failed in ${context}, retrying individually:`, error);
        }

        let deletedCount = 0;
        for (const messageId of messageIds) {
            const deletedMessage = await this.deleteMessageByRefWithRetry(channel, messageId, `${context} fallback`);
            if (deletedMessage) {
                deletedCount++;
            }
        }

        return deletedCount;
    }

    public async handleMessage(message: Message): Promise<boolean> {
        if (await this.handleSpamCheck(message)) {
            return true;
        }

        if (await this.handleHoneypotMessage(message)) {
            return true;
        }

        return false;
    }

    public async resetUserState(userId: Snowflake, username: string): Promise<void> {
        this.clearPendingSpamUser(userId);

        const userData = await this.guildHolder.getUserManager().getOrCreateUserData(userId, username);
        userData.attachmentsAllowedState = AttachmentsState.DISALLOWED;
        userData.attachmentsAllowedExpiry = 0;
        userData.messagesToDeleteOnTimeout = [];
        await this.guildHolder.getUserManager().saveUserData(userData);
    }

    public async handleNotABotVerification(interaction: ButtonInteraction, userID: Snowflake): Promise<void> {
        const userData = await this.guildHolder.getUserManager().getOrCreateUserData(interaction.user.id, interaction.user.username);
        if (userData.attachmentsAllowedState === AttachmentsState.ALLOWED) {
            replyEphemeral(interaction, `You have already confirmed you're not a bot and can send attachments or links.`);
            return;
        }

        const pendingUser = this.pendingSpamUsers.get(interaction.user.id);
        const previousPendingState = pendingUser?.state;
        if (pendingUser) {
            pendingUser.state = 'verifying';
        }

        userData.attachmentsAllowedState = AttachmentsState.ALLOWED;
        userData.messagesToDeleteOnTimeout = [];
        userData.attachmentsAllowedExpiry = Date.now() + (6 * 30 * 24 * 60 * 60 * 1000);
        try {
            await this.guildHolder.getUserManager().saveUserData(userData);
        } catch (error) {
            if (pendingUser && previousPendingState) {
                pendingUser.state = previousPendingState;
            }
            throw error;
        }
        this.clearPendingSpamUser(interaction.user.id);

        await interaction.reply({
            content: `Thank you for confirming you're not a bot! You can now send messages with attachments or links.`,
            flags: MessageFlags.Ephemeral,
        });

        if (interaction.user.id === userID) {
            await this.deleteMessageWithRetry(interaction.message as Message, 'verification prompt cleanup');
        }
    }

    public async timeoutUserForSpam(userData: UserData, autoTimeout: boolean = false) {
        this.mergePendingMessageRefs(userData);

        const pendingUser = this.getOrCreatePendingSpamUser(userData.id);
        pendingUser.state = 'timing_out';
        if (pendingUser.timeoutHandle) {
            clearTimeout(pendingUser.timeoutHandle);
            pendingUser.timeoutHandle = undefined;
        }

        const guild = this.guildHolder.getGuild();
        const member = await guild.members.fetch(userData.id).catch(() => null);
        const actionRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new LiftTimeoutButton().getBuilder(userData.id),
                new BanUserButton().getBuilder(userData.id),
            );

        if (!member) {
            this.clearPendingSpamUser(userData.id);
            return;
        }

        try {
            const duration = 28 * 24 * 60 * 60 * 1000;
            await member.timeout(duration, 'Link/attachment spam - repeat offender');
        } catch (e: any) {
            console.error(e);
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle(`Failed to Timeout!`)
                .setDescription(`Tried to timeout <@${userData.id}> for link/attachment spam, but I do not have permission to timeout them.`);

            const modChannel = await guild.channels.fetch(this.guildHolder.getConfigManager().getConfig(GuildConfigs.MOD_LOG_CHANNEL_ID)).catch(() => null);
            if (modChannel && modChannel.isSendable()) {
                await modChannel.send({ embeds: [embed], components: [actionRow as any], flags: [MessageFlags.SuppressNotifications] });
            }
            this.clearPendingSpamUser(userData.id);
            return;
        }

        let offendingMessage: {
            content: string;
            files: Attachment[];
        } | null = null;

        if (userData.messagesToDeleteOnTimeout) {
            for (let i = 0; i < userData.messagesToDeleteOnTimeout.length; i++) {
                const msgId = userData.messagesToDeleteOnTimeout[i];
                const [channelId, messageId] = msgId.split('-');
                const channel = await guild.channels.fetch(channelId).catch(() => null);
                if (!channel || !channel.isTextBased()) {
                    continue;
                }

                const msg = await channel.messages.fetch(messageId).catch(() => null);
                if (!msg) {
                    continue;
                }

                if (i === 0) {
                    offendingMessage = {
                        content: msg.content,
                        files: Array.from(msg.attachments.values()),
                    };

                    const modChannel = this.guildHolder.getConfigManager().getConfig(GuildConfigs.MOD_LOG_CHANNEL_ID);
                    if (modChannel && msg.forward) {
                        await msg.forward(modChannel).catch(() => null);
                    }
                }

                await this.deleteMessageWithRetry(msg, 'spam timeout cleanup');
            }

            userData.messagesToDeleteOnTimeout = [];
        }

        userData.attachmentsAllowedState = AttachmentsState.FAILED;
        try {
            await this.guildHolder.getUserManager().saveUserData(userData);
        } catch (error) {
            this.clearPendingSpamUser(userData.id);
            throw error;
        }
        this.clearPendingSpamUser(userData.id);

        const text = [`Timed out <@${userData.id}> for ${autoTimeout ? `not verifying within the allotted time` : `sending links/attachments again after warning`}.`];
        if (offendingMessage) {
            text.push(`**Offending Message:**\n${truncateStringWithEllipsis(offendingMessage.content, 2000)}`);
            if (offendingMessage.files.length > 0) {
                text.push(`**Attachments:**`);
                for (const file of offendingMessage.files) {
                    text.push(`"${file.name}": ${file.url}`);
                }
            }
        }

        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle(`User Timed Out for Spam!`)
            .setDescription(text.join('\n'));

        const modChannel = await guild.channels.fetch(this.guildHolder.getConfigManager().getConfig(GuildConfigs.MOD_LOG_CHANNEL_ID)).catch(() => null);
        if (modChannel && modChannel.isSendable()) {
            await modChannel.send({ embeds: [embed], components: [actionRow as any], flags: [MessageFlags.SuppressNotifications] });
        }
    }

    public async handleSpamCheck(message: Message): Promise<boolean> {
        if (!this.guildHolder.getConfigManager().getConfig(GuildConfigs.MOD_LOG_CHANNEL_ID)) {
            return false;
        }

        if (message.author.bot || message.system) {
            return false;
        }

        const urlRegex = /(?:https?:\/\/|www\.)[^\s<]+/gi;
        const urls = Array.from(message.content.matchAll(urlRegex)).map(match => match[0]);
        const hasUrl = urls.length > 0 || message.content.match(/discord\.gg\/\w+/i) || message.content.match(/discordapp\.com\/invite\/\w+/i);
        const hasAttachment = message.attachments.size > 0;
        const isForwarded = message.messageSnapshots.size > 0;

        if (!hasAttachment && !hasUrl && !isForwarded) {
            return false;
        }

        const pendingSpamUser = this.pendingSpamUsers.get(message.author.id);
        if (pendingSpamUser) {
            pendingSpamUser.messageRefs.add(this.getMessageRef(message));

            if (pendingSpamUser.state === 'verifying') {
                return false;
            }

            await this.deleteMessageWithRetry(message, 'pending spam cleanup');

            if (pendingSpamUser.state === 'timing_out') {
                return true;
            }

            const userData = await this.guildHolder.getUserManager().getOrCreateUserData(message.author.id, message.author.username);
            await this.timeoutUserForSpam(userData);
            return true;
        }

        const userData = await this.guildHolder.getUserManager().getOrCreateUserData(message.author.id, message.author.username);
        if (userData.attachmentsAllowedState === AttachmentsState.ALLOWED) {
            const now = Date.now();
            if (!userData.attachmentsAllowedExpiry || (userData.attachmentsAllowedExpiry < now + 30 * 24 * 60 * 60 * 1000 && userData.attachmentsAllowedExpiry > now)) {
                userData.attachmentsAllowedExpiry = now + 6 * 30 * 24 * 60 * 60 * 1000;
                await this.guildHolder.getUserManager().saveUserData(userData);
            }

            if (userData.attachmentsAllowedExpiry > now) {
                return false;
            }

            userData.attachmentsAllowedState = AttachmentsState.DISALLOWED;
        }

        if (userData.attachmentsAllowedState === AttachmentsState.WARNED) {
            const pendingUser = this.getOrCreatePendingSpamUser(message.author.id);
            pendingUser.messageRefs.add(this.getMessageRef(message));
            await this.deleteMessageWithRetry(message, 'warned spam cleanup');
            await this.timeoutUserForSpam(userData);
            return true;
        }

        const spamContent = hasAttachment && hasUrl ? 'attachments and links' : hasAttachment ? 'attachments' : 'links';
        const pendingUser = this.getOrCreatePendingSpamUser(message.author.id);
        pendingUser.state = 'warned';
        pendingUser.messageRefs.add(this.getMessageRef(message));

        const embed = new EmbedBuilder()
            .setColor(0xFFFF00)
            .setTitle(`Spam Check!`)
            .setDescription(`Hi <@${message.author.id}>, it looks like you sent a message containing ${spamContent}. To prevent spam, attachments and links are not allowed until you verify that you're not a bot. To enable them, please click the "I am not a bot" button below. **You have 5 minutes to verify before you are timed out.**\n\n⚠️ Caution: If you send another message with attachments or links before verifying, you will be timed out immediately without further warning.`)
            .setFooter({ text: `You MUST click the button below or you will be timed out!` });

        const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(new NotABotButton().getBuilder(message.author.id));
        try {
            const warningMsg = await message.reply({ embeds: [embed], components: [row as any], flags: [MessageFlags.SuppressNotifications] });
            pendingUser.messageRefs.add(this.getMessageRef(warningMsg));

            userData.attachmentsAllowedState = AttachmentsState.WARNED;
            this.mergePendingMessageRefs(userData);

            await this.guildHolder.getUserManager().saveUserData(userData);
        } catch (error) {
            this.clearPendingSpamUser(message.author.id);
            throw error;
        }

        pendingUser.timeoutHandle = setTimeout(async () => {
            const currentPendingUser = this.pendingSpamUsers.get(userData.id);
            if (currentPendingUser !== pendingUser || currentPendingUser.state !== 'warned') {
                return;
            }

            const updatedUserData = await this.guildHolder.getUserManager().getUserData(userData.id);
            if (updatedUserData && updatedUserData.attachmentsAllowedState === AttachmentsState.WARNED) {
                await this.timeoutUserForSpam(updatedUserData, true);
            }
        }, 5 * 60 * 1000);

        return false;
    }

    public async handleHoneypotMessage(message: Message): Promise<boolean> {
        const honeypotChannelId = this.guildHolder.getConfigManager().getConfig(GuildConfigs.HONEYPOT_CHANNEL_ID);
        if (!honeypotChannelId || message.channel.id !== honeypotChannelId) {
            return false;
        }

        const guild = this.guildHolder.getGuild();
        const member = await guild.members.fetch(message.author.id).catch(() => null);
        if (!member) {
            console.warn(`Member ${message.author.id} not found in guild ${guild.name}`);
            return true;
        }

        try {
            if (!member.manageable) {
                const embed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle(`Honeypot Triggered!`)
                    .setDescription(`Unfortunately, <@${message.author.id}> is immune to honeypot timeouts because I cannot manage their role.`)
                    .setFooter({ text: `This is a honeypot channel to catch spammers.` });
                if (message.channel.isSendable()) {
                    await message.channel.send({ embeds: [embed], flags: [MessageFlags.SuppressNotifications] });
                }
                return true;
            }

            try {
                const duration = 28 * 24 * 60 * 60 * 1000;
                await member.timeout(duration, 'Honeypot');
            } catch (e: any) {
                console.error(e);
                const embed = new EmbedBuilder()
                    .setColor(0xFF0000)
                    .setTitle(`Honeypot Triggered!`)
                    .setDescription(`Unfortunately, <@${message.author.id}> is immune to honeypot because I do not have permission to timeout them.`)
                    .setFooter({ text: `This is a honeypot channel to catch spammers.` });
                if (message.channel.isSendable()) {
                    await message.channel.send({ embeds: [embed], flags: [MessageFlags.SuppressNotifications] });
                }
                return true;
            }

            await this.deleteMessageWithRetry(message, 'honeypot trigger');

            let deletedMessages = 1;
            await guild.channels.cache.reduce(async (acc, channel) => {
                await acc;
                if (channel.isTextBased() && !channel.isThread()) {
                    const fetchedMessages = await channel.messages.fetch({ limit: 100 });
                    const userMessages = fetchedMessages.filter(m => m.author.id === message.author.id && m.createdAt > new Date(Date.now() - 60 * 60 * 1000));
                    const messagesToDelete = userMessages.map(m => m.id);
                    if (messagesToDelete.length > 0) {
                        deletedMessages += await this.bulkDeleteWithFallback(channel, messagesToDelete, `honeypot cleanup in channel ${channel.id}`);
                    }
                }
            }, Promise.resolve()).catch(console.error);

            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle(`Honeypot Triggered!`)
                .setDescription(`Timed out <@${message.author.id}> for sending a message in the honeypot channel and deleted ${deletedMessages} of their messages in the past hour.`)
                .setFooter({ text: `This is a honeypot channel to catch spammers.` });
            if (message.channel.isSendable()) {
                await message.channel.send({ embeds: [embed], flags: [MessageFlags.SuppressNotifications] });
            }
        } catch (e: any) {
            console.error(`Failed to timeout member ${message.author.id} in guild ${guild.name}:`, e);
        }

        return true;
    }
}
