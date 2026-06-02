import { ActionRowBuilder, EmbedBuilder } from "discord.js";
import { Submission } from "../submissions/Submission.js";
import { SubmissionConfigs } from "../submissions/SubmissionConfigs.js";
import { SetArchiveChannelButton } from "../components/buttons/SetArchiveChannelButton.js";
import { SetTagsButton } from "../components/buttons/SetTagsButton.js";
import { SetAttachmentsButton } from "../components/buttons/SetAttachmentsButton.js";
import { SetAuthorsButton } from "../components/buttons/SetAuthorsButton.js";
import { getAuthorsString } from "../utils/Util.js";
import { PublishButton } from "../components/buttons/PublishButton.js";
import { SubmissionStatus } from "../submissions/SubmissionStatus.js";

export class StarterEmbed {
    private embed: EmbedBuilder;
    private row: ActionRowBuilder;

    constructor(embed: EmbedBuilder, row: ActionRowBuilder) {
        this.embed = embed;
        this.row = row;
    }

    public getEmbed(): EmbedBuilder {
        return this.embed;
    }

    public getRow(): ActionRowBuilder {
        return this.row;
    }

    public static async create(submission: Submission): Promise<StarterEmbed> {
        const configs = submission.getConfigManager();
        const submissionChannel = await submission.getSubmissionChannel();
        if (!submissionChannel) {
            throw new Error('Submission channel not found');
        }
        const authors = configs.getConfig(SubmissionConfigs.AUTHORS);
        const archiveChannelID = configs.getConfig(SubmissionConfigs.ARCHIVE_CHANNEL_ID);
        const tags = configs.getConfig(SubmissionConfigs.TAGS);
        const images = configs.getConfig(SubmissionConfigs.IMAGES);
        const attachments = configs.getConfig(SubmissionConfigs.ATTACHMENTS);
        const endorsers = configs.getConfig(SubmissionConfigs.ENDORSERS);
        const status = configs.getConfig(SubmissionConfigs.STATUS);
        const requiresEndorsements = submission.areEndorsersRequired();
        const requiredEndorsementCount = submission.getRequiredEndorsementsCount();
        const embed = new EmbedBuilder()
        if (status === SubmissionStatus.ACCEPTED) {
            embed.setColor('#00ff00')
        } else if (status === SubmissionStatus.REJECTED) {
            embed.setColor('#ff0000')
        } else if (status === SubmissionStatus.RETRACTED) {
            embed.setColor('#ff8800')
        } else if (configs.getConfig(SubmissionConfigs.ON_HOLD) || configs.getConfig(SubmissionConfigs.IS_LOCKED)) {
            embed.setColor('#ffff00')
        } else {
            embed.setColor('#0099ff')
        }

        embed.setTitle('Submission Status')

        let description = 'Thank you for submitting your work! Before we can publish your submission, the following needs to be completed:'
        description += '\n\n**Submission Progress**\n'

        if (authors !== null) {
            description += `:white_check_mark: Chose authors: ${getAuthorsString(authors.filter(o => !o.dontDisplay))}\n`
            const authorsWithoutDisplay = authors.filter(o => o.dontDisplay);
            if (authorsWithoutDisplay.length > 0) {
                description += `:white_check_mark: Added acknowledgements: ${getAuthorsString(authorsWithoutDisplay)}\n`
            }

        } else {
            description += ':zero: Choose authors\n'
        }

        if (archiveChannelID) {
            description += `:white_check_mark: Chose a channel: <#${archiveChannelID}>\n`
        } else {
            description += ':one: Choose a channel\n'
        }

        if (tags !== null) {
            description += `:white_check_mark: Chose tags: ${tags.length ? tags.map(o => o.name).join(', ') : 'No tags'}\n`
        } else {
            description += ':two: Choose tags\n'
        }

        if (images) {
            description += `:white_check_mark: Chose image attachments: ${images.length ? images.map(o => o.url).join(' , ') : 'No images'}\n`
        } else {
            description += ':three: Choose image attachments\n'
        }

        if (attachments !== null) {
            description += `:white_check_mark: Finalized other attachments: ${attachments.length ? attachments.map(o => o.canDownload ? o.url : (o.url ? `[${o.name}](${o.url})` : o.name)).join(' , ') : 'No attachments'}\n`
        } else {
            description += ':four: Finalize other attachments\n'
        }

        if (requiresEndorsements) {
            const endorsementProgress = `${endorsers.length}/${requiredEndorsementCount}`;
            if (endorsers.length >= requiredEndorsementCount) {
                description += `:white_check_mark: Endorsed (${endorsementProgress}): ${endorsers.length ? getAuthorsString(endorsers) : 'No endorsers listed'}\n`
            } else {
                const outstanding = requiredEndorsementCount - endorsers.length;
                description += `:five: Obtain endorsements (${endorsementProgress}, need ${outstanding} more)\n`
            }
        }

        if (status === SubmissionStatus.WAITING) {
            description += `:pray: Waiting for <@${submissionChannel.ownerId}> to publish the submission\n`
        } else if (status === SubmissionStatus.ACCEPTED) {
            description += `:tada: Published at ${submission.getConfigManager().getConfig(SubmissionConfigs.POST)?.threadURL}\n`
        } else if (status === SubmissionStatus.REJECTED) {
            description += `:no_entry: The submission was rejected. Reason: ${configs.getConfig(SubmissionConfigs.REJECTION_REASON) || 'No reason provided.'}\n`
        } else if (status === SubmissionStatus.RETRACTED) {
            description += `:x: The submission was retracted from the archive. Reason: ${configs.getConfig(SubmissionConfigs.RETRACTION_REASON) || 'No reason provided.'}\n`
        }

        if (configs.getConfig(SubmissionConfigs.ON_HOLD)) {
            description += `:pause_button: The submission is currently on hold. Reason: ${configs.getConfig(SubmissionConfigs.HOLD_REASON) || 'No reason provided.'}\n`
        }

        if (configs.getConfig(SubmissionConfigs.IS_LOCKED)) {
            description += `:lock: The submission is currently locked from republishing. Reason: ${configs.getConfig(SubmissionConfigs.LOCK_REASON) || 'No reason provided.'}\n`
        }

        description += `\nLast updated: <t:${Math.floor(Date.now() / 1000)}:F>`

        // Link to the latest version of the submission
        const currentRevision = submission.getRevisionsManager().getCurrentRevision();
        if (currentRevision) {
            try {
                const message = await submissionChannel.messages.fetch(currentRevision.id);
                description += `\n\n[View latest submission draft](${message.url})`
            } catch (e: any) {
                //console.error(`Failed to fetch the latest submission draft: ${currentRevision.id} ${e.message}`);
            }
        }

        embed.setDescription(description)


        // Post

        const row = new ActionRowBuilder()
            .addComponents(new SetAuthorsButton().getBuilder(authors !== null))

        if (authors !== null) {
            row.addComponents(new SetArchiveChannelButton().getBuilder(!!archiveChannelID))

            if (archiveChannelID) {
                row.addComponents(new SetTagsButton().getBuilder(tags !== null))

                if (tags !== null) {
                    row.addComponents(new SetAttachmentsButton().getBuilder(attachments !== null));
                }
            }
        }

        if (submission.isPublishable()) {
            row.addComponents(new PublishButton().getBuilder(status === SubmissionStatus.ACCEPTED));
        }

        return new StarterEmbed(embed, row);
    }

}
