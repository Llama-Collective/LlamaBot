import { ActionRowBuilder, AttachmentBuilder, EmbedBuilder, FileUploadBuilder, LabelBuilder, MessageFlags, ModalBuilder, ModalSubmitInteraction, TextInputBuilder, TextInputStyle } from "discord.js";
import { GuildHolder } from "../../GuildHolder.js";
import { Modal } from "../../interface/Modal.js";
import { canEditSubmission, escapeDiscordString, replyEphemeral } from "../../utils/Util.js";
import { SubmissionConfigs } from "../../submissions/SubmissionConfigs.js";
import { filterImages, getFileKey } from "../../utils/AttachmentUtils.js";
import { SetAttachmentsMenu } from "../menus/SetAttachmentsMenu.js";
import { AttachmentSource, BaseAttachment } from "../../submissions/Attachment.js";
import { AuthorType } from "../../submissions/Author.js";
import { SetImagesMenu } from "../menus/SetImagesMenu.js";
import { EditInfoMultipleButton } from "../buttons/EditInfoMultipleButton.js";
import { safeJoinPath } from "../../utils/SafePath.js";
import { Image } from "../../submissions/Image.js";

export class AddImageModal implements Modal {
    getID(): string {
        return "add-image-modal";
    }

    getBuilder(ordinal: number): ModalBuilder {
        const modal = new ModalBuilder()
            .setCustomId(this.getID())
            .setTitle('Add Image')

        const uploadInput = new FileUploadBuilder()
            .setCustomId('attachmentInput')
            .setMaxValues(1)
            .setMinValues(1)
            .setRequired(true);

        const uploadLabel = new LabelBuilder()
            .setLabel('Upload image:')
            .setFileUploadComponent(uploadInput);

        const descriptionInput = new TextInputBuilder()
            .setCustomId('descriptionInput')
            .setPlaceholder('Optional description')
            .setMaxLength(300)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false);

        const descriptionLabel = new LabelBuilder()
            .setLabel('Image Description:')
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

        if (submission.imagesProcessing) {
            replyEphemeral(interaction, 'Images are currently being processed. Please wait until they are done.');
            return;
        }

        // check if images exceed 5
        if ((submission.getConfigManager().getConfig(SubmissionConfigs.IMAGES) || []).length >= 5) {
            replyEphemeral(interaction, 'You cannot add more than 5 images to a submission!');
            return;
        }

        const uploadedAttachment = interaction.fields.getUploadedFiles('attachmentInput', true).first();
        const description = (interaction.fields.getTextInputValue('descriptionInput') || '').replace(/\n/g, ' ').trim();
        const ordinal = parseInt(interaction.fields.getTextInputValue('orderInput')) || 0;
        if (!uploadedAttachment) {
            replyEphemeral(interaction, 'No attachment uploaded. Please try again.');
            return;
        }

        if (description.length > 300) {
            replyEphemeral(interaction, 'Description cannot exceed 300 characters!');
            return;
        }

        const submissionChannel = await submission.getSubmissionChannel();
        if (!submissionChannel || !submissionChannel.parent) {
            replyEphemeral(interaction, 'Submission channel not found.');
            return;
        }

        const imageObj: BaseAttachment = {
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

        if (filterImages([imageObj]).length === 0) {
            replyEphemeral(interaction, 'The provided attachment is not a valid image.');
            return;
        }


        if (!interaction.isFromMessage()) {
            return; // should not happen
        }

        await interaction.deferUpdate();

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
                        name: imageObj.name,
                        attachment: imageObj.url
                    }
                ]
            }).catch((e) => {
                console.log("Failed to post with webhook", e)
            });

            await webhook.delete().catch(() => { /* ignore */ });

            // set new URL from message attachment
            const msgAttachment = message?.attachments.first();
            if (msgAttachment) {
                imageObj.url = msgAttachment.url;
                imageObj.id = msgAttachment.id;
            }
        }

        const isFirstTime = submission.getConfigManager().getConfig(SubmissionConfigs.IMAGES) === null;
        const currentImages = submission.getConfigManager().getConfig(SubmissionConfigs.IMAGES) ?? [];
        const ordinalClamped = Math.min(Math.max(1, ordinal), currentImages.length + 1);
        currentImages.splice(ordinalClamped - 1, 0, imageObj);
        submission.getConfigManager().setConfig(SubmissionConfigs.IMAGES, currentImages);

        try {
            await submission.processImages();
        } catch (error: any) {
            console.error('Error processing image:', error.message)
            interaction.editReply('Error processing image: ' + error.message);
            return
        }

        await submission.save();

        await SetImagesMenu.sendImagesMenuAndButton(submission, interaction, true);


        let message = `<@${interaction.user.id}> added image: ${imageObj.url}`;
        if (description.length > 0) {
            message += ` with description`;
        }

        const processedFolder = submission.getProcessedImagesFolder();
        const key = getFileKey(imageObj, 'png');
        const processedPath = safeJoinPath(processedFolder, key)
        const file = new AttachmentBuilder(processedPath);
        const embed = new EmbedBuilder()
            .setTitle(escapeDiscordString(imageObj.name))
            .setImage(`attachment://${key}`)

        if (imageObj.description) {
            embed.setFooter({ text: imageObj.description.substring(0, 2048) });
        }

        const editDescriptionButton = new EditInfoMultipleButton().getBuilder(true);
        const row = new ActionRowBuilder().addComponents(editDescriptionButton);


        const upload = await interaction.followUp({
            content: message,
            embeds: [embed],
            files: [file],
            components: [row as any],
            allowedMentions: { parse: [] },
            flags: MessageFlags.SuppressNotifications
        })

        if (upload.embeds.length === 1) {
            const uploaded = upload.embeds[0];
            if (uploaded && uploaded.image?.url) {
                (imageObj as Image).processedUrl = uploaded.image.url;
                submission.save();
            }
        }

        await submission.statusUpdated();

        if (isFirstTime) {
            await SetAttachmentsMenu.sendAttachmentsMenuAndButton(submission, interaction);
        }

        submission.checkReview();
    }
}
