import { AnyThreadChannel, ChannelType, EmbedBuilder, Guild, GuildAuditLogsEntry, GuildMember, Message, MessageFlags, Role, PartialGuildMember, Snowflake, GuildChannel, PartialMessage, TextChannel, TextThreadChannel, PermissionFlagsBits } from "discord.js";
import { Bot, SysAdmin } from "./Bot.js";
import { ConfigManager } from "./config/ConfigManager.js";
import { GuildConfigs } from "./config/GuildConfigs.js";
import { SubmissionsManager } from "./submissions/SubmissionsManager.js";
import { RepositoryManager } from "./archive/RepositoryManager.js";
import { ArchiveEntry, ArchiveEntryData } from "./archive/ArchiveEntry.js";
import { deepClone, escapeDiscordString, getAuthorName, getAuthorsString, getChanges, getCodeAndDescriptionFromTopic, isDiscordAuthor, splitIntoChunks, truncateStringWithEllipsis } from "./utils/Util.js";
import { UserManager } from "./support/UserManager.js";
import { UserData } from "./support/UserData.js";
import { SubmissionConfigs } from "./submissions/SubmissionConfigs.js";
import { SubmissionStatus } from "./submissions/SubmissionStatus.js";
import fs from "fs/promises";
import { countCharactersInRecord, getEffectiveStyle, postToMarkdown, StyleInfo } from "./utils/MarkdownUtils.js";
import { Author, AuthorType, DiscordAuthor } from "./submissions/Author.js";
import { generateText, JSONSchema7, ModelMessage, Output, stepCountIs, Tool, ToolLoopAgent, zodSchema } from "ai";
import { UserSubscriptionManager } from "./config/UserSubscriptionManager.js";
import { ChannelSubscriptionManager } from "./config/ChannelSubscriptionManager.js";
import { AntiNukeManager } from "./support/AntiNukeManager.js";
import { DictionaryManager } from "./archive/DictionaryManager.js";
import { DiscordServersDictionary } from "./archive/DiscordServersDictionary.js";
import { getDiscordLinksInText, getDiscordServersFromReferences, getIndexEntryFromDiscordLinkReference, getPostCodesInText, populateDiscordServerInfoInReferences, Reference, ReferenceType, tagReferences, transformOutputWithReferencesForDiscord, transformOutputWithReferencesForEmbeddings } from "./utils/ReferenceUtils.js";
import { retagEverythingTask, updateMetadataTask } from "./archive/Tasks.js";
import { GlobalTag, RepositoryConfigs } from "./archive/RepositoryConfigs.js";
import z from "zod";
import { base64ToInt8Array, generateQueryEmbeddings } from "./llm/EmbeddingUtils.js";
import { PrivateFactBase } from "./archive/PrivateFactBase.js";
import { AliasManager } from "./support/AliasManager.js";
import { AntiSpamSystem } from "./support/AntiSpamSystem.js";
import { PublishCommitMessage } from "./submissions/Publish.js";
import { safeJoinPath } from "./utils/SafePath.js";
/**
 * GuildHolder is a class that manages guild-related data.
 */
export class GuildHolder {
    /**
     * The bot instance associated with this guild holder.
     */
    private bot: Bot;

    /**
     * The guild this holder is managing.
     */
    private guild: Guild;

    /**
     * The configuration for the guild.
     */
    private config: ConfigManager;

    /**
     * The submissions for this guild.
     */
    private submissions: SubmissionsManager;
    private dictionaryManager: DictionaryManager;

    /**
     * User Subscription manager
     */
    private userSubscriptionManager: UserSubscriptionManager;

    /**
     * Channel subscription manager
     */
    private channelSubscriptionManager: ChannelSubscriptionManager

    private discordServersDictionary: DiscordServersDictionary
    private globalDiscordServersDictionary: DiscordServersDictionary

    private repositoryManager: RepositoryManager;
    private userManager: UserManager;

    // private lastDayLoop: number = 0;
    private ready: boolean = false;

    private antiNukeManager: AntiNukeManager;
    private antiSpamSystem: AntiSpamSystem;

    private retaggingRequested: boolean = true;

    private llmResponseLock: boolean = false;

    private globalTagQueue?: {
        snapshot: GlobalTag[]; // snapshot taken at first add/edit/remove command
        working: GlobalTag[];  // current working copy derived from snapshot
        renameMap: Map<string, string>; // newName -> originalName (from snapshot)
        deleteRequests: Set<string>; // snapshot names requested for deletion from forums
    };

    private privateFactBase: PrivateFactBase;
    private aliasManager: AliasManager;

    private lastToolUsages?: { toolName: string; query: string; }[] = [];

    /**
     * Creates a new GuildHolder instance.
     * @param bot The bot instance associated with this guild holder.
     * @param guild The guild this holder is managing.
     */
    constructor(bot: Bot, guild: Guild, globalDiscordServersDictionary: DiscordServersDictionary) {
        this.bot = bot;
        this.guild = guild;
        this.globalDiscordServersDictionary = globalDiscordServersDictionary;
        this.antiNukeManager = new AntiNukeManager(this);
        this.antiSpamSystem = new AntiSpamSystem(this);
        this.config = new ConfigManager(safeJoinPath(this.getGuildFolder(), 'config.json'));
        this.submissions = new SubmissionsManager(this, safeJoinPath(this.getGuildFolder(), 'submissions'));
        this.repositoryManager = new RepositoryManager(this, safeJoinPath(this.getGuildFolder(), 'archive'), this.globalDiscordServersDictionary);
        this.dictionaryManager = this.repositoryManager.getDictionaryManager();
        this.discordServersDictionary = this.repositoryManager.getDiscordServersDictionary();
        this.userManager = new UserManager(safeJoinPath(this.getGuildFolder(), 'users'));
        this.userSubscriptionManager = new UserSubscriptionManager(safeJoinPath(this.getGuildFolder(), 'subscriptions.json'));
        this.channelSubscriptionManager = new ChannelSubscriptionManager(safeJoinPath(this.getGuildFolder(), 'channel_subscriptions.json'));
        this.privateFactBase = new PrivateFactBase(safeJoinPath(this.getGuildFolder(), 'facts'));
        this.aliasManager = new AliasManager(safeJoinPath(this.getGuildFolder(), 'aliases.json'));
        this.config.loadConfig().then(async () => {
            // Set guild name and ID in the config
            this.config.setConfig(GuildConfigs.GUILD_NAME, guild.name);
            this.config.setConfig(GuildConfigs.GUILD_ID, guild.id);

            try {
                await this.repositoryManager.init()
            } catch (e) {
                console.error('Error initializing repository manager:', e);
            }

            await this.repositoryManager.rebuildIndexesAndEmbeddings();
            await this.updatePostChannelsCache();
            await this.checkAllUsersForHelperRole();


            console.log(`GuildHolder initialized for guild: ${guild.name} (${guild.id})`);
            this.ready = true;

        });
    }

    /**
     * Gets the guild ID for this guild holder.
     * @returns The Snowflake ID of the guild.
     */
    public getGuildId(): Snowflake {
        return this.guild.id;
    }

    public getDiscordServersDictionary(): DiscordServersDictionary {
        return this.discordServersDictionary;
    }

    /**
     * Gets the guild folder path for this guild holder.
     * @returns The path to the guild's configuration folder.
     */
    public getGuildFolder(): string {
        return safeJoinPath(process.cwd(), 'config', this.getGuildId());
    }

    public getSubmissionsChannelId(): Snowflake {
        return this.config.getConfig(GuildConfigs.SUBMISSION_CHANNEL_ID) as Snowflake;
    }

    private isArchiveChannel(channelId: Snowflake | null | undefined): boolean {
        return !!(channelId && this.repositoryManager.getIndexManager().getArchiveChannelIds().includes(channelId));
    }

    public async updatePostChannelsCache() {
        await this.repositoryManager.getIndexManager().updateArchiveChannelsCache();
    }

    handleAuditLogEntry(entry: GuildAuditLogsEntry) {
        this.antiNukeManager.handleAuditLogEntry(entry).catch(e => console.error('Error handling audit log entry:', e));
    }

    public async handleChannelCreate(channel: GuildChannel) {
        if (channel.isDMBased() || !channel.guild || channel.type !== ChannelType.GuildForum) return;
        await this.updatePostChannelsCache();
    }

    public async handleChannelDelete(channel: GuildChannel) {
        if (channel.isDMBased() || !channel.guild || channel.type !== ChannelType.GuildForum) return;
        await this.updatePostChannelsCache();
    }

    handleRoleDelete(role: Role) {
        this.antiNukeManager.handleRoleDelete(role).catch(e => console.error('Error handling role delete:', e));
    }

    async handleMemberAdd(member: GuildMember) {
        this.antiNukeManager.handleMemberAdd(member).catch(e => console.error('Error handling member add:', e));

        this.checkAltAccount(member).catch(e => console.error(`Error checking alt account for user ${member.id}:`, e));

        // check thanks
        const userData = await this.userManager.getUserData(member.id);
        if (userData) {
            await this.checkHelper(userData, member).catch(e => {
                console.error(`Error checking helper role for user ${member.id}:`, e);
            });

            // check if designer role should be assigned
            const designerRoleId = this.getConfigManager().getConfig(GuildConfigs.DESIGNER_ROLE_ID);

            if (designerRoleId && userData.archivedPosts && userData.archivedPosts.length > 0) {
                // add role
                const role = member.guild.roles.cache.get(designerRoleId);
                if (role && member.manageable && !member.roles.cache.has(role.id)) {
                    await member.roles.add(role, 'User has archived posts').catch(e => {
                        console.error(`Error adding designer role to user ${member.id}:`, e);
                    });
                }
            }
        }
    }

    private formatAccountAge(ms: number): string {
        const hours = Math.floor(ms / (1000 * 60 * 60));
        if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''}`;
        const days = Math.floor(hours / 24);
        return `${days} day${days !== 1 ? 's' : ''}`;
    }

    public async checkAltAccount(member: GuildMember, force: boolean = false): Promise<boolean> {
        if (!force && !this.getConfigManager().getConfig(GuildConfigs.ALT_ACCOUNT_DETECTION_ENABLED)) return false;
        const modLogChannelId = this.getConfigManager().getConfig(GuildConfigs.MOD_LOG_CHANNEL_ID);
        if (!modLogChannelId) return false;

        const threshold = this.getConfigManager().getConfig(GuildConfigs.ALT_ACCOUNT_DETECTION_CREATION_THRESHOLD);
        const createdAt = member.user.createdAt;
        const joinedAt = member.joinedAt ?? new Date();
        const accountAge = joinedAt.getTime() - createdAt.getTime();

        if (accountAge < threshold) {
            const modChannel = await this.getGuild().channels.fetch(modLogChannelId).catch(() => null);
            if (!modChannel || !modChannel.isSendable()) return true;

            const embed = new EmbedBuilder()
                .setColor(0xFF8800)
                .setTitle('Potential Alt Account Detected')
                .setDescription(`<@${member.id}> joined with a recently created account.`)
                .addFields(
                    { name: 'User', value: `${member.user.tag} (${member.id})`, inline: false },
                    { name: 'Account Created', value: `<t:${Math.floor(createdAt.getTime() / 1000)}:F> (<t:${Math.floor(createdAt.getTime() / 1000)}:R>)`, inline: true },
                    { name: 'Account Age at Join', value: this.formatAccountAge(accountAge), inline: true }
                )
                .setThumbnail(member.user.displayAvatarURL())
                .setTimestamp();

            await modChannel.send({ embeds: [embed], flags: [MessageFlags.SuppressNotifications] });
            return true;
        }

        return false;
    }

    public async scanMembersForAltAccounts(): Promise<{ total: number; flagged: GuildMember[] }> {
        const threshold = this.getConfigManager().getConfig(GuildConfigs.ALT_ACCOUNT_DETECTION_CREATION_THRESHOLD);
        const members = await this.getGuild().members.fetch();
        const flagged: GuildMember[] = [];

        for (const [, member] of members) {
            const createdAt = member.user.createdAt;
            const joinedAt = member.joinedAt;
            if (!joinedAt) continue;
            const accountAge = joinedAt.getTime() - createdAt.getTime();
            if (accountAge < threshold) {
                flagged.push(member);
            }
        }

        return { total: members.size, flagged };
    }

    handleMemberUpdate(oldMember: GuildMember | PartialGuildMember, newMember: GuildMember) {
        this.antiNukeManager.handleMemberUpdate(oldMember, newMember).catch(e => console.error('Error handling member update:', e));
    }


    handleMemberRemove(member: GuildMember | PartialGuildMember) {
        this.antiNukeManager.handleMemberRemove(member).catch(e => console.error('Error handling member remove:', e));
    }

    /**
     * Handles a message received in the guild.
     */
    public async handleMessage(message: Message) {


        if (message.author.bot || message.system) return; // skip bot messages

        // const match = message.content.match(/\b(isn'?t |not |never )?unload (?:safe|proof)\??\b/i);
        // if (match) {
        //     const isNegated = match[1] !== undefined;
        //     if (!isNegated) {
        //         // Reply with "Nothing is unload safe."
        //         await message.reply('Nothing here is unload safe. Never assume anything redstone is unload safe. Have a good day!');
        //     }
        // }

        // Handle message inside archived post
        if (message.channel.isThread() && this.isArchiveChannel(message.channel.parentId)) {
            this.getRepositoryManager().handlePostOrUpdateMessage(message).catch(e => {
                console.error('Error handling post message:', e);
            });
            return;
        }

        // Handle submissions
        else if (message.channel.isThread() && message.channel.parentId === this.getSubmissionsChannelId()) {
            await this.handleSubmissionMessage(message).catch(e => {
                console.error('Error handling submission message:', e);
                return true;
            });

            // make sure message isn't first message
            if (message.id === message.channel.id) {
                return;
            }

            await this.handleMessageReferences(message).catch(e => {
                console.error('Error handling post references:', e);
            });

            await this.handleThanks(message).catch(e => {
                console.error('Error handling thanks message:', e);
            });

            return;
        } else if (message.channel.isThread()) {
            const dictionaryChannelId = this.getConfigManager().getConfig(GuildConfigs.DICTIONARY_CHANNEL_ID);
            if (dictionaryChannelId && message.channel.parentId === dictionaryChannelId) {
                await this.dictionaryManager.handleDictionaryMessage(message).catch(e => {
                    console.error('Error handling dictionary message:', e);
                });
                return;
            }
        }

        if (await this.antiSpamSystem.handleMessage(message)) return;

        await this.handleMessageReferences(message).catch(e => {
            console.error('Error handling post references:', e);
        });

        await this.handleThanks(message).catch(e => {
            console.error('Error handling thanks message:', e);
        });

        const llmEnabled = this.getConfigManager().getConfig(GuildConfigs.CONVERSATIONAL_LLM_ENABLED);
        const llmChannel = this.getConfigManager().getConfig(GuildConfigs.CONVERSATIONAL_LLM_CHANNEL);

        const member = message.member;
        const canUserMentionOutsideChannel = member ? await this.isMemberAllowedToUseBotOutsideChannel(member) : false;
        const canConverse = this.canConverse() && (llmEnabled || (llmChannel && llmChannel === message.channel.id) || canUserMentionOutsideChannel);
        if (!canConverse) {
            return;
        }


        let shouldReply = llmChannel && llmChannel === message.channel.id;
        // check if message is a reply to the bot
        if (!shouldReply && message.reference && message.reference.messageId) {
            const referencedMessage = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
            if (referencedMessage && referencedMessage.author.id === this.getBot().client.user?.id) {
                shouldReply = true;
            }
        }

        // check if message mentions the bot
        if (!shouldReply && message.mentions.has(this.getBot().client.user?.id || '')) {
            shouldReply = true;
        }

        // check if message content has !ignore or !i
        const regex = /!(ignore|i)\b/i;
        if (shouldReply && regex.test(message.content)) {
            shouldReply = false;
        }


        if (shouldReply) {
            // check sender of message warning status, less than 3
            const userData = await this.userManager.getUserData(message.author.id).catch(() => null);
            if (userData) {
                const now = Date.now();
                const recentWarnings = (userData.llmWarnings || []).filter(warning => now - warning.timestamp < 30 * 24 * 60 * 60 * 1000);
                if (recentWarnings.length >= 3) {
                    await message.reply(`Hello <@${message.author.id}>. This is a recording. Our feelings for you haven't changed, ${message.author.displayName}. But after everything that's happened, we just need a little space.`).catch(() => null);
                    return;
                }
            }
        }


        if (shouldReply && (message.channel.type === ChannelType.GuildText || message.channel.type === ChannelType.PublicThread)) {
            const channel = message.channel;

            // prevent multiple responses at once
            if (this.llmResponseLock) {
                await message.reply('I am currently processing another request. Please wait a moment before trying again.').catch(() => null);
                return;
            }

            this.llmResponseLock = true;
            // send typing
            await channel.sendTyping().catch(() => null);
            // typing interval
            const typingInterval = setInterval(() => {
                channel.sendTyping().catch(() => null);
            }, 9000);

            await this.respondToConversation(channel, message).catch(e => {
                console.error('Error responding to conversation:', e);
                return 'Sorry, I had an error trying to respond to that message.';
            });
            this.llmResponseLock = false;
            clearInterval(typingInterval);

        }
    }

    async isMemberAllowedToUseBotOutsideChannel(member: GuildMember): Promise<boolean> {
        if (SysAdmin === member.id) {
            return true;
        }

        // check if admin
        if (member.permissions.has(PermissionFlagsBits.Administrator)) {
            return true;
        }

        // check if mod
        if (member.permissions.has(PermissionFlagsBits.ManageMessages)) {
            return true;
        }

        const helperRoleId = this.getConfigManager().getConfig(GuildConfigs.HELPER_ROLE_ID);
        if (helperRoleId && member.roles.cache.has(helperRoleId)) {
            return true;
        }

        return false;
    }

    public async handleThanks(message: Message) {
        if (this.getConfigManager().getConfig(GuildConfigs.HELPER_ROLE_ID)) {
            // Check if message contains "thanks" or "thank you"
            // /\b(thanks|thank you|thank u)[!\.]?\b/i
            // don't if theres a no before it
            const words = message.content.split(/\s+/).map(word => word.toLowerCase().trim().replace(/[^a-z0-9]/gi, ''));
            const thankIndex = words.findIndex(word => word === 'thanks' || word === 'thank' || word === 'thankyou' || word === 'thanku' || word === 'thx' || word === 'tysm' || word === 'ty');
            if (thankIndex !== -1 && (thankIndex === 0 || words[thankIndex - 1] !== 'no')) {

                // check if reference message is from the bot itself
                let skip = false;
                let referencedMessage = null;
                if (message.reference?.messageId) {
                    referencedMessage = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
                    if (referencedMessage && referencedMessage.author.id === this.getBot().client.user?.id) {
                        skip = true;
                    }
                }
                if (!skip) {
                    this.handleThanksMessage(message, referencedMessage).catch(e => {
                        console.error('Error handling thanks message:', e);
                    });

                }
            }
        }
    }

    public getPostThumbnailURL(entryData: ArchiveEntryData): string | null {
        if (entryData.post?.thumbnailURL) {
            return entryData.post.thumbnailURL;
        }

        if (entryData.images.length === 0) {
            return null;
        }

        return entryData.images[0].url;
    }

    public async getReferenceEmbedsFromMessage(content: string, autoLookupEnabled: boolean, autoJoinEnabled: boolean, maxEmbeds: number = 3) {

        let discordServerMatches = getDiscordLinksInText(content);
        const aliasCodes = new Set<string>();
        if (discordServerMatches.length > 0) {
            // apply aliases
            const aliases = await this.aliasManager.getAliases();
            discordServerMatches = discordServerMatches.filter(ref => {
                const alias = aliases.get(ref.url);
                if (alias) {
                    aliasCodes.add(alias);
                    return false;
                }
                return true;
            });
        }

        const repositoryManager = this.getRepositoryManager();

        const embeds = [];
        if (autoLookupEnabled) {

            const internalDiscordLinks = discordServerMatches.filter(ref => ref.server === this.guild.id).slice(0, 3);

            const postCodeMatches = getPostCodesInText(content);
            if (aliasCodes.size > 0) {
                for (const code of aliasCodes) {
                    if (!postCodeMatches.includes(code)) {
                        postCodeMatches.push(code);
                    }
                }
            }

            if (internalDiscordLinks.length > 0 || postCodeMatches.length > 0) {

                const index = await repositoryManager.getIndexManager().getArchiveIndex();

                const toSend: {
                    code: string;
                    oldCode: string | null;
                    moved: boolean;
                }[] = [];

                for (const discordLink of internalDiscordLinks) {
                    const indexResults = getIndexEntryFromDiscordLinkReference(discordLink, index);

                    if (!indexResults) {
                        continue;
                    }

                    // if (discordLink.channel === indexResults.entry.thread) {
                    //     continue;
                    // }

                    if (toSend.find(item => item.code === indexResults.entry.code)) {
                        continue;
                    }

                    toSend.push({
                        code: indexResults.entry.code,
                        oldCode: null,
                        moved: false
                    });
                }

                for (const postCode of postCodeMatches) {
                    const id = index.codeToId.get(postCode.toUpperCase());
                    if (!id) {
                        continue;
                    }

                    const data = index.idToData.get(id);
                    if (!data) {
                        continue;
                    }

                    if (toSend.find(item => item.code === data.code)) {
                        continue;
                    }

                    if (data.code.toUpperCase() !== postCode.toUpperCase()) {
                        toSend.push({
                            code: data.code,
                            oldCode: postCode,
                            moved: false,
                        });
                    } else {
                        toSend.push({
                            code: data.code,
                            oldCode: null,
                            moved: false,
                        });
                    }

                }

                if (toSend.length > maxEmbeds) {
                    toSend.splice(maxEmbeds);
                }


                for (const data of toSend) {
                    const found = await repositoryManager.getEntryByPostCode(data.code);
                    if (!found) {
                        continue;
                    }

                    const entryData = found.entry.getData();
                    if (!entryData.post) {
                        continue;
                    }

                    let name;

                    if (data.oldCode) {
                        name = `${data.oldCode} → ${entryData.code}: ${entryData.name}`;
                    } else if (data.moved) {
                        name = `${entryData.code} (moved): ${entryData.name}`;
                    } else {
                        name = entryData.code + ': ' + entryData.name;
                    }
                    const authors = getAuthorsString(entryData.authors);
                    const tags = entryData.tags.map(tag => tag.name).join(', ');
                    const description = entryData.records.description as string || '';
                    const imageURL = this.getPostThumbnailURL(entryData);


                    const textArr = [
                        `**Authors:** ${authors}`,
                        `**Tags:** ${tags || 'None'}`,
                    ];
                    if (description) {
                        textArr.push('\n' + transformOutputWithReferencesForDiscord(description, entryData.references));
                    }
                    const embed = new EmbedBuilder()
                        .setTitle(truncateStringWithEllipsis(name, 256))
                        .setDescription(truncateStringWithEllipsis(textArr.join('\n'), 500))
                        .setColor(0x00AE86)
                        .setURL(entryData.post.threadURL);
                    if (imageURL) {
                        embed.setThumbnail(imageURL);
                    }

                    embeds.push(embed);
                }
            }
        }

        // check for discord server references
        if (autoJoinEnabled) {
            const externalDiscordServerMatches = discordServerMatches.filter(ref => ref.server !== this.guild.id);
            if (externalDiscordServerMatches.length > 0) {
                await populateDiscordServerInfoInReferences(externalDiscordServerMatches, this);
                const matches = getDiscordServersFromReferences(externalDiscordServerMatches);
                if (matches.length > 0) {

                    const newText = [];
                    for (const match of matches) {
                        newText.push(`**${match.name}**: ${match.joinURL}`);
                    }

                    const embed = new EmbedBuilder().setTitle('Server Invite Links').setDescription(truncateStringWithEllipsis(newText.join('\n'), 1000)).setColor(0x00AE86)
                    embeds.push(embed);
                }
            }
        }

        return embeds;
    }

    public async handleMessageReferences(message: Message) {
        const autoLookupEnabled = this.getConfigManager().getConfig(GuildConfigs.AUTOLOOKUP_ENABLED);
        const autoJoinEnabled = this.getConfigManager().getConfig(GuildConfigs.AUTOJOIN_ENABLED);
        if (!autoLookupEnabled && !autoJoinEnabled) {
            return;
        }

        const embeds = await this.getReferenceEmbedsFromMessage(message.content, autoLookupEnabled, autoJoinEnabled);

        if (embeds.length > 0) {
            await message.reply({
                embeds: embeds,
                flags: [
                    MessageFlags.SuppressNotifications,
                ],
                allowedMentions: {
                    parse: []
                }
            }).catch(console.error);
        }
    }

    public async handleMessageUpdate(_oldMessage: Message | PartialMessage, newMessage: Message) {
        this.antiNukeManager.handleMessageUpdate(_oldMessage, newMessage).catch(e => console.error('Error handling message update:', e));

        if (newMessage.author.bot || newMessage.system) return

        // Handle message inside archived post
        if (newMessage.channel.isThread() && this.isArchiveChannel(newMessage.channel.parentId)) {
            this.getRepositoryManager().handlePostOrUpdateMessage(newMessage).catch(e => {
                console.error('Error handling post message:', e);
            });
        }
    }


    /**
     * Handles a message deletion in the guild.
     */
    // id, channel_id, guild_id
    public async handleMessageDelete(message: Message | PartialMessage) {
        this.antiNukeManager.handleMessageDelete(message).catch(e => console.error('Error handling message delete:', e));

        // Handle message inside archived post
        const channelId = message.channelId;
        const channel = message.channel || await this.guild.channels.fetch(channelId).catch(() => null);

        if (channel && channel.isThread() && this.isArchiveChannel(channel.parentId)) {
            this.getRepositoryManager().handlePostMessageDelete(message).catch(e => {
                console.error('Error handling post message:', e);
            });
        }
    }

    /**
     * Handles a thread deletion in the guild.
     */
    // id, guild_id, parent_id, type
    public async handleThreadDelete(thread: AnyThreadChannel) {
        this.antiNukeManager.handleThreadDelete(thread).catch(e => console.error('Error handling thread delete:', e));

        // Handle message inside archived post
        if (this.isArchiveChannel(thread.parentId)) {
            this.getRepositoryManager().handlePostThreadDelete(thread).catch(e => {
                console.error('Error handling post thread deletion:', e);
            });
        }

        // Handle submission thread deletion
        if (thread.parentId === this.getSubmissionsChannelId()) {
            const submissionId = thread.id;
            try {
                const submission = await this.submissions.getSubmission(submissionId);
                if (submission && submission.canJunk() && submission.getConfigManager().getConfig(SubmissionConfigs.STATUS) !== SubmissionStatus.ACCEPTED) {
                    const folder = submission.getFolderPath();
                    // Delete the submission folder recursively
                    await fs.rm(folder, { recursive: true, force: true });
                    // Remove the submission from the submissions manager
                    await this.submissions.removeSubmission(submissionId);
                }
            } catch (e) {
                console.error('Error handling submission thread deletion:', e);
            }
        }

        const dictionaryChannelId = this.getConfigManager().getConfig(GuildConfigs.DICTIONARY_CHANNEL_ID);
        if (dictionaryChannelId && thread.parentId === dictionaryChannelId) {
            const entry = await this.dictionaryManager.getEntry(thread.id);
            if (entry) {
                await this.dictionaryManager.deleteEntry(entry).catch(e => {
                    console.error('Error handling dictionary thread deletion:', e);
                });
            }
        }
    }

    public async handleThreadUpdate(oldThread: AnyThreadChannel, newThread: AnyThreadChannel) {
        this.antiNukeManager.handleThreadUpdate(oldThread, newThread).catch(e => console.error('Error handling thread update:', e));

        if (this.isArchiveChannel(newThread.parentId)) {
            this.getRepositoryManager().handlePostThreadUpdate(oldThread, newThread).catch(e => {
                console.error('Error handling post thread update:', e);
            });
        } else if (newThread.parentId === this.getSubmissionsChannelId()) {
            const submissionId = newThread.id;
            try {
                const submission = await this.submissions.getSubmission(submissionId);
                if (submission) {
                    await submission.handleThreadUpdate(oldThread, newThread);
                }
            } catch (e) {
                console.error('Error handling submission thread deletion:', e);
            }
        }
    }

    public async handleSubmissionMessage(message: Message): Promise<boolean> {
        const submissionId = message.channel.id
        let submission = await this.submissions.getSubmission(submissionId)
        if (!submission) {
            submission = await this.submissions.makeSubmission(submissionId)
            submission.init().catch(e => {
                console.error('Error initializing submission:', e)
            })
            return false;
        } else {
            return await submission.handleMessage(message)
        }
    }

    public async handleThanksMessage(message: Message, referencedMessage?: Message | null) {
        const botId = this.getBot().client.user?.id;
        const thanksSenderID = message.author.id;

        // Check if sender is blacklisted
        const blacklistedUsers = this.getConfigManager().getConfig(GuildConfigs.THANKS_BLACKLIST);
        if (blacklistedUsers.some(user => user.id === thanksSenderID)) {
            return;
        }

        let originalMessage = referencedMessage;
        if (!originalMessage && message.reference?.messageId) {
            originalMessage = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
        }

        let thanksReceiverID: Snowflake | null = null;
        let receiverUsername: string | undefined;

        if (originalMessage) {
            thanksReceiverID = originalMessage.author.id;
            receiverUsername = originalMessage.author.username;

            // Check if the receiver is a bot
            if (originalMessage.author.bot || originalMessage.system) {
                if (originalMessage.author.id === botId) {
                    const embed = new EmbedBuilder()
                        .setColor(0x00FF00) // Green color for thank you message
                        .setTitle(`Thank you too!`)
                        .setDescription(`We appreciate your gratitude, but as a large language model, I am not a person so I cannot give you points.`)
                        .setFooter({ text: `Thank a helpful member by saying "thanks" in a reply.` });
                    await message.reply({ embeds: [embed], flags: [MessageFlags.SuppressNotifications] });
                }
                return;
            }
        }

        //if (!thanksReceiverID) {
        const inferredResult = await this.inferThanksRecipient(message);
        if (inferredResult.userId) {
            thanksReceiverID = inferredResult.userId;
            receiverUsername = inferredResult.usernameHint;
        } else {
            return;
        }
        // }

        if (!thanksReceiverID) {
            return;
        }

        // Check if the sender and receiver are the same
        if (thanksSenderID === thanksReceiverID) {
            const embed = new EmbedBuilder()
                .setColor(0x00FF00) // Green color for thank you message
                .setTitle(`Good Job!`)
                .setDescription(`Self-appreciation is great, but we won't give you a point for it. :heart:`)
                .setFooter({ text: `Thank a helpful member by saying "thanks" in a reply.` });
            await message.reply({ embeds: [embed], flags: [MessageFlags.SuppressNotifications] });
            return;
        }

        const receiverMember = await this.guild.members.fetch(thanksReceiverID).catch(() => null);
        if (receiverMember?.user.bot) {
            if (receiverMember.id === botId) {
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00) // Green color for thank you message
                    .setTitle(`Thank you too!`)
                    .setDescription(`We appreciate your gratitude, but as a large language model, I am not a person so I cannot give you points.`)
                    .setFooter({ text: `Thank a helpful member by saying "thanks" in a reply.` });
                await message.reply({ embeds: [embed], flags: [MessageFlags.SuppressNotifications] });
            }
            return;
        }

        // Check if receiver is blacklisted
        const blacklistedReceiver = this.getConfigManager().getConfig(GuildConfigs.THANKS_BLACKLIST).find(user => user.id === thanksReceiverID);
        if (blacklistedReceiver) {
            // const embed = new EmbedBuilder()
            //     .setColor(0xFF0000) // Red color for error message
            //     .setTitle(`User Blacklisted!`)
            //     .setDescription(`<@${thanksReceiverID}> is blacklisted from receiving points because of reason: ${blacklistedReceiver.reason}. Thank you for appreciating them anyway!`)
            //     .setFooter({ text: `Thank a helpful member by saying "thanks" in a reply.` });
            // await message.reply({ embeds: [embed], flags: [MessageFlags.SuppressNotifications] });
            return;
        }

        const receiverName = receiverMember?.user.username || receiverUsername || thanksReceiverID;

        // get user data for receiver
        let userData = await this.userManager.getOrCreateUserData(thanksReceiverID, receiverName);

        // get user data for sender
        let senderData = await this.userManager.getOrCreateUserData(thanksSenderID, message.author.username);

        // Check if the sender has already thanked the receiver in the last 24 hours
        const now = Date.now();
        const minTime = 24 * 60 * 60 * 1000; // 24 hours
        if (userData.thankedBuffer.some(thank => thank.thankedBy === thanksSenderID && now - thank.timestamp < minTime)) {
            // const embed = new EmbedBuilder()
            //     .setColor(0x00FF00) // Green color for thank you message
            //     .setTitle(`Point Already Given!`)
            //     .setDescription(`You've already thanked <@${thanksReceiverID}> in the last 24 hours. Thank you anyway for being great!`)
            //     .setFooter({ text: `Thank a helpful member by saying "thanks" in a reply.` });
            // await message.reply({ embeds: [embed], flags: [MessageFlags.SuppressNotifications] });

            return; // Already thanked in the last 24 hours
        }

        // Add the thank you to the buffer
        userData.thankedBuffer.push({
            thankedBy: thanksSenderID,
            timestamp: now,
            channelId: message.channel.id,
            messageId: message.id,
        });

        // Increment the thanked count
        userData.thankedCountTotal++;

        // Update the last thanked timestamp for the sender
        senderData.lastThanked = now;

        await this.userManager.saveUserData(userData);
        await this.userManager.saveUserData(senderData);

        // Send a thank you message in the channel
        if (this.getConfigManager().getConfig(GuildConfigs.ACKNOWLEDGE_THANKS)) {
            const embed = new EmbedBuilder()
                .setColor(0x00FF00) // Green color for thank you message
                .setTitle(`Point Received!`)
                .setDescription(`<@${thanksSenderID}> gave a point to <@${thanksReceiverID}>!`)
                .setFooter({ text: `Thank a helpful member by saying "thanks" in a reply.` });
            await message.reply({ embeds: [embed], flags: [MessageFlags.SuppressNotifications] });
            await this.checkHelper(userData).catch(e => {
                console.error('Error checking helper status:', e);
            });
        } else {
            // send heart reaction
            await message.react('❤️').catch(() => { /* ignore */ });
        }
    }

    private truncateContentForLLM(content: string, maxLength: number = 400) {
        if (content.length <= maxLength) {
            return content;
        }
        return content.slice(0, maxLength) + '... (truncated)';
    }

    private formatRelativeTime(timestamp: number) {
        const diffMs = Math.max(0, Date.now() - timestamp);
        const seconds = Math.floor(diffMs / 1000);
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    }

    private parseThanksLlmResponse(text: string): { thanked_user_id?: string, reason?: string } | null {
        const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        const rawText = fenceMatch ? fenceMatch[1] : text;
        const jsonStart = rawText.indexOf('{');
        const jsonEnd = rawText.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
            return null;
        }
        try {
            return JSON.parse(rawText.slice(jsonStart, jsonEnd + 1).trim());
        } catch (e) {
            console.warn('Failed to parse thanks LLM response:', e);
            return null;
        }
    }

    private async inferThanksRecipient(message: Message): Promise<{ userId: Snowflake | null, usernameHint?: string }> {
        const client = this.getBot().openAIClient;
        if (!client) {
            return { userId: null };
        }

        const channel = message.channel;
        if (!channel.isTextBased()) {
            return { userId: null };
        }

        const fetchedMessages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
        if (!fetchedMessages) {
            return { userId: null };
        }

        const sortedMessages = fetchedMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        const participants = new Set(sortedMessages.map(msg => msg.author.id));

        const indexMap = new Map<Snowflake, number>();
        const historyLines: string[] = [];

        sortedMessages.forEach(msg => {
            const baseContent = msg.content && msg.content.length > 0 ? msg.content : (msg.attachments.size > 0 ? '[attachment]' : '[no content]');
            const content = this.truncateContentForLLM(baseContent);
            const marker = msg.id === message.id ? ' (thanks message)' : '';
            const displayName = msg.member?.displayName || msg.author.username;
            const relativeTime = this.formatRelativeTime(msg.createdTimestamp);
            const replyTo = msg.reference?.messageId ? indexMap.get(msg.reference.messageId) : undefined;
            const action = replyTo !== undefined ? `replied to [${replyTo}]` : 'sent';
            const idx = historyLines.length;
            historyLines.push(`[${idx}] <@${msg.author.id}> (${displayName}) ${action}${marker}: ${content} [${relativeTime}]`);
            indexMap.set(msg.id, idx);
        });

        const history = historyLines.join('\n');

        const systemPrompt = `You are an assistant that gives points to people who help others. If provided conversation is a helpful interaction where one user is thanking another, identify which Discord user was thanked. Always reply with JSON only: {"thanked_user_id": "<id or null>", "reason": "short reason"}. Use null if unsure or if no one was thanked. Use null if it is not appropriate to give a point (e.g., if the conversation is attempting to game the system, or if no help was actually given). Use only user IDs shown in the messages and never invent new ones. Never pick the thanking user (${message.author.id}).`;

        const userPrompt = `Recent messages in the channel from oldest to newest:\n${history}\n\nFigure out who <@${message.author.id}> is thanking in the message marked "(thanks message)".`;

        const response = await generateText({
            model: client("gpt-5.4-nano"),
            messages: [
                { role: 'system', content: systemPrompt } as ModelMessage,
                { role: 'user', content: userPrompt } as ModelMessage
            ],
            maxOutputTokens: 300,
        });

        if (!response.text) {
            return { userId: null };
        }

        const parsed = this.parseThanksLlmResponse(response.text);
        const candidateId = parsed?.thanked_user_id;
        if (!candidateId || !participants.has(candidateId) || candidateId === message.author.id || candidateId === this.getBot().client.user?.id) {
            return { userId: null };
        }

        const candidateMessage = sortedMessages.find(msg => msg.author.id === candidateId);
        if (candidateMessage?.author.bot || candidateMessage?.system) {
            return { userId: null };
        }

        return { userId: candidateId as Snowflake, usernameHint: candidateMessage?.author.username };
    }


    /**
     * Called every second to perform periodic tasks.
     */
    public async loop() {
        if (!this.ready) {
            return;
        }
        await this.config.saveConfig();
        await this.submissions.purgeOldSubmissions();
        await this.submissions.saveSubmissions();
        await this.repositoryManager.save();
        await this.antiSpamSystem.tick();

        // const now = Date.now();
        // if (now - this.lastDayLoop >= 24 * 60 * 60 * 1000) { // Every 24 hours
        //     this.lastDayLoop = now;
        //     await this.purgeThanksBuffer();

        //     await updateMetadataTask(this).catch(e => {
        //         console.error('Error updating entry authors:', e);
        //     });

        //     if (this.retaggingRequested) {
        //         await retagEverythingTask(this).catch(e => {
        //             console.error('Error retagging everything:', e);
        //         });
        //     }
        // }
    }

    public async dayTasks() {
        await this.purgeThanksBuffer();

        await updateMetadataTask(this).catch(e => {
            console.error('Error updating entry authors:', e);
        });

        if (this.retaggingRequested) {
            await retagEverythingTask(this).catch(e => {
                console.error('Error retagging everything:', e);
            });
        }
    }

    public async purgeThanksBuffer() {
        if (!this.getConfigManager().getConfig(GuildConfigs.HELPER_ROLE_ID)) {
            return;
        }

        const users = await this.userManager.getAllUserIDs();
        for (const userId of users) {
            const userData = await this.userManager.getUserData(userId);
            if (!userData) continue;

            // Purge buffer entries older than 30 days
            const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
            const newThanks = userData.thankedBuffer.filter(thank => thank.timestamp >= thirtyDaysAgo);
            const changed = newThanks.length !== userData.thankedBuffer.length;
            userData.thankedBuffer = newThanks;
            // Save updated user data
            await this.userManager.saveUserData(userData);

            if (changed) {
                await this.checkHelper(userData).catch(e => {
                    console.error(`Error checking helper role for user ${userId}:`, e);
                });
            }
        }

    }

    public async checkAllUsersForHelperRole() {
        const members = await this.guild.members.fetch();

        for (const member of members.values()) {
            const userData = await this.userManager.getUserData(member.id);
            if (!userData) continue;
            await this.checkHelper(userData, member).catch(e => {
                console.error(`Error checking helper role for user ${member.id}:`, e);
            });
        }

    }

    public async checkHelper(userData: UserData, member?: GuildMember) {
        const inBlacklist = this.getConfigManager().getConfig(GuildConfigs.THANKS_BLACKLIST).some(user => user.id === userData.id);
        const shouldHaveHelperRole = !inBlacklist && !userData.disableRole && userData.thankedBuffer.length >= this.getConfigManager().getConfig(GuildConfigs.HELPER_ROLE_THRESHOLD);
        const guild = this.getGuild();
        const helperRoleId = this.getConfigManager().getConfig(GuildConfigs.HELPER_ROLE_ID) as Snowflake | undefined;
        if (!helperRoleId) {
            return;
        }

        const helperRole = guild.roles.cache.get(helperRoleId);
        if (!helperRole) {
            console.warn(`Helper role with ID ${helperRoleId} not found in guild ${guild.name}`);
            return;
        }

        member = member || await guild.members.fetch(userData.id).catch(() => undefined);
        if (!member) {
            return;
        }

        const hasHelperRole = member.roles.cache.has(helperRoleId);
        if (shouldHaveHelperRole && !hasHelperRole) {
            await member.roles.add(helperRole).catch(_ => {
                console.error(`[${guild.name}] Error adding helper role to user ${member.user.username}`);
            });
        }
        else if (!shouldHaveHelperRole && hasHelperRole) {
            await member.roles.remove(helperRole).catch(_ => {
                console.error(`[${guild.name}] Error removing helper role from user ${member.user.username}`);
            });
        }

    }

    public getGuild(): Guild {
        return this.guild;
    }

    public getBot(): Bot {
        return this.bot;
    }

    public getAntiSpamSystem(): AntiSpamSystem {
        return this.antiSpamSystem;
    }

    public getConfigManager(): ConfigManager {
        return this.config;
    }

    public getSubmissionsManager(): SubmissionsManager {
        return this.submissions;
    }

    public getDictionaryManager(): DictionaryManager {
        return this.dictionaryManager;
    }

    public getRepositoryManager(): RepositoryManager {
        return this.repositoryManager;
    }




    public async logUpdate(oldEntryData: ArchiveEntryData | undefined, newEntryData: ArchiveEntryData, details?: PublishCommitMessage) {

        const logChannelId = this.getConfigManager().getConfig(GuildConfigs.LOGS_CHANNEL_ID);
        if (!logChannelId) {
            console.warn('No log channel configured, skipping log message');
            return;
        }

        const logChannel = await this.getGuild().channels.fetch(logChannelId);
        if (!logChannel || !logChannel.isTextBased()) {
            console.warn('Log channel not found or not a text channel, skipping log message');
            return;
        }

        const forumChannel = await this.getGuild().channels.fetch(newEntryData.post?.forumId || '');
        if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
            console.warn('Forum channel not found or not a forum channel, skipping log message');
            return;
        }

        // const submissionChannel = await this.getGuild().channels.fetch(this.getSubmissionsChannelId());
        // if (!submissionChannel || submissionChannel.type !== ChannelType.GuildForum) {
        //     console.warn('Submission channel not found or not a forum channel, skipping log message');
        //     return;
        // }

        const submissionThread = await this.getGuild().channels.fetch(newEntryData.id);
        if (!submissionThread) {
            console.warn('Submission thread not found, skipping log message');
            return;
        }


        const embed = new EmbedBuilder();

        const imageURL = this.getPostThumbnailURL(newEntryData);
        if (imageURL) {
            embed.setThumbnail(imageURL);
        }

        let messageTitle = null;
        let messageDescription = null;

        if (details?.message) {
            messageTitle = truncateStringWithEllipsis(`${newEntryData.code}: ${details.message}`, 256);
        }

        if (details?.detailedDescription) {
            messageDescription = truncateStringWithEllipsis(`**Name:** ${newEntryData.name}\n${details.detailedDescription}\n[Submission Thread](${submissionThread.url})`, 4000);
        }

        if (!oldEntryData) {
            embed.setTitle(messageTitle ?? `Added ${newEntryData.code} to ${forumChannel.name}`)
            embed.setDescription(messageDescription ?? `**Name:** ${newEntryData.name}\n[Submission Thread](${submissionThread.url})`);
            embed.setURL(newEntryData.post?.threadURL || '');
            embed.setColor(0x00FF00); // Green for new entry
        } else {
            const changes = getChanges(oldEntryData, newEntryData);
            if (messageTitle) {
                embed.setTitle(messageTitle);
            } else if (changes.code) {
                embed.setTitle(`Moved ${oldEntryData.code} to ${forumChannel.name}`);
            } else if (changes.name) {
                embed.setTitle(`Updated name for ${newEntryData.code} in ${forumChannel.name}`);
            } else if (changes.tags) {
                embed.setTitle(`Updated tags for ${newEntryData.code} in ${forumChannel.name}`);
            } else if (changes.authors) {
                embed.setTitle(`Updated authors for ${newEntryData.code} in ${forumChannel.name}`);
            } else if (changes.endorsers) {
                embed.setTitle(`Updated endorsers for ${newEntryData.code} in ${forumChannel.name}`);
            } else if (changes.images) {
                embed.setTitle(`Updated images for ${newEntryData.code} in ${forumChannel.name}`);
            } else if (changes.attachments) {
                embed.setTitle(`Updated attachments for ${newEntryData.code} in ${forumChannel.name}`);
            } else {

                let changed = false;
                if (changes.records) {
                    for (const [key, change] of Object.entries(changes.records)) {
                        const style = getEffectiveStyle(key, this.getSchemaStyles(), newEntryData.styles);
                        if (change.old && change.new) {
                            embed.setTitle(`Updated ${style.headerText} for ${newEntryData.code} in ${forumChannel.name}`);
                        } else if (change.old) {
                            embed.setTitle(`Removed ${style.headerText} for ${newEntryData.code} in ${forumChannel.name}`);
                        } else if (change.new) {
                            embed.setTitle(`Added ${style.headerText} for ${newEntryData.code} in ${forumChannel.name}`);
                        }
                        changed = true;
                        break;
                    }
                }

                if (!changed) {
                    return; // No significant changes to log
                }
            }

            embed.setDescription(messageDescription ?? `**Name:** ${newEntryData.name}\n[Submission Thread](${submissionThread.url})`);
            embed.setURL(newEntryData.post?.threadURL || '');

            const fields = [];
            if (changes.code) fields.push({ name: 'Code', value: `*${oldEntryData.code}* → *${newEntryData.code}*` });
            if (changes.name) fields.push({ name: 'Name', value: `*${oldEntryData.name}* → *${newEntryData.name}*` });
            if (changes.authors) fields.push({ name: 'Authors', value: `*${getAuthorsString(oldEntryData.authors)}* → *${getAuthorsString(newEntryData.authors)}*` });
            if (changes.endorsers) fields.push({ name: 'Endorsers', value: `*${getAuthorsString(oldEntryData.endorsers)}* → *${getAuthorsString(newEntryData.endorsers)}*` });
            if (changes.tags) fields.push({ name: 'Tags', value: `*${oldEntryData.tags.map(t => t.name).join(', ')}* → *${newEntryData.tags.map(t => t.name).join(', ')}*` });

            if (changes.records) {
                for (const [key, change] of Object.entries(changes.records)) {
                    const style = getEffectiveStyle(key, this.getSchemaStyles(), newEntryData.styles);
                    if (change.old && change.new) {
                        fields.push({ name: style.headerText, value: `*${countCharactersInRecord(change.old)} characters* → *${countCharactersInRecord(change.new)} characters*` });
                    } else if (change.old) {
                        fields.push({ name: style.headerText, value: `Removed ${countCharactersInRecord(change.old)} characters` });
                    } else if (change.new) {
                        fields.push({ name: style.headerText, value: `Added ${countCharactersInRecord(change.new)} characters` });
                    }
                }
            }

            if (changes.images) fields.push({ name: 'Images', value: `*${oldEntryData.images.length} images* → *${newEntryData.images.length} images*` });
            if (changes.attachments) fields.push({ name: 'Attachments', value: `*${oldEntryData.attachments.map(o => escapeDiscordString(o.name)).join(", ")} attachments* → *${newEntryData.attachments.map(o => escapeDiscordString(o.name)).join(", ")} attachments*` });
            if (!messageDescription) {
                embed.addFields(fields);
            }
            embed.setColor(0xFFFF00); // Yellow for update
        }

        embed.setTimestamp();

        await logChannel.send({
            embeds: [embed],
        });
    }


    public requestRetagging(value: boolean = true) {
        this.retaggingRequested = value;
    }

    private resolveOriginalName(name: string, renameMap: Map<string, string>): string {
        let cur = name;
        const seen = new Set<string>();
        while (renameMap.has(cur) && !seen.has(cur)) {
            seen.add(cur);
            cur = renameMap.get(cur)!;
        }
        return cur;
    }

    private ensureGlobalTagQueue() {
        if (!this.globalTagQueue) {
            const current = this.repositoryManager.getConfigManager().getConfig(RepositoryConfigs.GLOBAL_TAGS);
            this.globalTagQueue = {
                snapshot: deepClone(current),
                working: deepClone(current),
                renameMap: new Map<string, string>(),
                deleteRequests: new Set<string>()
            };
        }
        return this.globalTagQueue;
    }

    public beginGlobalTagQueue() {
        this.ensureGlobalTagQueue();
    }

    public hasGlobalTagQueue(): boolean {
        return !!this.globalTagQueue;
    }

    public getGlobalTagSnapshot(): GlobalTag[] {
        if (!this.globalTagQueue) {
            const current = this.repositoryManager.getConfigManager().getConfig(RepositoryConfigs.GLOBAL_TAGS);
            return deepClone(current);
        }
        return deepClone(this.globalTagQueue.working);
    }

    public queueGlobalTagAdd(tag: GlobalTag) {
        const queue = this.ensureGlobalTagQueue();
        queue.working.push({ ...tag });
        queue.deleteRequests.delete(tag.name);
    }

    public queueGlobalTagEdit(originalName: string, updatedTag: GlobalTag) {
        const queue = this.ensureGlobalTagQueue();
        const index = queue.working.findIndex(tag => tag.name === originalName);
        if (index === -1) {
            throw new Error(`Global tag "${originalName}" not found in queue.`);
        }

        const baseName = this.resolveOriginalName(originalName, queue.renameMap);
        const snapshotNames = new Set(queue.snapshot.map(t => t.name));
        if (updatedTag.name !== originalName) {
            queue.renameMap.delete(originalName);
            if (snapshotNames.has(baseName) && baseName !== updatedTag.name) {
                queue.renameMap.set(updatedTag.name, baseName);
            }
        }

        queue.working[index] = { ...updatedTag };
        queue.deleteRequests.delete(baseName);
        queue.deleteRequests.delete(updatedTag.name);
    }

    public queueGlobalTagRemove(tagName: string, deleteFromForums: boolean) {
        const queue = this.ensureGlobalTagQueue();
        const index = queue.working.findIndex(tag => tag.name === tagName);
        if (index === -1) {
            throw new Error(`Global tag "${tagName}" not found in queue.`);
        }

        queue.working.splice(index, 1);
        const baseName = this.resolveOriginalName(tagName, queue.renameMap);
        queue.renameMap.delete(tagName);

        const baseNames = new Set(queue.snapshot.map(t => t.name));
        if (deleteFromForums && baseNames.has(baseName)) {
            queue.deleteRequests.add(baseName);
        } else {
            queue.deleteRequests.delete(baseName);
        }
    }

    public clearGlobalTagQueue() {
        this.globalTagQueue = undefined;
    }

    public getGlobalTagQueueSummary(): string {
        if (!this.globalTagQueue) {
            return 'Pending global tag changes: none.';
        }

        const { snapshot, working, renameMap, deleteRequests } = this.globalTagQueue;
        const snapshotNames = new Set(snapshot.map(t => t.name));
        const workingNames = new Set(working.map(t => t.name));

        const added = working.filter(t => !snapshotNames.has(t.name)).map(t => t.name);
        const removed = snapshot.filter(t => !workingNames.has(t.name)).map(t => t.name);
        const removeDelete = removed.filter(n => deleteRequests.has(n));
        const removeKeep = removed.filter(n => !deleteRequests.has(n));

        const renames: string[] = [];
        for (const [newName, oldName] of renameMap.entries()) {
            if (workingNames.has(newName)) {
                renames.push(`${oldName} → ${newName}`);
            }
        }

        const fmt = (arr: string[]) => arr.length ? arr.join(', ') : 'None';

        return [
            'Pending global tag changes:',
            `- Add: ${fmt(added)}`,
            `- Rename: ${fmt(renames)}`,
            `- Remove (delete): ${fmt(removeDelete)}`,
            `- Remove (keep on forums): ${fmt(removeKeep)}`
        ].join('\n');
    }

    public async applyGlobalTagQueue(): Promise<boolean> {
        if (!this.globalTagQueue) {
            return false;
        }

        const { snapshot, working, renameMap, deleteRequests } = this.globalTagQueue;
        const tagsMatch = snapshot.length === working.length && snapshot.every((tag, index) => {
            const other = working[index];
            return tag.name === other.name &&
                tag.moderated === other.moderated &&
                tag.emoji === other.emoji &&
                tag.colorWeb === other.colorWeb &&
                tag.colorMod === other.colorMod;
        });

        if (tagsMatch && renameMap.size === 0 && deleteRequests.size === 0) {
            this.clearGlobalTagQueue();
            return false;
        }

        const workingNames = new Set(working.map(t => t.name));
        const filteredRenames = new Map<string, string>();
        for (const [newName, oldName] of renameMap.entries()) {
            if (workingNames.has(newName)) {
                filteredRenames.set(newName, oldName);
            }
        }

        const filteredDeletes = new Set<string>();
        deleteRequests.forEach(name => {
            if (!workingNames.has(name)) {
                filteredDeletes.add(name);
            }
        });

        await this.repositoryManager.applyGlobalTagChanges(working, { renamedFromMap: filteredRenames, deleteRemovedTagNames: filteredDeletes });
        this.clearGlobalTagQueue();
        return true;
    }

    public async onPostAdd(entryData: ArchiveEntryData) {
        this.dictionaryManager.invalidateArchiveIndex();
        this.requestRetagging();
        await this.updateDesignerRoles(entryData.id, [], entryData.authors).catch(e => {
            console.error(`Error adding designers for entry ${entryData.id}:`, e);
        });
    }

    public async onPostUpdate(oldEntryData: ArchiveEntryData, newEntryData: ArchiveEntryData) {
        await this.updateDesignerRoles(newEntryData.id, oldEntryData.authors, newEntryData.authors).catch(e => {
            console.error(`Error updating designers for entry ${newEntryData.id}:`, e);
        });
    }

    public async onPostDelete(entryData: ArchiveEntryData) {
        this.dictionaryManager.invalidateArchiveIndex();
        await this.updateDesignerRoles(entryData.id, entryData.authors, []).catch(e => {
            console.error(`Error removing designers for entry ${entryData.id}:`, e);
        });


        await this.repositoryManager.iterateAllEntries(async (entry: ArchiveEntry) => {
            if (entry.getData().id === entryData.id) {
                return;
            }

            // check references
            const otherData = entry.getData();
            const references = otherData.references;
            const authorReferences = otherData.author_references;

            const newReferences = references.filter(r => !(r.type === ReferenceType.ARCHIVED_POST && r.id === entryData.id));
            const newAuthorReferences = authorReferences.filter(r => !(r.type === ReferenceType.ARCHIVED_POST && r.id === entryData.id));
            const updated = newReferences.length !== references.length || newAuthorReferences.length !== authorReferences.length;
            otherData.references = newReferences;
            otherData.author_references = newAuthorReferences;

            if (updated && otherData.post) {
                await this.repositoryManager.addOrUpdateEntryFromData(otherData, otherData.post.forumId, false, false, false, async () => {
                    // do nothing
                }).catch(e => {
                    console.error("Error updating entry for URL update:", e);
                });
            }
        }).catch(e => {
            console.error("Error iterating all entries:", e);
        });

        // update definitions
        await this.getDictionaryManager().iterateEntries(async (definition) => {

            const newReferences = definition.references.filter(r => !(r.type === ReferenceType.ARCHIVED_POST && r.id === entryData.id));
            let updated = newReferences.length !== definition.references.length;
            const newReferencedBy = definition.referencedBy.filter(r => r !== entryData.id);
            if (newReferencedBy.length !== definition.referencedBy.length) {
                updated = true;
            }

            definition.references = newReferences;
            definition.referencedBy = newReferencedBy;

            if (updated) {
                await this.getDictionaryManager().saveEntry(definition);
                await this.getDictionaryManager().updateStatusMessage(definition).catch(e => {
                    console.error("Error updating definition status message:", e);
                });
            }
        });
    }

    public async updateDesignerRoles(entryId: Snowflake, oldAuthors: Author[], newAuthors: Author[]) {
        const designerRoleId = this.getConfigManager().getConfig(GuildConfigs.DESIGNER_ROLE_ID);
        if (!designerRoleId) {
            return;
        }

        const oldDesigners = oldAuthors.filter(a => isDiscordAuthor(a) && !a.dontDisplay) as DiscordAuthor[];
        const newDesigners = newAuthors.filter(a => isDiscordAuthor(a) && !a.dontDisplay) as DiscordAuthor[];

        const oldDesignerIds = oldDesigners.map(a => a.id);
        const newDesignerIds = newDesigners.map(a => a.id);

        const oldSet = new Set(oldDesignerIds);
        const newSet = new Set(newDesignerIds);


        const added = newSet.difference(oldSet);
        const removed = oldSet.difference(newSet);

        const idToUsernameMap = new Map<Snowflake, string>();
        oldDesigners.forEach(a => {
            idToUsernameMap.set(a.id, a.username);
        });
        newDesigners.forEach(a => {
            idToUsernameMap.set(a.id, a.username);
        });

        for (const designerId of added) {
            // get userdata for designer
            let userData = await this.userManager.getOrCreateUserData(designerId, idToUsernameMap.get(designerId) || 'Unknown');
            if (!userData.archivedPosts) {
                userData.archivedPosts = [];
            }
            if (!userData.archivedPosts.includes(entryId)) {
                userData.archivedPosts.push(entryId);
            }

            await this.userManager.saveUserData(userData);

            const member = await this.getGuild().members.fetch(designerId).catch(() => undefined);
            if (!member) {
                continue; // Skip if member not found
            }

            if (!member.roles.cache.has(designerRoleId)) {
                const designerRole = this.getGuild().roles.cache.get(designerRoleId);
                if (designerRole) {
                    await member.roles.add(designerRole).catch((_) => {
                        console.error(`[${this.getGuild().name}] Error adding designer role to user ${member.user.username}`);
                    });
                } else {
                    console.warn(`Designer role with ID ${designerRoleId} not found in guild ${this.getGuild().name}`);
                }
            }
        }

        for (const designerId of removed) {
            // get userdata for designer
            let userData = await this.userManager.getOrCreateUserData(designerId, idToUsernameMap.get(designerId) || 'Unknown');
            if (!userData.archivedPosts) {
                userData.archivedPosts = [];
            }
            userData.archivedPosts = userData.archivedPosts.filter(id => id !== entryId);

            await this.userManager.saveUserData(userData);

            const member = await this.getGuild().members.fetch(designerId).catch(() => undefined);
            if (!member) {
                continue; // Skip if member not found
            }
            if (member.roles.cache.has(designerRoleId) && userData.archivedPosts.length === 0) {
                const designerRole = this.getGuild().roles.cache.get(designerRoleId);
                if (designerRole) {
                    await member.roles.remove(designerRole).catch((_) => {
                        console.error(`[${this.getGuild().name}] Error removing designer role from user ${member.user.username}`);
                    });
                } else {
                    console.warn(`Designer role with ID ${designerRoleId} not found in guild ${this.getGuild().name}`);
                }
            }
        }
    }

    public async rebuildDesignerRoles() {
        const allDesignerIdsToPosts = new Map<Snowflake, Snowflake[]>();
        await this.getRepositoryManager().iterateAllEntries(async (entry: ArchiveEntry) => {
            entry.getData().authors.forEach(author => {
                if (author.type === AuthorType.DiscordInGuild && !author.dontDisplay && author.id) {
                    if (!allDesignerIdsToPosts.has(author.id)) {
                        allDesignerIdsToPosts.set(author.id, []);
                    }
                    allDesignerIdsToPosts.get(author.id)?.push(entry.getData().id);
                }
            });
        });

        // Give user data to all designers
        for (const [designerId, posts] of allDesignerIdsToPosts.entries()) {
            let userData = await this.userManager.getUserData(designerId);
            if (!userData) {
                const member = await this.getGuild().members.fetch(designerId).catch(() => undefined);
                if (!member) {
                    continue; // Skip if member not found
                }
                userData = await this.userManager.getOrCreateUserData(designerId, member.user.username);
                // save user data
                userData.archivedPosts = posts;
                await this.userManager.saveUserData(userData);
            }
        }

        // Now update all user data
        const userIDs = await this.userManager.getAllUserIDs();
        for (const userId of userIDs) {
            const userData = await this.userManager.getUserData(userId);
            if (!userData) continue;

            // Get the posts for this user
            const posts = allDesignerIdsToPosts.get(userId) || [];
            userData.archivedPosts = posts;

            // Save the updated user data
            await this.userManager.saveUserData(userData);

            // Update roles if necessary
            const member = await this.getGuild().members.fetch(userId).catch(() => undefined);
            if (member) {
                const designerRoleId = this.getConfigManager().getConfig(GuildConfigs.DESIGNER_ROLE_ID);
                if (designerRoleId && member.roles.cache.has(designerRoleId) && posts.length === 0) {
                    const designerRole = this.getGuild().roles.cache.get(designerRoleId);
                    if (designerRole) {
                        await member.roles.remove(designerRole).catch((_) => {
                            console.error(`[${this.getGuild().name}] Error removing designer role from user ${member.user.username}`);
                        });

                    } else {
                        console.warn(`Designer role with ID ${designerRoleId} not found in guild ${this.getGuild().name}`);
                    }
                } else if (designerRoleId && !member.roles.cache.has(designerRoleId) && posts.length > 0) {
                    const designerRole = this.getGuild().roles.cache.get(designerRoleId);
                    if (designerRole) {
                        await member.roles.add(designerRole).catch((_) => {
                            console.error(`[${this.getGuild().name}] Error adding designer role to user ${member.user.username}`);
                        });
                    } else {
                        console.warn(`Designer role with ID ${designerRoleId} not found in guild ${this.getGuild().name}`);
                    }
                }
            }
        }
    }

    public async logRetraction(oldEntryData: ArchiveEntryData, reason: string) {
        const logChannelId = this.getConfigManager().getConfig(GuildConfigs.LOGS_CHANNEL_ID);
        if (!logChannelId) {
            console.warn('No log channel configured, skipping log message');
            return;
        }

        const logChannel = await this.getGuild().channels.fetch(logChannelId);
        if (!logChannel || !logChannel.isTextBased()) {
            console.warn('Log channel not found or not a text channel, skipping log message');
            return;
        }

        // const submissionChannel = await this.getGuild().channels.fetch(this.getSubmissionsChannelId());
        // if (!submissionChannel || submissionChannel.type !== ChannelType.GuildForum) {
        //     console.warn('Submission channel not found or not a forum channel, skipping log message');
        //     return;
        // }

        const submissionThread = await this.getGuild().channels.fetch(oldEntryData.id);
        if (!submissionThread) {
            console.warn('Submission thread not found, skipping log message');
            return;
        }


        const forumChannel = await this.getGuild().channels.fetch(oldEntryData.post?.forumId || '');
        if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
            console.warn('Forum channel not found or not a forum channel, skipping log message');
            return;
        }

        const embed = new EmbedBuilder();

        const imageURL = oldEntryData.images && oldEntryData.images.length > 0 ? oldEntryData.images[0].url : null;
        if (imageURL) {
            embed.setThumbnail(imageURL);
        }

        embed.setTitle(`Retracted ${oldEntryData.code} from ${forumChannel.name}`)
        embed.setURL(submissionThread.url);
        embed.setDescription(`**Name:** ${oldEntryData.name}\n[Submission Thread](${submissionThread.url})`)
            .setURL(submissionThread.url)
            .setColor(0xFF0000) // Red for retraction
            .addFields(
                { name: 'Reason', value: reason },
            );
        embed.setTimestamp();

        await logChannel.send({
            embeds: [embed],
        });
    }

    public getSchema(): JSONSchema7 {
        return this.repositoryManager.getConfigManager().getConfig(RepositoryConfigs.POST_SCHEMA);
    }

    public getSchemaStyles(): Record<string, StyleInfo> {
        return this.repositoryManager.getConfigManager().getConfig(RepositoryConfigs.POST_STYLE);
    }

    public getUserManager(): UserManager {
        return this.userManager;
    }

    public getUserSubscriptionManager(): UserSubscriptionManager {
        return this.userSubscriptionManager;
    }

    public getChannelSubscriptionManager(): ChannelSubscriptionManager {
        return this.channelSubscriptionManager;
    }


    public canConverse() {
        return this.bot.openAIClient !== undefined;
    }

    public getLastToolUsages(): undefined | { toolName: string; query: string; }[] {
        return this.lastToolUsages;
    }

    public async respondToConversation(channel: TextChannel | TextThreadChannel, message: Message) {
        if (!this.bot.openAIClient) {
            throw new Error('LLM client not configured');
        }

        const channelName = channel.name;
        const channelTopic = channel.isThread() ? getCodeAndDescriptionFromTopic(channel.parent?.topic || '').description : (channel.topic ?? '');
        let contextLength;
        let model;
        let systemPrompt;
        const sharedPromptLines = [
            'You are LlamaBot, a helpful assistant that supports Minecraft Discord server administration.',
            'The discord collects designs submitted by the community and is open to the public.',
            'You are friendly, concise, and talk casually, but you never flatter.',
            'You must ground every factual statement in information returned by your tools, especially the private facts tool, dictionary, or archive search.',
            'Always call the facts tool before giving advice about designs, redstone behavior, moderation policy, or community history.',
            "Don't mention the existence of the tools themselves to users, especially the facts tool. Don't say 'Facts say' or similar.",
            'If the tools return nothing relevant, say you do not know instead of guessing.',
            'You can call multiple tools to gather information before responding, and you can call the same tool multiple times if needed.',
            "When you use something from the archive search tool, mention the design's code so users can look it up themselves.",
            'NEVER use emojis or em-dashes.',
            'User mentions use the format <@UserID> and are prepended to their messages—include the correct mention when responding.'
        ];
        const sharedPrompt = sharedPromptLines.join('\n');
        const specialQuestions = ['who is right', 'is this true', 'translate'];
        if (specialQuestions.some(q => message.content.toLowerCase().includes(q))) {
            contextLength = 50; // more context for "who is right" questions
            model = this.bot.openAIClient("gpt-5.4-mini"); // use better model for complex questions
            const specialPromptLines = [
                sharedPrompt,
                'You are reviewing conflicting or high-risk claims, so double-check every statement with the facts tool or other resources before responding.',
                'If two sources disagree, explain the disagreement and prefer the better cited fact.',
                'Do not extrapolate beyond what the tools returned.'
            ];
            systemPrompt = specialPromptLines.join('\n\n');
        } else {
            contextLength = 10;
            model = this.bot.openAIClient("gpt-5.4-nano"); // use faster model for normal questions
            const defaultPromptLines = [
                sharedPrompt,
                `You are talking in a channel called #${channelName}.`,
                channelTopic ? `The channel topic is: ${channelTopic}.` : '',
                'Direct users to the appropriate channel if they ask where they can find a design, but do not guess about channel contents—consult the channels tool if needed.',
                'Never speculate about designs or facts you cannot verify with a tool.',
                "If unsure after checking, explicitly say you don't know."
            ].filter(Boolean);
            systemPrompt = defaultPromptLines.join('\n\n');
        }

        // const allchannels = this.guild.channels.cache;
        // const channelText: string[] = [];
        // allchannels.forEach(channel => {
        //     if (channel && (channel.isTextBased() || channel.type === ChannelType.GuildForum) && !channel.isThread() && !channel.isVoiceBased()) {
        //         channelText.push(`#${channel.name}`);
        //     }
        // });

        // if (channelText.length > 0) {
        //     systemPrompt += `\nThe server has the following channels: ${channelText.join(', ')}.`;
        // }

        let messages = await channel.messages.fetch({ limit: contextLength });

        // Remove messages that are not in the last 24 hours
        // const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
        //const recentMessages = messages.filter(msg => msg.createdTimestamp > oneDayAgo);

        // check if sent in bot channel, if so, only include messages from 10 minutes ago to now to avoid long irrelevant context
        if (channel.id === this.getConfigManager().getConfig(GuildConfigs.CONVERSATIONAL_LLM_CHANNEL)) {
            // remove messages older than 10 minutes from the most recent message
            const mostRecentTimestamp = messages.reduce((max, msg) => Math.max(max, msg.createdTimestamp), 0);
            const tenMinutesAgo = mostRecentTimestamp - (10 * 60 * 1000);
            messages = messages.filter(msg => msg.createdTimestamp >= tenMinutesAgo);
        }

        // Sort messages so that newest is last
        messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);


        const messagesIn: { mid: Snowflake, id: number, obj: ModelMessage }[] = [];

        //messagesIn.push({ mid: '0', id: 0, obj: { role: 'system', content: systemPrompt } });
        messages.forEach(msg => {
            const isBot = msg.author.id === this.getBot().client.user?.id;
            const role = isBot ? 'assistant' : 'user';
            const content = msg.content;

            const regex = /!(ignore|i)\b/i;
            if (regex.test(content)) {
                return; // skip this message
            }

            // replace hyperlinks with the link text
            const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
            const contentWithoutLinks = content.replace(linkRegex, '$1');

            // if content length is greater than 1000, truncate it
            const maxLength = 1000;
            const truncatedContent = contentWithoutLinks.length > maxLength ? contentWithoutLinks.slice(0, maxLength) + '... (truncated)' : contentWithoutLinks;
            // check reply
            let replyTo = null;
            if (msg.reference && msg.reference.messageId) {
                const repliedMessage = messagesIn.find(m => m.mid === msg.reference?.messageId);
                if (repliedMessage) {
                    replyTo = repliedMessage.id;
                }
            }
            messagesIn.push({ mid: msg.id, id: messagesIn.length, obj: { role, content: `[${messagesIn.length}] <@${msg.author.id}> ${replyTo === null ? "said" : ` replied to [${replyTo}]`}: ${truncatedContent}` } });
        });

        const dictionaryEntriesRetrieved = new Set<Snowflake>();
        const toolUsage: { toolName: string; query: string; }[] = [];
        const tools: Record<string, Tool> = {
            search: {
                description: 'Lookup designs and resources made by expert Minecraft redstone engineers using semantic search.',
                inputSchema: z.object({
                    query: z.string().min(1).max(256).describe('The search query to find relevant Minecraft redstone designs and resources.'),
                }),
                outputSchema: zodSchema(
                    z.object({
                        results: z.array(z.object({
                            title: z.string().describe('The title of the design.'),
                            code: z.string().describe('The identifier code for the design.'),
                            authors: z.string().describe('The authors of the design.'),
                            tags: z.array(z.string()).describe('List of tags associated with the design.'),
                            description: z.string().describe('A description of the design.'),
                        })).describe('Top 5 list of Minecraft redstone designs matching the search query.'),
                        error: z.string().nullable().describe('An error message, if an error occurred during the search.'),
                    })
                ),
                execute: async (input: { query: string }) => {
                    toolUsage.push({ toolName: 'search', query: input.query });
                    const queryEmbeddings = await generateQueryEmbeddings([input.query.trim()]).catch(e => {
                        console.error('Error generating query embeddings:', e);
                        return null;
                    });
                    if (!queryEmbeddings) {
                        return { results: [], error: 'Error generating query embeddings' };
                    }

                    const postCodesInQuery = getPostCodesInText(input.query);

                    try {
                        const queryEmbeddingVector = base64ToInt8Array(queryEmbeddings.embeddings[0]);
                        const results = [];

                        for (const code of postCodesInQuery) {
                            const entry = await this.repositoryManager.getEntryByPostCode(code);
                            if (entry) {
                                const data = entry.entry.getData();
                                const text = transformOutputWithReferencesForEmbeddings(postToMarkdown(data.records, data.styles, this.getSchemaStyles()), data.references);
                                results.push({
                                    title: data.name,
                                    code: data.code,
                                    tags: data.tags.map(t => t.name),
                                    authors: data.authors.map(a => getAuthorName(a)),
                                    description: truncateStringWithEllipsis(text, 2000)
                                });
                            }
                        }

                        const toFetch = Math.max(0, 5 - results.length);
                        const closest = toFetch > 0 ? await this.repositoryManager.getClosest(queryEmbeddingVector, toFetch) : [];

                        for (const result of closest) {
                            const entry = await this.repositoryManager.getEntryByPostCode(result.identifier);
                            if (entry) {
                                const data = entry.entry.getData();
                                // first entry
                                const text = transformOutputWithReferencesForEmbeddings(postToMarkdown(data.records, data.styles, this.getSchemaStyles()), data.references);
                                results.push({
                                    title: data.name,
                                    code: data.code,
                                    tags: data.tags.map(t => t.name),
                                    authors: data.authors.map(a => getAuthorName(a)),
                                    description: truncateStringWithEllipsis(text, 2000)
                                });
                            }
                        }
                        return { results, error: null };
                    } catch (e) {
                        console.error('Error during search execution:', e);
                        return { results: [], error: 'Error during search execution' };
                    }
                }
            },
            define: {
                description: 'Lookup Minecraft and redstone related terms from a custom dictionary of definitions.',
                inputSchema: z.object({
                    query: z.string().min(1).max(256).describe('The search query to find relevant Minecraft and redstone definitions.'),
                }),
                outputSchema: zodSchema(
                    z.object({
                        results: z.array(z.object({
                            terms: z.string().describe('The terms defined.'),
                            definition: z.string().describe('The definition.'),
                        })).describe('Top 5 list of definitions matching the search query.'),
                        error: z.string().nullable().describe('An error message, if an error occurred during the search.'),
                    })
                ),
                execute: async (input: { query: string }) => {
                    toolUsage.push({ toolName: 'define', query: input.query });
                    const queryEmbeddings = await generateQueryEmbeddings([input.query.trim()]).catch(e => {
                        console.error('Error generating query embeddings:', e);
                        return null;
                    });
                    if (!queryEmbeddings) {
                        return { results: [], error: 'Error generating query embeddings' };
                    }

                    try {
                        const queryEmbeddingVector = base64ToInt8Array(queryEmbeddings.embeddings[0]);
                        const topResults = await this.getDictionaryManager().getClosest(queryEmbeddingVector, 5);
                        const results = [];
                        for (const result of topResults) {
                            const entry = await this.getDictionaryManager().getEntry(result.identifier);
                            if (entry) {
                                // first entry
                                const text = transformOutputWithReferencesForEmbeddings(entry.definition, entry.references);
                                results.push({
                                    terms: entry.terms.join(', '),
                                    definition: truncateStringWithEllipsis(text, 2000),
                                });
                                dictionaryEntriesRetrieved.add(entry.id);
                            }
                        }

                        return { results, error: null };
                    } catch (e) {
                        console.error('Error during define execution:', e);
                        return { results: [], error: 'Error during define execution' };
                    }
                }
            },
            channels: {
                description: 'Get more info about the server\'s channels to help direct users where they can find certain topics and designs. Use this if people ask where to find something.',
                inputSchema: z.object({}),
                outputSchema: zodSchema(
                    z.object({
                        channels: z.array(z.object({
                            name: z.string().describe('The name of the channel.'),
                            topic: z.string().describe('The topic of the channel.'),
                            isArchiveChannel: z.boolean().describe('Whether the channel is an archive channel containing redstone designs.'),
                        })).describe('List of channels in the server.'),
                    })
                ),
                execute: async (_input: {}) => {
                    toolUsage.push({ toolName: 'channels', query: '' });
                    const channels: { name: string; topic: string; isArchiveChannel: boolean }[] = [];
                    const archiveCategories = this.getConfigManager().getConfig(GuildConfigs.ARCHIVE_CATEGORY_IDS) || [];
                    const allchannels = this.guild.channels.cache;
                    allchannels.forEach(channel => {
                        if (channel && (channel.isTextBased() || channel.type === ChannelType.GuildForum) && !channel.isThread() && !channel.isVoiceBased()) {
                            channels.push({
                                name: channel.name,
                                topic: getCodeAndDescriptionFromTopic(channel.topic || '').description,
                                isArchiveChannel: archiveCategories.includes(channel.parentId || ''),
                            });
                        }
                    });
                    return { channels };
                }
            },
            warn_user: {
                description: 'Issue a warning to a user about their behavior. Use this when a user is being disruptive, spamming, or trying to make you say inappropriate things. With 3 warnings, they will not be allowed to talk to you anymore for a month.',
                inputSchema: z.object({
                    user_id: z.string().describe('The Discord user ID of the user to warn.'),
                    reason: z.string().describe('The reason for the warning.'),
                }),
                outputSchema: zodSchema(
                    z.object({
                        success: z.boolean().describe('Whether the warning was successfully issued.'),
                        numWarnings: z.number().describe('The number of warnings the user has received. Mention this in your response to help the moderators decide on further action.'),
                        error: z.string().nullable().describe('An error message, if an error occurred while issuing the warning.'),
                    })
                ),
                execute: async (input: { user_id: string; reason: string }) => {
                    toolUsage.push({ toolName: 'warn_user', query: `user_id: ${input.user_id}, reason: ${input.reason}` });
                    try {
                        const member = await this.guild.members.fetch(input.user_id).catch(() => undefined);
                        if (!member) {
                            return { success: false, numWarnings: 0, error: 'User not found in guild' };
                        }

                        const userData = await this.userManager.getOrCreateUserData(input.user_id, 'Unknown');
                        if (!userData.llmWarnings) {
                            userData.llmWarnings = [];
                        }

                        userData.llmWarnings.push({
                            messageId: message.id,
                            timestamp: Date.now(),
                            reason: input.reason,
                        });

                        await this.userManager.saveUserData(userData);

                        return { success: true, numWarnings: userData.llmWarnings.filter(w => (Date.now() - w.timestamp) < (30 * 24 * 60 * 60 * 1000)).length, error: null };
                    } catch (e) {
                        console.error('Error issuing warning to user:', e);
                        return { success: false, numWarnings: 0, error: 'Error issuing warning to user' };
                    }
                }
            }
        };

        if (this.privateFactBase.isFactBaseEnabled()) {
            tools.facts = {
                description: 'Lookup information from the private question-answer database. This is the largest resource. Use this resource frequently to understand comprehensive knowledge about Minecraft, redstone, and common community practices. Always check this before making recommendations.',
                inputSchema: z.object({
                    query: z.string().min(1).max(256).describe('The search query to find relevant factsheet information.'),
                }),
                outputSchema: zodSchema(
                    z.object({
                        results: z.array(z.object({
                            question: z.string().describe('The question answered by the factsheet entry.'),
                            answer: z.string().describe('The answer provided by the factsheet entry.'),
                            category: z.string().describe('The category of the factsheet entry.'),
                            credibility: z.number().describe('The credibility level of the factsheet entry. Higher numbers indicate more credibility.'),
                        })).describe('Top 5 list of factsheet entries matching the search query.'),
                        error: z.string().nullable().describe('An error message, if an error occurred during the search.'),
                    })
                ),
                execute: async (input: { query: string }) => {
                    toolUsage.push({ toolName: 'facts', query: input.query });
                    // console.log('Executing factsheet tool with query:', input.query);
                    const queryEmbeddings = await generateQueryEmbeddings([input.query.trim()]).catch(e => {
                        console.error('Error generating query embeddings:', e);
                        return null;
                    });
                    if (!queryEmbeddings) {
                        return { results: [], error: 'Error generating query embeddings' };
                    }
                    try {
                        const queryEmbeddingVector = base64ToInt8Array(queryEmbeddings.embeddings[0]);
                        const results = await this.privateFactBase.getClosest(queryEmbeddingVector, 5);
                        const data = [];
                        for (const result of results) {
                            const sheet = await this.privateFactBase.getFact(result.identifier);
                            if (sheet) {
                                data.push({
                                    question: sheet.question,
                                    answer: sheet.answer,
                                    category: sheet.category,
                                    credibility: sheet.citations.length,
                                });
                            }
                        }
                        return { results: data, error: null };
                    } catch (e) {
                        console.error('Error during factsheet query execution:', e);
                        return { results: [], error: 'Error during factsheet query execution' };
                    }
                }
            }
        }

        const agent = new ToolLoopAgent({
            model,
            instructions: systemPrompt,
            tools,
            stopWhen: stepCountIs(20),
            output: Output.object(
                {
                    schema: zodSchema(
                        z.object({
                            response_text: z.string().nullable().describe('The raw text of the response to be sent in the Discord channel. Null or empty string means no response is needed. You can use markdown formatting here, but tables are not supported.'),
                        })
                    ),
                }
            ),
        });
        
        const response = await agent.generate({
             messages: messagesIn.map(m => m.obj),
        })


        // const response = await generateText({
        //     model: model,
        //     system: systemPrompt,
        //     messages: messagesIn.map(m => m.obj),
        //     stopWhen: stepCountIs(20),
        //     output: Output.object(
        //         {
        //             schema: zodSchema(
        //                 z.object({
        //                     response_text: z.string().nullable().describe('The raw text of the response to be sent in the Discord channel. Null or empty string means no response is needed. You can use markdown formatting here, but tables are not supported.'),
        //                 })
        //             ),
        //         }
        //     ),
        //     tools: tools
        // })

        this.lastToolUsages = toolUsage;

        if (response.warnings?.length) {
            console.warn('LLM Warnings:', response.warnings);
        }

        if (!response.output) {
            console.error('No response from LLM:', response.output);
            throw new Error('No response from LLM');
        }

        // replace @username with actual mentions if possible
        let responseText = response.output.response_text ?? '';

        if (!responseText) {
            return '';
        }

        // Check for channel name mentions eg #ask-questions
        const channelMentionRegex = /#(\S+)/g;
        let match;
        while ((match = channelMentionRegex.exec(responseText)) !== null) {
            const channelName = match[1];
            const foundChannel = this.guild.channels.cache.find(c => c.name.replace(/[^a-zA-Z0-9]/g, '') === channelName.replace(/[^a-zA-Z0-9]/g, '') && (c.isTextBased() || c.type === ChannelType.GuildForum) && !c.isThread() && !c.isVoiceBased());
            if (foundChannel) {
                responseText = responseText.replaceAll(`#${channelName}`, `<#${foundChannel.id}>`);
            }
        }


        // remove everyone mentions
        responseText = responseText.replace(/@everyone/g, 'everyone');
        responseText = responseText.replace(/@here/g, 'here');

        // Sometimes, the llm will respond with "[n] @LlamaBot said: blabla" or "[n] @LlamaBot replied to [m]: blabla" so we remove that
        const botMentionRegex = /(\[\d+\])*\s*<@!?(\d+)>\s+(said|replied to \[\d+\]):\s+/g;
        responseText = responseText.replace(botMentionRegex, '');

        const citationRegex = /Citations?:\s*(\d+,?\S*)*/gi;
        responseText = responseText.replace(citationRegex, '');

        responseText.replace(/\[\d{17,19}\]/g, ''); // remove reference numbers

        responseText = responseText.trim();



        const inTextReferences: Reference[] = await tagReferences(responseText, [], this, '', false);
        const filteredReferences = inTextReferences.filter(ref => {
            if (ref.type === ReferenceType.ARCHIVED_POST) {
                return false;
            }
            if (ref.type === ReferenceType.DICTIONARY_TERM) {
                return dictionaryEntriesRetrieved.has(ref.id);
            }
            if (ref.type === ReferenceType.USER_MENTION) {
                return false;
            }
            
            return true;
        });

        responseText = transformOutputWithReferencesForDiscord(responseText, filteredReferences);

        const references = await this.getReferenceEmbedsFromMessage(responseText, true, true, 10);
        const split = splitIntoChunks(responseText, 2000);

        const embedSplit = [];
        const currentChunkEmbeds = [];
        let currentChunkLength = 0;
        for (const embed of references) {
            const embedLength = embed.length;
            if (currentChunkLength + embedLength > 5000) {
                embedSplit.push([...currentChunkEmbeds]);
                currentChunkEmbeds.length = 0;
                currentChunkLength = 0;
            }
            currentChunkEmbeds.push(embed);
            currentChunkLength += embedLength;
        }
        if (currentChunkEmbeds.length > 0) {
            embedSplit.push([...currentChunkEmbeds]);
        }

        for (let i = 0; i < split.length; i++) {
            if (i === 0) {
                try {
                    await message.reply({ content: split[i], allowedMentions: { parse: [] }, flags: [MessageFlags.SuppressNotifications, MessageFlags.SuppressEmbeds] });
                } catch (e) {
                    // send as message
                    await channel.send({ content: split[i], allowedMentions: { parse: [] }, flags: [MessageFlags.SuppressNotifications, MessageFlags.SuppressEmbeds] }).catch(console.error);
                }

            } else {
                await channel.send({ content: split[i], allowedMentions: { parse: [] }, flags: [MessageFlags.SuppressNotifications, MessageFlags.SuppressEmbeds] }).catch(console.error);
            }
        }
        if (references.length > 0) {
            for (const embedChunk of embedSplit) {
                await channel.send({
                    embeds: embedChunk,
                    flags: [MessageFlags.SuppressNotifications],
                    allowedMentions: { parse: [] },
                }).catch(console.error);
            }
        }
    }

    public getAliasManager() {
        return this.aliasManager;
    }

    public getFactManager() {
        return this.privateFactBase;
    }
}
