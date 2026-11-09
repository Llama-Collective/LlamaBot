import { ActionRowBuilder, FileUploadBuilder, LabelBuilder, MessageFlags, ModalBuilder, ModalSubmitInteraction, TextInputBuilder, TextInputStyle } from "discord.js";
import { GuildHolder } from "../../GuildHolder.js";
import { Modal } from "../../interface/Modal.js";
import { canEditSubmission, escapeDiscordString, formatSize, replyEphemeral, truncateStringWithEllipsis } from "../../utils/Util.js";
import { SubmissionConfigs } from "../../submissions/SubmissionConfigs.js";
import { Attachment, AttachmentSource } from "../../submissions/Attachment.js";
import { filterAttachments, getAttachmentSetMessage, getAttachmentsFromText } from "../../utils/AttachmentUtils.js";
import { AuthorType } from "../../submissions/Author.js";
import { SetAttachmentsMenu } from "../menus/SetAttachmentsMenu.js";
import { EditInfoMultipleButton } from "../buttons/EditInfoMultipleButton.js";
import { GuildConfigs } from "../../config/GuildConfigs.js";

export class AddAttachmentModal implements Modal {
    getID(): string {
        return "add-attachment-modal";
    }

    getBuilder(ordinal: number): ModalBuilder {
        const modal = new ModalBuilder()
            .setCustomId(this.getID())
            .setTitle('Add Attachment')

        const uploadInput = new FileUploadBuilder()
            .setCustomId('attachmentInput')
            .setMaxValues(1)
            .setRequired(false);

        const uploadLabel = new LabelBuilder()
            .setLabel('Upload attachment:')
            .setFileUploadComponent(uploadInput);

        const urlInput = new TextInputBuilder()
            .setCustomId('urlInput')
            .setPlaceholder('Or put a URL here instead')
            .setStyle(TextInputStyle.Short)
            .setRequired(false);

        const urlLabel = new LabelBuilder()
            .setLabel('URL (optional):')
            .setTextInputComponent(urlInput);

        const descriptionInput = new TextInputBuilder()
            .setCustomId('descriptionInput')
            .setPlaceholder('Optional description')
            .setMaxLength(300)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false);

        const descriptionLabel = new LabelBuilder()
            .setLabel('Attachment Description:')
            .setTextInputComponent(descriptionInput);

        const orderInput = new TextInputBuilder()
            .setCustomId('orderInput')
            .setPlaceholder('Lower numbers are displayed first.')
            .setStyle(TextInputStyle.Short)
            .setValue(ordinal.toString())
            .setRequired(true)

        const orderLabel = new LabelBuilder()
            .setLabel('Ordinal:')
            .setTextInputComponent(orderInput);

        modal.addLabelComponents(
            uploadLabel,
            urlLabel,
            descriptionLabel,
            orderLabel
        );

        return modal
    }

    async execute(guildHolder: GuildHolder, interaction: ModalSubmitInteraction): Promise<void> {
        const submissionId = interaction.channelId
        if (!submissionId) {
            replyEphemeral(interaction, 'Submission ID not found')
            return
        }

        const submission = await guildHolder.getSubmissionsManager().getSubmission(submissionId)
        if (!submission) {
            replyEphemeral(interaction, 'Submission not found')
            return
        }

        if (
            !canEditSubmission(interaction, submission)
        ) {
            replyEphemeral(interaction, 'You do not have permission to use this!')
            return;
        }

        if (submission.attachmentsProcessing) {
            replyEphemeral(interaction, 'Attachments are currently being processed. Please wait until they are done.');
            return;
        }

        // check if attachments exceed 10
        if ((submission.getConfigManager().getConfig(SubmissionConfigs.ATTACHMENTS) || []).length >= 10) {
            replyEphemeral(interaction, 'You cannot add more than 10 attachments to a submission!');
            return;
        }

        const uploadedAttachment = interaction.fields.getUploadedFiles('attachmentInput')?.first();
        const url = interaction.fields.getTextInputValue('urlInput');
        const description = (interaction.fields.getTextInputValue('descriptionInput') || '').replace(/\n/g, ' ').trim();
        const ordinal = parseInt(interaction.fields.getTextInputValue('orderInput')) || 0;

        if (!uploadedAttachment && !url) {
            replyEphemeral(interaction, 'No attachment uploaded or URL provided. Please try again.');
            return;
        }

        if (uploadedAttachment && url) {
            replyEphemeral(interaction, 'Please provide either an uploaded attachment or a URL, not both.');
            return;
        }

        if (description.length > 300) {
            replyEphemeral(interaction, 'Description cannot exceed 300 characters!');
            return;
        }

        const textAttachments = getAttachmentsFromText(url, [], Date.now(), {
            type: AuthorType.DiscordExternal,
            id: interaction.user.id,
            username: interaction.user.username,
            iconURL: interaction.user.displayAvatarURL()
        });

        if (textAttachments.length === 0 && !uploadedAttachment) {
            replyEphemeral(interaction, 'No valid attachments found at the provided URL.');
            return;
        }

        // create webhook
        const submissionChannel = await submission.getSubmissionChannel();
        if (!submissionChannel || !submissionChannel.parent) {
            replyEphemeral(interaction, 'Submission channel not found.');
            return;
        }

        if (textAttachments.length > 0 && description) {
            textAttachments[0].description = description;
        }

        const attachmentObj: Attachment = !uploadedAttachment ? textAttachments[0] : {
            id: uploadedAttachment.id,
            name: uploadedAttachment.name,
            url: uploadedAttachment.url,
            timestamp: Date.now(),
            author: {
                type: AuthorType.DiscordExternal,
                id: interaction.user.id,
                username: interaction.user.username,
                iconURL: interaction.user.displayAvatarURL()
            },
            source: AttachmentSource.DirectUpload,
            description: description,
            contentType: uploadedAttachment.contentType || 'unknown',
            canDownload: true,
        };

        if (filterAttachments([attachmentObj]).length === 0) {
            replyEphemeral(interaction, 'The provided attachment type is not supported.');
            return;
        }

        if (!interaction.isFromMessage()) {
            return; // should not happen
        }

        await interaction.update({
            content: 'Adding attachment...',
            embeds: [],
            components: [],
            files: [],
        });

        if (uploadedAttachment) {
            const webhook = await submissionChannel.parent.createWebhook({
                name: 'LlamaBot Attachment Uploader',
            });

            const member = interaction.guild?.members.cache.get(interaction.user.id);

            const message = await webhook.send({
                username: member?.displayName || interaction.user.username,
                avatarURL: member?.displayAvatarURL(),
                content: description.length > 0 ? `Description: ${description}` : '',
                allowedMentions: { parse: [] },
                threadId: submissionChannel.id,
                flags: [MessageFlags.SuppressEmbeds],
                files: [
                    {
                        name: attachmentObj.name,
                        attachment: attachmentObj.url
                    }
                ]
            }).catch((e) => {
                console.log("Failed to post with webhook", e)
            });

            await webhook.delete().catch(() => { /* ignore */ });

            // set new URL from message attachment
            const msgAttachment = message?.attachments.first();
            if (msgAttachment) {
                attachmentObj.url = msgAttachment.url;
                attachmentObj.id = msgAttachment.id;
            }
        }

        const currentAttachments = submission.getConfigManager().getConfig(SubmissionConfigs.ATTACHMENTS) ?? [];
        const ordinalClamped = Math.min(Math.max(1, ordinal), currentAttachments.length + 1);
        currentAttachments.splice(ordinalClamped - 1, 0, attachmentObj);


        submission.getConfigManager().setConfig(SubmissionConfigs.ATTACHMENTS, currentAttachments);

        try {
            await submission.processAttachments()
        } catch (error: any) {
            console.error('Error processing attachments:', error)
            await interaction.editReply({
                content: 'Failed to process attachments: ' + error.message,
                flags: MessageFlags.SuppressEmbeds
            });
            return;
        }

         if (submission.shouldOptimizeAttachments()) {
            await interaction.editReply({
                content: 'Optimizing WDLs, this may take a while...',
                embeds: [],
                components: [],
                files: [],
            }).catch(() => { });
            try {
                await submission.optimizeAttachments()
            } catch (error: any) {
                console.error('Error optimizing attachments:', error)
                await interaction.editReply({
                    content: 'Failed to optimize attachments: ' + error.message,
                    flags: MessageFlags.SuppressEmbeds
                });
                return;
            }
        }

        await submission.save();

        await SetAttachmentsMenu.sendAttachmentsMenuAndButton(submission, interaction, true);


        let message = `<@${interaction.user.id}> added attachment:\n${getAttachmentSetMessage(attachmentObj, {
            serverId: guildHolder.getGuild().id,
            submissionId: submission.getId(),
        })}`;

        const editDescriptionButton = new EditInfoMultipleButton().getBuilder(false);
        const row = new ActionRowBuilder().addComponents(editDescriptionButton);

        await interaction.followUp({
            content: truncateStringWithEllipsis(message, 2000),
            flags: [MessageFlags.SuppressEmbeds],
            allowedMentions: { parse: [] },
            components: [row as any],
        })

        const sizeWarningThreshold = guildHolder.getConfigManager().getConfig(GuildConfigs.ATTACHMENT_SIZE_WARNING_THRESHOLD);
        if (attachmentObj.size && attachmentObj.size >= sizeWarningThreshold) {
            let warningMessage = `⚠️ **Warning:** The attachment you just added is quite large (over ${formatSize(sizeWarningThreshold)}):\n`;
            warningMessage += `- ${escapeDiscordString(attachmentObj.name)} (${formatSize(attachmentObj.size)})\n`;
            warningMessage += `\nLarge attachments may contribute to Github's rate limits. Consider optimizing them or using external hosting services for very large files (EG mediafire or YouTube).`;
            await interaction.followUp({
                content: warningMessage,
                flags: [MessageFlags.SuppressEmbeds],
                allowedMentions: { parse: [] },
            });
        }
        
        await submission.statusUpdated();
        submission.checkReview();
    }
}