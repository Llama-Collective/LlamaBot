import { ActionRowBuilder, AnyThreadChannel, ChannelType, EmbedBuilder, Message, Snowflake, TextThreadChannel } from "discord.js";
import { GuildHolder } from "../GuildHolder.js";
import { ConfigManager } from "../config/ConfigManager.js";
import { SubmissionConfigs } from "./SubmissionConfigs.js";
import { StarterEmbed } from "../embed/StarterEmbed.js";
import { LLMResponseFuture } from "../llm/LLMResponseFuture.js";
import { LLMResponseStatus } from "../llm/LLMResponseStatus.js";
import { LLMRequest } from "../llm/LLMRequest.js";
import { ExtractionPrompt } from "../llm/prompts/ExtractionPrompt.js";
import { LLMResponse } from "../llm/LLMResponse.js";
import { extractUserIdsFromText, getAuthorsString, getDiscordAuthorsFromIDs, isDiscordAuthor, reclassifyAuthors, splitIntoChunks } from "../utils/Util.js";
import { Attachment, BaseAttachment } from "./Attachment.js";
import { RevisionManager } from "./RevisionManager.js";
import { Revision, RevisionType } from "./Revision.js";
import { RevisionEmbed } from "../embed/RevisionEmbed.js";
import { ModificationPrompt } from "../llm/prompts/ModificationPrompt.js";
import { SubmissionStatus } from "./SubmissionStatus.js";
import { PublishButton } from "../components/buttons/PublishButton.js";
import { SubmissionTagNames, SubmissionTags } from "./SubmissionTags.js";
import { DiscordAuthor } from "./Author.js";
import { GuildConfigs } from "../config/GuildConfigs.js";
import { processImages, processAttachments, getAllAttachments, optimizeAttachments } from "../utils/AttachmentUtils.js";
import { RuleMatcher } from "../utils/RuleMatcher.js";
import { tagReferencesInAcknowledgements, tagReferencesInSubmissionRecords } from "../utils/ReferenceUtils.js";
import { PublishCommitMessage } from "./Publish.js";
import { safeJoinPath, safeWorkspacePath } from "../utils/SafePath.js";
import { TemporaryCache } from "../archive/TemporaryCache.js";

export class Submission {
    private guildHolder: GuildHolder;
    private id: Snowflake;
    private folderPath: string;
    private config: ConfigManager;
    private revisions: RevisionManager;
    private extractionResults?: LLMResponseFuture;
    private llmReviseResponse?: LLMResponseFuture;
    public lastAccessed: number = Date.now();
    private cachedAttachments: TemporaryCache<BaseAttachment[]>;
    public imagesProcessing: boolean = false;
    public attachmentsProcessing: boolean = false;
    public tagging: boolean = false;
    private reviewLocked: boolean = false;

    private publishLock: boolean = false;

    constructor(
        guildHolder: GuildHolder,
        id: Snowflake,
        folderPath: string,
    ) {
        this.guildHolder = guildHolder;
        this.id = id;
        this.folderPath = safeWorkspacePath(folderPath);
        this.config = new ConfigManager(safeJoinPath(this.folderPath, 'submission.json'));
        this.revisions = new RevisionManager(this, safeJoinPath(this.folderPath, 'revisions'));

        this.cachedAttachments = new TemporaryCache<BaseAttachment[]>(5 * 60 * 1000, async () => {
            const channel = await this.getSubmissionChannel();
            if (!channel) {
                throw new Error('Submission channel not found');
            }
            return await getAllAttachments(channel, this.guildHolder.getBot().client.user?.id || '');
        });
    }

    /**
     * Called when the submission is created from nothing
     */
    public async init() {
        // Set initial config values
        const channel = await this.getSubmissionChannel(true);
        if (channel) {
            this.config.setConfig(SubmissionConfigs.NAME, channel.name);
            this.config.setConfig(SubmissionConfigs.SUBMISSION_THREAD_ID, channel.id);
            this.config.setConfig(SubmissionConfigs.SUBMISSION_THREAD_URL, channel.url);
        }
        this.config.setConfig(SubmissionConfigs.STATUS, SubmissionConfigs.STATUS.default);

        await this.checkStatusMessage();
        this.checkLLMExtraction();
    }

    public async getSubmissionChannel(dontUnarchive: boolean = false): Promise<TextThreadChannel | null> {
        const channel = await this.guildHolder.getGuild().channels.fetch(this.id).catch(() => null);
        if (!channel) {
            return null;
        }

        // check if archived
        if (!dontUnarchive && channel.isThread() && channel.archived) {
            await channel.setArchived(false);
        }

        return channel as TextThreadChannel;
    }

    public async checkStatusMessage() {
        const statusMessageId = this.config.getConfig(SubmissionConfigs.STATUS_MESSAGE_ID);
        if (!statusMessageId) {
            // post initial message
            const starterEmbed = await StarterEmbed.create(this);
            const channel = await this.getSubmissionChannel();
            if (!channel) {
                return;
            }
            const message = await channel.send({ embeds: [starterEmbed.getEmbed()], components: [starterEmbed.getRow() as any] })
            message.pin()
            this.config.setConfig(SubmissionConfigs.STATUS_MESSAGE_ID, message.id);

            // set new tag
            if (channel.parentId) {
                const forumChannel = await this.guildHolder.getGuild().channels.fetch(channel.parentId);
                if (forumChannel && forumChannel.type === ChannelType.GuildForum) {
                    const newTag = forumChannel.availableTags.find(tag => tag.name === SubmissionTagNames.NEW);
                    if (newTag) {
                        // check if tag is already applied
                        if (channel.appliedTags && channel.appliedTags.includes(newTag.id)) {
                            return;
                        }
                        const tags = channel.appliedTags || [];
                        tags.push(newTag?.id || '');
                        await channel.setAppliedTags(tags);
                    }
                }
            }
        }
    }

    public async checkLLMExtraction() {
        // If we already have extraction results, no need to check again
        if (this.extractionResults) {
            return;
        }

        // check if revisions exist. no need to extract if revisions are present
        const revisions = this.getRevisionsManager().getRevisionsList();
        if (revisions.length > 0) {
            return;
        }

        const channel = await this.getSubmissionChannel();
        if (!channel) {
            return;
        }

        const message = await channel.fetchStarterMessage().catch(() => null);
        if (!message) {
            return;
        }

        // If we already have extraction results, no need to check again
        if (this.extractionResults) {
            return;
        }

        // check if revisions exist. no need to extract if revisions are present
        if (revisions.length > 0) {
            return;
        }

        // If no revisions, we can start the extraction process
        try {
            const prompt = new ExtractionPrompt(message.content)
            const request = new LLMRequest(1, prompt, this.guildHolder.getSchema());
            this.extractionResults = this.guildHolder.getBot().llmQueue.addRequest(request);
            await this.extractionResults.getResponse();
        } catch (error: any) {
            console.error('Error getting LLM response:', error.message);
        }

        this.checkReview();
    }

    /**
     * Forces a fresh LLM extraction of the starter message, regardless of existing results or revisions.
     */
    public async forceLLMExtraction(): Promise<LLMResponse> {
        if (this.extractionResults && this.extractionResults.getStatus() === LLMResponseStatus.InProgress) {
            throw new Error('An extraction is already in progress.');
        }

        const channel = await this.getSubmissionChannel();
        if (!channel) {
            throw new Error('Submission channel not found');
        }

        const message = await channel.fetchStarterMessage().catch(() => null);
        if (!message) {
            throw new Error('Starter message not found');
        }

        const prompt = new ExtractionPrompt(message.content);
        const request = new LLMRequest(1, prompt, this.guildHolder.getSchema());
        this.extractionResults = this.guildHolder.getBot().llmQueue.addRequest(request);
        return this.extractionResults.getResponse();
    }

    /**
     * Creates a new revision from a provided LLM extraction response.
     * @param response LLM extraction response to use as the revision content.
     * @param setCurrent Whether to mark the new revision as current.
     */
    public async createRevisionFromExtraction(response: LLMResponse, setCurrent: boolean = true): Promise<Revision> {
        const channel = await this.getSubmissionChannel();
        if (!channel || !channel.isSendable()) {
            throw new Error('Cannot send messages in this submission channel.');
        }

        const currentRevisionRef = this.getRevisionsManager().getCurrentRevision();
        const parentRevision = currentRevisionRef
            ? await this.getRevisionsManager().getRevisionById(currentRevisionRef.id)
            : null;

        const revision: Revision = {
            id: '',
            messageIds: [],
            type: RevisionType.LLM,
            parentRevision: parentRevision?.id || null,
            timestamp: Date.now(),
            records: response.result,
            styles: {},
            references: []
        };

        revision.references = await tagReferencesInSubmissionRecords(
            revision.records,
            parentRevision?.references || [],
            this.guildHolder,
            this.getId()
        ).catch(e => {
            console.error("Failed to tag references:", e);
            return [];
        });

        const messages = await RevisionEmbed.sendRevisionMessages(channel, this, revision, setCurrent);
        revision.id = messages[messages.length - 1].id;
        revision.messageIds = messages.map(m => m.id);

        await this.getRevisionsManager().createRevision(revision);
        if (setCurrent) {
            await this.getRevisionsManager().setCurrentRevision(revision.id, false);
        }

        await this.statusUpdated();
        return revision;
    }

    public isPublishable(withoutEndorsers: boolean = false): boolean {
        const authors = this.config.getConfig(SubmissionConfigs.AUTHORS);
        const archiveChannelId = this.config.getConfig(SubmissionConfigs.ARCHIVE_CHANNEL_ID);
        const submissionTags = this.config.getConfig(SubmissionConfigs.TAGS);
        const mainImages = this.config.getConfig(SubmissionConfigs.IMAGES);
        const attachments = this.config.getConfig(SubmissionConfigs.ATTACHMENTS);

        if (authors === null || !archiveChannelId || submissionTags == null || mainImages === null || attachments === null) {
            // If any of the required fields are missing, we cannot proceed
            return false;
        }

        const current = this.getRevisionsManager().getCurrentRevision();
        if (!current) {
            // If there is no current revision, we cannot proceed
            return false;
        }

        // check endorsers
        if (!withoutEndorsers && this.areEndorsersRequired()) {
            let endorsers = this.config.getConfig(SubmissionConfigs.ENDORSERS);

            // check if self endorsement is disallowed, if so filter out endorsers that are also authors
            const selfEndorsementDisallowed = this.guildHolder.getConfigManager().getConfig(GuildConfigs.SELF_ENDORSEMENT_DISALLOWED);
            if (selfEndorsementDisallowed) {
                const authors = this.config.getConfig(SubmissionConfigs.AUTHORS) || [];
                const authorIds = authors.filter(isDiscordAuthor).map(a => a.id);
                endorsers = endorsers.filter((endorser: any) => {
                    return !authorIds.includes(endorser.id);
                });
            }

            const requiredEndorsements = this.getRequiredEndorsementsCount();

            if (endorsers.length < requiredEndorsements) {
                // If the submission does not meet the endorsement threshold, we cannot proceed
                return false;
            }
        }

        return true; // All conditions met, submission is publishable
    }

    public areEndorsersRequired(): boolean {
        return this.guildHolder.getConfigManager().getConfig(GuildConfigs.ENDORSE_ROLE_IDS).length > 0
            && this.getRequiredEndorsementsCount() > 0;
    }

    public getRequiredEndorsementsCount(): number {
        const count = this.guildHolder.getConfigManager().getConfig(GuildConfigs.MIN_ENDORSEMENTS_REQUIRED);
        return Math.max(0, count);
    }

    public async checkReview() {
        const authors = this.config.getConfig(SubmissionConfigs.AUTHORS);
        const archiveChannelId = this.config.getConfig(SubmissionConfigs.ARCHIVE_CHANNEL_ID);
        const submissionTags = this.config.getConfig(SubmissionConfigs.TAGS);
        const mainImages = this.config.getConfig(SubmissionConfigs.IMAGES);
        const attachments = this.config.getConfig(SubmissionConfigs.ATTACHMENTS);

        if (authors === null || !archiveChannelId || submissionTags == null || mainImages === null || attachments === null) {
            // If any of the required fields are missing, we cannot proceed
            return;
        }

        const revisions = this.getRevisionsManager().getRevisionsList();
        if (revisions.length > 0) {
            return;
        }

        if (this.extractionResults && this.extractionResults.getStatus() === LLMResponseStatus.InProgress) {
            // send typeing indicator
            const channel = await this.getSubmissionChannel();
            if (channel && channel.isSendable()) {
                channel.sendTyping().catch(() => { });
            }
            return; // Wait for extraction to complete
        }

        if (this.reviewLocked) {
            return; // Prevent multiple submissions
        }

        this.reviewLocked = true; // Lock the review process to prevent multiple submissions
        try {
            const initialRevision = await this.getInitialRevision();

            const channel = await this.getSubmissionChannel();
            if (!channel) {
                throw new Error('Submission channel not found');
            }
            const messages = await RevisionEmbed.sendRevisionMessages(channel, this, initialRevision, true);

            initialRevision.id = messages[messages.length - 1].id; // Set the last message ID as the revision ID
            initialRevision.messageIds = messages.map(m => m.id); // Store all message IDs in the revision

            await this.getRevisionsManager().createRevision(initialRevision);
            this.getRevisionsManager().setCurrentRevision(initialRevision.id);
        } catch (error) {
            console.error('Error creating initial revision:', error);
        }
        this.reviewLocked = false; // Unlock the review process
        await this.statusUpdated(); // Update the status of the submission
    }

    public async getInitialRevision(): Promise<Revision> {

        if (this.extractionResults && this.extractionResults.getStatus() === LLMResponseStatus.Success) {

            const response = this.extractionResults.getResponseNow();
            if (!response) {
                throw new Error('No response from LLM extraction');
            }

            const revision: Revision = {
                id: '',
                messageIds: [],
                type: RevisionType.Initial,
                parentRevision: null,
                timestamp: Date.now(),
                records: response.result,
                styles: {},
                references: []
            }

            revision.references = await tagReferencesInSubmissionRecords(revision.records, revision.references, this.guildHolder, this.getId()).catch(e => {
                console.error("Failed to tag references:", e)
                return [];
            });

            return revision;
        } else {
            // If extraction results are not available, we create a default revision
            // get initial message from the submission thread
            const channel = await this.getSubmissionChannel();
            if (!channel) {
                throw new Error('Submission channel not found');
            }

            const message = await channel.fetchStarterMessage().catch(() => null);
            if (!message) {
                throw new Error('Starter message not found');
            }

            const revision: Revision = {
                id: '',
                messageIds: [],
                type: RevisionType.Initial,
                parentRevision: null,
                timestamp: Date.now(),
                records: {
                    error: 'LLM extraction failed! Please revise the submission manually.\n\n' + message.content
                },
                styles: {},
                references: []
            }
            return revision;
        }
    }

    public async processImages() {
        if (this.imagesProcessing) {
            console.error('Images are already being processed');
            return;
        }
        this.imagesProcessing = true;
        try {
            const images = this.config.getConfig(SubmissionConfigs.IMAGES) || [];
            const processedFolder = this.getProcessedImagesFolder();
            const downloadFolder = safeJoinPath(this.folderPath, 'downloaded_images');
            await processImages(images, downloadFolder, processedFolder, this.guildHolder.getBot());
            this.config.setConfig(SubmissionConfigs.IMAGES, images);
            this.imagesProcessing = false;
        } catch (error: any) {
            this.imagesProcessing = false;
            console.error('Error processing images:', error.message);
            throw error;
        }
    }


    public async processAttachments() {
        if (this.attachmentsProcessing) {
            console.error('Attachments are already being processed');
            return;
        }
        this.attachmentsProcessing = true;
        try {
            const attachments = this.config.getConfig(SubmissionConfigs.ATTACHMENTS) || [];
            const attachmentsFolder = this.getAttachmentFolder();
            await processAttachments(attachments, attachmentsFolder, this.guildHolder.getBot());
            this.config.setConfig(SubmissionConfigs.ATTACHMENTS, attachments);
            this.attachmentsProcessing = false;
        } catch (error: any) {
            this.attachmentsProcessing = false;
            console.error('Error processing attachments:', error.message);
            throw error;
        }
    }

    public shouldOptimizeAttachments(): boolean {
        const attachments = this.config.getConfig(SubmissionConfigs.ATTACHMENTS) || [];
        return attachments.some((att: Attachment) => {
            return att.wdl && !att.wdl.optimized;
        });
    }
    public async optimizeAttachments(progressCallback?: (message: string) => Promise<void>) {
        try {
            const attachments = this.config.getConfig(SubmissionConfigs.ATTACHMENTS) || [];
            const attachmentsFolder = this.getAttachmentFolder();
            await optimizeAttachments(
                attachments, attachmentsFolder, this.getTempFolder(),
                progressCallback || (async (_message: string) => { })
            );
            this.config.setConfig(SubmissionConfigs.ATTACHMENTS, attachments);
        } catch (error: any) {
            console.error('Error optimizing attachments:', error.message);
            throw error;
        }
    }

    public getProcessedImagesFolder(): string {
        return safeJoinPath(this.folderPath, 'processed_images');
    }

    public getAttachmentFolder(): string {
        return safeJoinPath(this.folderPath, 'attachments');
    }

    public getTempFolder(): string {
        return safeJoinPath(this.folderPath, 'temp');
    }

    public async sendNotificationsToSubscribers(channel: TextThreadChannel) {
        const subscriptionManager = this.guildHolder.getUserSubscriptionManager();
        const archiveChannelId = this.getConfigManager().getConfig(SubmissionConfigs.ARCHIVE_CHANNEL_ID);
        const subscribers = await subscriptionManager.getSubscribersForChannel(archiveChannelId);

        // editor rotation
        if (this.guildHolder.getConfigManager().getConfig(GuildConfigs.EDITOR_ROTATION_ENABLED)) {
            const nextEditor = await this.guildHolder.getNextEditorForRotation();
            if (nextEditor) {
                const message = `An editor has been automatically assigned to this submission: <@${nextEditor.id}>.`;
                await channel.send({ content: message });
            }
        }


        const members = await this.guildHolder.getGuild().members.fetch({
            user: subscribers
        });
        const ids = [];
        for (const userId of subscribers) {
            if (members.has(userId)) {
                ids.push(userId);
            }
        }

        if (ids.length > 0) {
            const message = splitIntoChunks(`Notifying ${ids.length} members subscribed to <#${archiveChannelId}>: ${ids.map(m => `<@${m}>`).join(' ')}`, 2000);
            for (const msg of message) {
                await channel.send({ content: msg });
            }
        }

        // channel subscriptions
        const channelSubscriptionManager = this.guildHolder.getChannelSubscriptionManager();
        const channelSubscriptions = await channelSubscriptionManager.getSubscriptions();

        const matched = await RuleMatcher.matchAll(this, channelSubscriptions);

        const authorsString = getAuthorsString(this.getConfigManager().getConfig(SubmissionConfigs.AUTHORS) || []);
        const tagString = (this.getConfigManager().getConfig(SubmissionConfigs.TAGS) || []).map((tag) => tag.name).join(', ');
        const textArr = [
            `**Authors:** ${authorsString}`,
            `**Tags:** ${tagString || 'None'}`,
            `**Channel:** <#${archiveChannelId}>`,
        ];

        // if (record && record.records.description) {
        //     textArr.push(`\n${record.records.description}`);
        // }

        const text = textArr.join('\n');
        for (const [logChannelId, _] of Object.entries(matched)) {
            const logChannel = await this.guildHolder.getGuild().channels.fetch(logChannelId).catch(() => null);
            const embed = new EmbedBuilder()
                .setTitle(this.getConfigManager().getConfig(SubmissionConfigs.NAME) || 'Unnamed Submission')
                .setDescription(text)
                .setURL(channel.url)
                .setColor(0x00FF00)

            // check if it has image
            const images = this.getConfigManager().getConfig(SubmissionConfigs.IMAGES) || [];
            if (images.length > 0) {
                embed.setThumbnail(images[0].url);
            }

            if (logChannel && logChannel.isSendable()) {
                await logChannel.send({
                    embeds: [embed],
                    allowedMentions: { parse: [] }
                });
            }
        }
    }

    public async statusUpdated() {
        try {
            const statusMessageId = this.config.getConfig(SubmissionConfigs.STATUS_MESSAGE_ID);
            if (!statusMessageId) {
                throw new Error('Status message not sent yet!');
            }

            const channel = await this.getSubmissionChannel(true);
            if (!channel) {
                throw new Error('Submission channel not found');
            }

            const wasArchived = channel.archived;
            if (wasArchived) {
                await channel.setArchived(false);
            }

            const message = await channel.messages.fetch(statusMessageId).catch(() => null);

            if (!message) {
                throw new Error('Status message not found');
            }

            const updatedAuthors = await reclassifyAuthors(this.guildHolder, this.getConfigManager().getConfig(SubmissionConfigs.AUTHORS) || []);
            if (updatedAuthors.length > 0) {
                this.getConfigManager().setConfig(SubmissionConfigs.AUTHORS, updatedAuthors);
            }

            const updatedEndorsers = await reclassifyAuthors(this.guildHolder, this.getConfigManager().getConfig(SubmissionConfigs.ENDORSERS) || []);
            if (updatedEndorsers.length > 0) {
                this.getConfigManager().setConfig(SubmissionConfigs.ENDORSERS, updatedEndorsers);
            }

            const starterEmbed = await StarterEmbed.create(this);
            await message.edit({ embeds: [starterEmbed.getEmbed()], components: [starterEmbed.getRow() as any] });


            const status = this.config.getConfig(SubmissionConfigs.STATUS);
            if (this.isPublishable(true) && !this.isPublishable()) {
                // If the submission is publishable but needs endorsement, we notify the owner
                if (status === SubmissionStatus.NEW || status === SubmissionStatus.WAITING) {
                    this.config.setConfig(SubmissionConfigs.STATUS, SubmissionStatus.NEED_ENDORSEMENT);
                    if (status === SubmissionStatus.NEW) {
                        await channel.send({
                            content: `<@${channel.ownerId}> Your submission now requires endorsement before it can be published. Please wait for the endorsers to review it. Do not ping them directly, they will review it when they have time.`,
                        });
                        if (this.areEndorsersRequired()) {
                            this.sendNotificationsToSubscribers(channel).catch((e) => {
                                console.error('Error sending notifications to subscribers:', e);
                            });
                        }
                    }
                }
            } else if (this.isPublishable()) {
                if (status === SubmissionStatus.NEW || status === SubmissionStatus.NEED_ENDORSEMENT) {
                    this.config.setConfig(SubmissionConfigs.STATUS, SubmissionStatus.WAITING);

                    if (this.getConfigManager().getConfig(SubmissionConfigs.ON_HOLD)) {
                        await channel.send({
                            content: `<@${channel.ownerId}> Your submission is now ready to be published, but it is currently on hold. Editors must release the hold before it can be published. The reason for the hold is: ${this.getConfigManager().getConfig(SubmissionConfigs.HOLD_REASON) || 'No reason provided.'}`,
                        });
                    } else {
                        const publishButton = new PublishButton().getBuilder(false);

                        await channel.send({
                            content: `<@${channel.ownerId}> Congratulations! Your submission is now ready to be published! Click the button below to proceed.`,
                            components: [(new ActionRowBuilder().addComponents(publishButton)) as any]
                        });

                        if (!this.areEndorsersRequired()) {
                            this.sendNotificationsToSubscribers(channel).catch((e) => {
                                console.error('Error sending notifications to subscribers:', e);
                            });
                        }
                    }
                }
            }

            await this.updateTags(); // Update tags based on the current status

            if (wasArchived) {
                await channel.setArchived(true);
            }
        } catch (error) {
            console.error('Error updating status:', error);
        }

    }

    public async updateTags() {
        const channel = await this.getSubmissionChannel();
        if (!channel) {
            console.error('Submission channel not found, cannot update tags');
            return; // No channel found, cannot update tags
        }

        if (!channel.parentId) {
            console.error('Submission channel has no parent channel, cannot update tags');
            return; // No parent channel, cannot update tags
        }


        const forumChannel = await this.guildHolder.getGuild().channels.fetch(channel.parentId);
        if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
            console.error('Parent channel is not a forum channel, cannot update tags');
            return;
        }

        const availableTags = forumChannel.availableTags;
        const currentTags = channel.appliedTags;
        const newTagNames = [];


        const status = this.getConfigManager().getConfig(SubmissionConfigs.STATUS);
        const isLocked = this.getConfigManager().getConfig(SubmissionConfigs.IS_LOCKED);
        const isOnHold = this.getConfigManager().getConfig(SubmissionConfigs.ON_HOLD);

        switch (status) {
            case SubmissionStatus.NEW:
                newTagNames.push(SubmissionTagNames.NEW);
                break;
            case SubmissionStatus.WAITING:
                newTagNames.push(SubmissionTagNames.WAITING_FOR_PUBLICATION);
                break;
            case SubmissionStatus.ACCEPTED:
                newTagNames.push(SubmissionTagNames.PUBLISHED);
                break;
            case SubmissionStatus.RETRACTED:
                newTagNames.push(SubmissionTagNames.RETRACTED);
                break;
            case SubmissionStatus.REJECTED:
                newTagNames.push(SubmissionTagNames.REJECTED);
                break;
            case SubmissionStatus.NEED_ENDORSEMENT:
                newTagNames.push(SubmissionTagNames.NEED_ENDORSEMENT);
                break;
        }

        if (isLocked) {
            newTagNames.push(SubmissionTagNames.LOCKED);
        }
        if (isOnHold) {
            newTagNames.push(SubmissionTagNames.ON_HOLD);
        }

        const newTags = [];
        for (const tagName of newTagNames) {
            const tag = availableTags.find(t => t.name === tagName);
            if (tag) {
                newTags.push(tag.id);
            }
        }

        currentTags.forEach(tagId => {
            const tag = availableTags.find(t => t.id === tagId);
            if (tag && !SubmissionTags.find(t => t.name === tag.name)) {
                // If the tag is not a standard submission tag, we keep it
                newTags.push(tag.id);
            }
        });

        await channel.setAppliedTags(newTags)
    }

    public async handleMessage(_message: Message): Promise<boolean> {
        this.checkLLMExtraction();
        // if (message.reference && message.reference.type === MessageReferenceType.Default) {
        //     // its a reply
        //     return await this.handleReplies(message);
        // }
        return false;
    }

    async handleReplies(message: Message): Promise<boolean> {
        // Make sure it isn't bot
        if (message.author.bot || message.system || message.reference?.messageId === undefined) {
            return false;
        }

        // Check if message id is in revisions
        const revisions = this.getRevisionsManager().getRevisionsList();
        if (!revisions.some(r => r.id === message.reference?.messageId)) {
            return false;
        }

        // It's a reply to the bot for a revision
        const revision = await this.getRevisionsManager().getRevisionById(message.reference.messageId)
        if (!revision) {
            console.error('Revision not found', message.reference.messageId)
            return true;
        }

        if (this.llmReviseResponse && this.llmReviseResponse.getStatus() === LLMResponseStatus.InProgress) {
            console.log('LLM revise promise already in progress')
            message.reply('Revision already in progress, please wait')
            return true;
        }

        const wmsg = await message.reply('Processing revision, please wait');

        // send typing indicator
        const channel = message.channel;
        if (channel && channel.isSendable()) {
            channel.sendTyping().catch(() => { });
        }


        let response
        try {
            this.llmReviseResponse = this.useLLMRevise(message.content, revision)
            response = await this.llmReviseResponse.getResponse();
            await wmsg.delete()
        } catch (error) {
            console.error('Error using LLM:', error)
            await message.reply('Error using LLM, please check the logs')
            this.llmReviseResponse = undefined;
            return true;
        }

        this.llmReviseResponse = undefined;

        const isCurrent = this.getRevisionsManager().isRevisionCurrent(revision.id);

        const newRevisionData: Revision = {
            id: "",
            messageIds: [],
            type: RevisionType.LLM,
            parentRevision: revision.id,
            timestamp: Date.now(),
            records: response.result,
            styles: {},
            references: []
        }

        await message.reply({
            content: `<@${message.author.id}> I've edited the submission${isCurrent ? ' and set it as current' : ''}`
        })

        if (!message.channel.isSendable()) {
            throw new Error('Cannot send messages in this channel');
        }

        newRevisionData.references = await tagReferencesInSubmissionRecords(newRevisionData.records, revision.references, this.guildHolder, this.getId()).catch(e => {
            console.error("Failed to tag references:", e)
            return [];
        });

        const messages = await RevisionEmbed.sendRevisionMessages(message.channel, this, newRevisionData, isCurrent);
        newRevisionData.id = messages[messages.length - 1].id; // Set the last message ID as the revision ID
        newRevisionData.messageIds = messages.map(m => m.id); // Store all message IDs in the revision
        await this.getRevisionsManager().createRevision(newRevisionData);
        if (isCurrent) {
            await this.getRevisionsManager().setCurrentRevision(newRevisionData.id, false);
        }
        this.statusUpdated();
        return true;
    }

    setLock(locked: boolean, reason: string = '') {
        this.config.setConfig(SubmissionConfigs.IS_LOCKED, locked);
        this.config.setConfig(SubmissionConfigs.LOCK_REASON, reason);
    }

    setHold(hold: boolean) {
        this.config.setConfig(SubmissionConfigs.ON_HOLD, hold);
    }

    useLLMRevise(prompt: string, revision: Revision): LLMResponseFuture {
        // request llm response
        const llmPrompt = new ModificationPrompt(
            prompt,
            revision
        )
        const request = new LLMRequest(1, llmPrompt, this.guildHolder.getSchema());
        return this.guildHolder.getBot().llmQueue.addRequest(request);
    }


    public updateLastAccessed() {
        this.lastAccessed = Date.now();
    }

    public async load() {
        await this.config.loadConfig();
    }

    public async save() {
        await this.config.saveConfig();
    }

    public canJunk(): boolean {
        if (this.extractionResults && this.extractionResults.getStatus() === LLMResponseStatus.InProgress) {
            return false; // Cannot junk while LLM response is in progress
        }

        if (this.llmReviseResponse && this.llmReviseResponse.getStatus() === LLMResponseStatus.InProgress) {
            return false; // Cannot junk while LLM revise response is in progress
        }

        if (this.imagesProcessing) {
            return false; // Cannot junk while images are being processed
        }

        if (this.attachmentsProcessing) {
            return false; // Cannot junk while attachments are being processed
        }

        if (this.tagging) {
            return false;
        }

        return true;
    }

    public getId(): Snowflake {
        return this.id;
    }

    public getConfigManager(): ConfigManager {
        return this.config;
    }

    async getAttachments(): Promise<BaseAttachment[]> {
        return this.cachedAttachments.get();
    }

    async getAttachmentById(attachmentId: string): Promise<Attachment | null> {
        const currentAttachments = await this.config.getConfig(SubmissionConfigs.ATTACHMENTS) || [];
        const attachment = currentAttachments.find((att: Attachment) => att.id === attachmentId);
        if (attachment) {
            return attachment;
        }
        // otherwise, check all attachments in the channel
        const allAttachments = await this.getAttachments();
        const found = allAttachments.find(att => att.id === attachmentId);
        return found || null;
    }

    public async publish(silent: boolean = false, force: boolean = false, reprocessImages: boolean = false, details?: PublishCommitMessage, statusCallback?: (status: string) => Promise<void>) {
        if (this.publishLock) {
            throw new Error('Publish is already in progress');
        }

        this.publishLock = true;


        let oldEntryData, newEntryData;

        if (this.shouldOptimizeAttachments()) {
            await this.optimizeAttachments(statusCallback);
        }

        try {
            const dt = await this.guildHolder.getRepositoryManager().addOrUpdateEntryFromSubmission(this, force, reprocessImages, details, statusCallback);
            oldEntryData = dt.oldEntryData;
            newEntryData = dt.newEntryData;
        } catch (error) {
            this.publishLock = false;
            throw error;
        }

        if (statusCallback) {
            await statusCallback('Finalizing publication...');
        }

        if (!silent) {
            try {
                await this.guildHolder.logUpdate(oldEntryData, newEntryData, details);
            } catch (error) {
                this.publishLock = false;
                throw error;
            }
        }

        this.guildHolder.getRepositoryManager().updateSubmissionFromEntryData(this, newEntryData);
        this.getConfigManager().setConfig(SubmissionConfigs.STATUS, SubmissionStatus.ACCEPTED);

        if (this.areEndorsersRequired()) {
            this.setLock(true, 'Auto-locked after publish to prevent republishing. Please contact an editor/endorser to unlock it if needed.');
        }

        await this.statusUpdated();
        this.publishLock = false;
    }

    public async getPotentialAuthorsFromMessageContent(): Promise<DiscordAuthor[]> {
        const channel = await this.getSubmissionChannel(true);
        if (!channel) {
            throw new Error('Submission channel not found');
        }

        const message = await channel.fetchStarterMessage().catch(() => null);
        let authorCandidates: Snowflake[] = [];
        if (message && message.content) {
            const users = extractUserIdsFromText(message.content);
            for (const userId of users) {

                if (authorCandidates.includes(userId)) {
                    continue; // Skip if user is already in the list
                }

                if (authorCandidates.length >= 25) {
                    break; // Limit to 25 authors
                }

                authorCandidates.push(userId);
            }
        }

        if (authorCandidates.length === 0) { // add the owner as author if no authors found
            authorCandidates.push(channel.ownerId);
        }

        // limit to 25 authors just in case
        if (authorCandidates.length > 25) {
            authorCandidates = authorCandidates.slice(0, 25);
        }

        return await getDiscordAuthorsFromIDs(this.guildHolder, authorCandidates);
    }

    public async retract() {
        if (this.publishLock) {
            throw new Error('Retract is already in progress');
        }

        this.publishLock = true;
        const reason = this.getConfigManager().getConfig(SubmissionConfigs.RETRACTION_REASON);

        let oldEntryData;
        try {
            oldEntryData = await this.guildHolder.getRepositoryManager().retractSubmission(this, reason);
        } catch (error) {
            this.publishLock = false;
            throw error;
        }

        try {
            await this.guildHolder.logRetraction(oldEntryData, reason);
        } catch (error) {
            this.publishLock = false;
            throw error;
        }

        this.getConfigManager().setConfig(SubmissionConfigs.STATUS, SubmissionStatus.RETRACTED);
        await this.statusUpdated();
        this.publishLock = false;

    }

    public async handleThreadUpdate(oldThread: AnyThreadChannel, newThread: AnyThreadChannel) {
        // check if name changed
        if (oldThread.name !== newThread.name) {
            this.getConfigManager().setConfig(SubmissionConfigs.NAME, newThread.name);

            const channel = await this.getSubmissionChannel();
            if (!channel) {
                return; // No channel found, cannot update thread name
            }

            // update status
            await this.statusUpdated();
            // update revisions
            await this.updateRevisions();
        }

    }


    public async onAuthorsUpdated() {
        this.tagging = true;
        const authors = this.getConfigManager().getConfig(SubmissionConfigs.AUTHORS) || [];
        const old = this.getConfigManager().getConfig(SubmissionConfigs.AUTHORS_REFERENCES);

        const newRefs = await tagReferencesInAcknowledgements(authors, old, this.guildHolder, this.getId()).catch(e => {
            console.error("Failed to tag references in acknowledgements:", e)
            return [];
        });

        this.getConfigManager().setConfig(SubmissionConfigs.AUTHORS_REFERENCES, newRefs);

        this.tagging = false;

        await this.updateRevisions();
    }

    public async updateRevisions() {
        const thread = await this.getSubmissionChannel();
        if (!thread) {
            return; // No channel found, cannot update revisions
        }
        const revisions = this.getRevisionsManager().getRevisionsList();
        for (const revisionRef of revisions) {
            if (!revisionRef.isCurrent) {
                continue; // Only update current revision
            }

            const revision = await this.getRevisionsManager().getRevisionById(revisionRef.id);
            if (!revision) {
                continue; // Skip if revision not found
            }

            // Update the revision message with the new thread name
            const messages = await Promise.all(revision.messageIds.map(async (messageId) => {
                return await thread.messages.fetch(messageId);
            })).catch(() => null);
            if (!messages) {
                console.warn(`Messages for revision ${revision.id} not found in thread ${thread.id}`);
                continue;
            }
            await RevisionEmbed.editRevisionMessages(messages, this, revision, revisionRef.isCurrent).catch((error) => {
                console.error(`Error updating revision messages for revision ${revision.id}:`, error);
            });
        }
    }

    public getRevisionsManager(): RevisionManager {
        return this.revisions;
    }

    public getFolderPath(): string {
        return this.folderPath;
    }

    public getGuildHolder(): GuildHolder {
        return this.guildHolder;
    }

    public clearAttachmentsCache() {
        this.cachedAttachments.clear();
    }
}
