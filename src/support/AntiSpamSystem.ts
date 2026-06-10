import { ActionRowBuilder, Attachment, ButtonBuilder, ButtonInteraction, EmbedBuilder, GuildTextBasedChannel, Message, MessageFlags, Snowflake, TextBasedChannel } from "discord.js";
import type { GuildHolder } from "../GuildHolder.js";
import { GuildConfigs } from "../config/GuildConfigs.js";
import { NotABotButton } from "../components/buttons/NotABotButton.js";
import { BanUserButton } from "../components/buttons/BanUserButton.js";
import { LiftTimeoutButton } from "../components/buttons/LiftTimeoutButton.js";
import { AttachmentsState, UserData } from "./UserData.js";
import { replyEphemeral, truncateStringWithEllipsis } from "../utils/Util.js";

 
const RENEW_WINDOW_MS = 15 * 24 * 60 * 60 * 1000; // 15 days - if user sends a message after verifying butbefore expiry and within this window, renew their verification without requiring them to click the button again.
const VERIFICATION_EXPIRY_MS = 2 * 30 * 24 * 60 * 60 * 1000; // 2 months - how long a verification lasts before expiring if no activity from the user.

type MessageRef = {
    channelId: Snowflake;
    messageId: Snowflake;
    timestamp: number;
}

type TransientMessagesForUser = {
    messageRefs: MessageRef[];
    allowedUntil: number; // cached expiry from userData; 0 = unknown/not allowed
}

type PendingSpamUser = {
    trigger: 'attachment' | 'multichannel';
    state: 'warned' | 'verifying' | 'timing_out';
    warningURL: string;
    warnedAt: number;
    channelId: Snowflake;
    followUpSent: boolean;
    messageRefs: Set<string>;
    followUpMessageId?: Snowflake;
};

export class AntiSpamSystem {
    private pendingSpamUsers = new Map<Snowflake, PendingSpamUser>();
    private transientMessageTracker = new Map<Snowflake, TransientMessagesForUser>();
    private lastTickTime = 0;

    constructor(private guildHolder: GuildHolder) { }

    private getMessageRef(message: Message | { channel: { id: Snowflake }, id: Snowflake }): string {
        return [message.channel.id, message.id].join('-');
    }

    private getOrCreatePendingSpamUser(userId: Snowflake, trigger: 'attachment' | 'multichannel' = 'attachment', channelId: Snowflake = ''): PendingSpamUser {
        let pendingUser = this.pendingSpamUsers.get(userId);
        if (!pendingUser) {
            pendingUser = {
                trigger,
                state: 'warned',
                warnedAt: Date.now(),
                channelId,
                followUpSent: false,
                messageRefs: new Set<string>(),
                warningURL: '',
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

    /**
     * Returns true if the user has sent messages in 2+ distinct channels within 30 seconds,
     * or 3+ distinct channels within 5 minutes.
     */
    private checkMultiChannelSpam(userId: Snowflake, now: number): boolean {
        const transient = this.transientMessageTracker.get(userId);
        if (!transient || transient.messageRefs.length < 2) return false;

        const thirtySecondsAgo = now - 30_000;
        const fiveMinutesAgo = now - 300_000;

        let recentChannels: Set<string> | null = null;
        let allChannels: Set<string> | null = null;

        for (const ref of transient.messageRefs) {
            if (ref.timestamp >= thirtySecondsAgo) {
                if (!recentChannels) recentChannels = new Set();
                recentChannels.add(ref.channelId);
                if (recentChannels.size >= 2) return true;
            }
            if (ref.timestamp >= fiveMinutesAgo) {
                if (!allChannels) allChannels = new Set();
                allChannels.add(ref.channelId);
                if (allChannels.size >= 3) return true;
            }
        }

        return false;
    }

    private async warnUserForSpam(message: Message, trigger: 'attachment' | 'multichannel', description: string): Promise<void> {
        const pendingUser = this.getOrCreatePendingSpamUser(message.author.id, trigger, message.channel.id);

        if (trigger === 'multichannel') {
            // Seed pending refs from all transient messages so they get deleted on timeout
            const transient = this.transientMessageTracker.get(message.author.id);
            if (transient) {
                for (const ref of transient.messageRefs) {
                    pendingUser.messageRefs.add(`${ref.channelId}-${ref.messageId}`);
                }
            }
        } else {
            pendingUser.messageRefs.add(this.getMessageRef(message));
        }

        const embed = new EmbedBuilder()
            .setColor(0xFFFF00)
            .setTitle(`Spam Check!`)
            .setDescription(description)
            .setFooter({ text: `You MUST click the button below or you will be timed out!` });

        const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(new NotABotButton().getBuilder(message.author.id));

        try {
            const warningMsg = await message.reply({ embeds: [embed], components: [row as any] });
            pendingUser.messageRefs.add(this.getMessageRef(warningMsg));
            pendingUser.warningURL = warningMsg.url;

            const userData = await this.guildHolder.getUserManager().getOrCreateUserData(message.author.id, message.author.username);
            userData.attachmentsAllowedState = AttachmentsState.WARNED;
            this.mergePendingMessageRefs(userData);
            await this.guildHolder.getUserManager().saveUserData(userData);
        } catch (error) {
            this.clearPendingSpamUser(message.author.id);
            throw error;
        }
    }

    /**
     * Prunes transient message store and expires pending spam warnings.
     * Called periodically from GuildHolder.loop().
     */
    public async tick(): Promise<void> {
        const now = Date.now();
        if (now - this.lastTickTime < 30_000) return;
        this.lastTickTime = now;

        const cutoff = now - 300_000;
        for (const [userId, transient] of this.transientMessageTracker) {
            transient.messageRefs = transient.messageRefs.filter(ref => ref.timestamp >= cutoff);
            if (transient.messageRefs.length === 0) {
                this.transientMessageTracker.delete(userId);
            }
        }

        for (const [userId, pendingUser] of this.pendingSpamUsers) {
            if (pendingUser.state !== 'warned') continue;

            const elapsed = now - pendingUser.warnedAt;

            if (elapsed >= 300_000) {
                const userData = await this.guildHolder.getUserManager().getUserData(userId);
                if (userData?.attachmentsAllowedState === AttachmentsState.WARNED) {
                    await this.timeoutUserForSpam(userData, true);
                }
            } else if (!pendingUser.followUpSent && elapsed >= 150_000) {
                pendingUser.followUpSent = true;
                const guild = this.guildHolder.getGuild();
                const channel = await guild.channels.fetch(pendingUser.channelId).catch(() => null);
                if (channel?.isSendable()) {
                    const followUpMessage = await channel.send({
                        content: `⚠️ <@${userId}>, you still have not verified that you're not a bot. **You have 2 minutes remaining before you are timed out.** Click the button in the ${pendingUser.warningURL ? `[original warning message](${pendingUser.warningURL})` : 'previous message'} to verify now!`,
                    });

                    // Only add follow-up message to pending refs if the original warning message is still present
                    // Check if pending user still exists before accessing messageRefs in case they were cleared in the meantime
                    const currentPendingUser = this.pendingSpamUsers.get(userId);
                    if (currentPendingUser && currentPendingUser.state === 'warned') {
                        currentPendingUser.messageRefs.add(this.getMessageRef(followUpMessage));
                        currentPendingUser.followUpMessageId = followUpMessage.id;
                    } else {
                        await this.deleteMessageWithRetry(followUpMessage, 'spam check follow-up cleanup');
                    }
                }
            }
        }
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
        userData.attachmentsAllowedExpiry = Date.now() + VERIFICATION_EXPIRY_MS;
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
            content: `Thank you for confirming you're not a bot! You can now send messages!`,
            flags: MessageFlags.Ephemeral,
        });

        if (interaction.user.id === userID) {
            await this.deleteMessageWithRetry(interaction.message as Message, 'verification prompt cleanup');
        }

        if (pendingUser && pendingUser.followUpMessageId) {
            const guild = this.guildHolder.getGuild();
            const channel = await guild.channels.fetch(pendingUser.channelId).catch(() => null);
            if (channel?.isTextBased()) {
                const followUpMsg = await channel.messages.fetch(pendingUser.followUpMessageId).catch(() => null);
                if (followUpMsg) {
                    await this.deleteMessageWithRetry(followUpMsg, 'verification follow-up cleanup');
                }
            }
        }
    }

    public async timeoutUserForSpam(userData: UserData, autoTimeout: boolean = false) {
        const existingPending = this.pendingSpamUsers.get(userData.id);
        const trigger = existingPending?.trigger ?? 'attachment';

        this.mergePendingMessageRefs(userData);

        const pendingUser = this.getOrCreatePendingSpamUser(userData.id);
        pendingUser.state = 'timing_out';

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

        const timeoutReason = trigger === 'multichannel'
            ? 'Multi-channel message spam'
            : 'Link/attachment spam - repeat offender';


        let failedTimeout = false;
        try {
            const duration = 28 * 24 * 60 * 60 * 1000;
            await member.timeout(duration, timeoutReason);
        } catch (e: any) {
            console.error(e);
            failedTimeout = true;
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

        if (failedTimeout) {
            const failDescription = trigger === 'multichannel'
                ? `Tried to timeout <@${userData.id}> for multi-channel message spam, but I do not have permission to timeout them.`
                : `Tried to timeout <@${userData.id}> for link/attachment spam, but I do not have permission to timeout them.`;
            const embed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle(`Failed to Timeout!`)
                .setDescription(failDescription);

            const modChannel = await guild.channels.fetch(this.guildHolder.getConfigManager().getConfig(GuildConfigs.MOD_LOG_CHANNEL_ID)).catch(() => null);
            if (modChannel && modChannel.isSendable()) {
                await modChannel.send({ embeds: [embed], components: [actionRow as any], flags: [MessageFlags.SuppressNotifications] });
            }
            return;
        }

        const reasonText = autoTimeout
            ? 'not verifying within the allotted time'
            : trigger === 'multichannel'
                ? 'sending messages across multiple channels after warning'
                : 'sending links/attachments again after warning';
        const text = [`Timed out <@${userData.id}> for ${reasonText}.`];
        if (offendingMessage) {
            text.push(`**Offending Message:**\n${truncateStringWithEllipsis(offendingMessage.content, 2000)}`);
            if (offendingMessage.files.length > 0) {
                text.push(`**Attachments:**`);
                for (const file of offendingMessage.files) {
                    text.push(`"${file.name}": ${file.url}`);
                }
            }
        }

        const embedTitle = trigger === 'multichannel'
            ? 'User Timed Out for Multi-Channel Spam!'
            : 'User Timed Out for Spam!';
        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle(embedTitle)
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

        // Capture pending state before tracking — tracking may create a new multichannel entry,
        // and the triggering message must not be intercepted by the block below.
        const pendingSpamUser = this.pendingSpamUsers.get(message.author.id);

        // Track message in transient store and check multichannel spam thresholds.
        if (!pendingSpamUser) {
            const userId = message.author.id;
            const now = Date.now();
            let transient = this.transientMessageTracker.get(userId);
            if (!transient) {
                transient = { messageRefs: [], allowedUntil: 0 };
                this.transientMessageTracker.set(userId, transient);
            }
            transient.messageRefs.push({ channelId: message.channel.id, messageId: message.id, timestamp: now });

            if (transient.allowedUntil <= now && this.checkMultiChannelSpam(userId, now)) {
                const existingUserData = await this.guildHolder.getUserManager().getUserData(userId);
                if (existingUserData?.attachmentsAllowedState === AttachmentsState.ALLOWED && (existingUserData.attachmentsAllowedExpiry ?? 0) > now) {
                    transient.allowedUntil = existingUserData.attachmentsAllowedExpiry!;
                } else {
                    await this.warnUserForSpam(message, 'multichannel', `Hi <@${message.author.id}>, you've been detected sending messages across multiple channels rapidly, which is suspicious behavior. To prevent spam, you must verify that you're not a bot by clicking the "I am not a bot" button below. **You have 5 minutes to verify before you are timed out.**\n\n⚠️ Caution: If you send any message before verifying, you will be timed out immediately without further warning.`);
                    return false;
                }
            }
        }

        // Multichannel pending users: intercept ALL messages, not just attachment/link ones
        else if (pendingSpamUser.trigger === 'multichannel') {
            pendingSpamUser.messageRefs.add(this.getMessageRef(message));

            if (pendingSpamUser.state === 'verifying') {
                return false;
            }

            await this.deleteMessageWithRetry(message, 'multichannel spam cleanup');

            if (pendingSpamUser.state === 'timing_out') {
                return true;
            }

            const userData = await this.guildHolder.getUserManager().getOrCreateUserData(message.author.id, message.author.username);
            await this.timeoutUserForSpam(userData);
            return true;
        }

        const urlRegex = /(?:https?:\/\/|www\.)[^\s<]+/gi;
        const urls = Array.from(message.content.matchAll(urlRegex)).map(match => match[0]);
        const hasInvite = message.content.match(/discord\.gg\/\w+/i) || message.content.match(/discordapp\.com\/invite\/\w+/i) || message.content.match(/discord\.com\/invite\/\w+/i);
        const hasUrl = urls.length > 0 || hasInvite;
        const hasAttachment = message.attachments.size > 0;
        const isForwarded = message.messageSnapshots.size > 0;

        if (!hasAttachment && !hasUrl && !isForwarded) {
            return false;
        }

        if (!hasAttachment && !hasInvite) {
            // check if urls are discord urls to the same guild - those are always allowed
            const isAllSafeDiscordUrls = urls.every(url => {
                const discordRegex = /^https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)(?:\/(\d+))?$/g
                const match = discordRegex.exec(url);
                if (!match) return false;

                const guildId = match[1];
                return guildId === this.guildHolder.getGuild().id;
            });

            if (isAllSafeDiscordUrls) {
                return false;
            }
        }

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
            if (!userData.attachmentsAllowedExpiry || (userData.attachmentsAllowedExpiry < now + RENEW_WINDOW_MS && userData.attachmentsAllowedExpiry > now)) {
                userData.attachmentsAllowedExpiry = now + VERIFICATION_EXPIRY_MS;
                await this.guildHolder.getUserManager().saveUserData(userData);
            }

            if (userData.attachmentsAllowedExpiry > now) {
                const transient = this.transientMessageTracker.get(message.author.id);
                if (transient) transient.allowedUntil = userData.attachmentsAllowedExpiry;
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
        await this.warnUserForSpam(message, 'attachment', `Hi <@${message.author.id}>, it looks like you sent a message containing ${spamContent}. To prevent spam, attachments and links are not allowed until you verify that you're not a bot. To enable them, please click the "I am not a bot" button below. **You have 5 minutes to verify before you are timed out.**\n\n⚠️ Caution: If you send another message with attachments or links before verifying, you will be timed out immediately without further warning.`);
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
