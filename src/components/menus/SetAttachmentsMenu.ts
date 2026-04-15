import { ActionRowBuilder, ButtonInteraction, EmbedBuilder, Interaction, MessageFlags, ModalSubmitInteraction, StringSelectMenuBuilder, StringSelectMenuInteraction, StringSelectMenuOptionBuilder } from "discord.js";
import { GuildHolder } from "../../GuildHolder.js";
import { Menu } from "../../interface/Menu.js";
import { canEditSubmission, escapeDiscordString, formatSize, reorderToPreserveOldOrder, replyEphemeral, replyReplace, splitIntoChunks, truncateFileName, truncateStringWithEllipsis } from "../../utils/Util.js";
import { Submission } from "../../submissions/Submission.js";
import { SubmissionConfigs } from "../../submissions/SubmissionConfigs.js";
import { Attachment, AttachmentAskDescriptionData } from "../../submissions/Attachment.js";
import { SkipAttachmentsButton } from "../buttons/SkipAttachmentsButton.js";
import { filterAttachments, getAttachmentDescriptionForMenus, getAttachmentsSetMessage, isAttachmentImage } from "../../utils/AttachmentUtils.js";
import { AddAttachmentButton } from "../buttons/AddAttachmentButton.js";
import { RefreshListButton } from "../buttons/RefreshListButton.js";
import { SetDescriptionButton } from "../buttons/SetDescriptionButton.js";
import { SkipDescriptionButton } from "../buttons/SkipDescriptionButton.js";
import { EditInfoMultipleButton } from "../buttons/EditInfoMultipleButton.js";
import { GuildConfigs } from "../../config/GuildConfigs.js";

export class SetAttachmentsMenu implements Menu {
    getID(): string {
        return "set-attachments-menu";
    }

    getBuilder(fileAttachments: Attachment[], currentFiles: Attachment[]): StringSelectMenuBuilder {
        return new StringSelectMenuBuilder()
            .setCustomId(this.getID())
            .setMinValues(0)
            .setMaxValues(Math.min(10, fileAttachments.length))
            .setPlaceholder('Select files')
            .addOptions(
                fileAttachments.map(file => {
                    const matching = currentFiles.find(att => att.id === file.id);
                    return new StringSelectMenuOptionBuilder().setLabel(truncateFileName(matching ? matching.name : file.name, 50))
                        .setValue(file.id)
                        .setDescription(truncateStringWithEllipsis(getAttachmentDescriptionForMenus(matching ?? file), 100) || "No description")
                        .setDefault(!!matching);
                })
            )
    }

    async getBuilderOrNull(submission: Submission): Promise<StringSelectMenuBuilder | null> {
        const attachments = await submission.getAttachments()
        const currentAttachments = submission.getConfigManager().getConfig(SubmissionConfigs.ATTACHMENTS) ?? [];

        currentAttachments.forEach(file => {
            if (!attachments.some(att => att.id === file.id)) {
                attachments.push(file);
            }
        });

        const fileAttachments = filterAttachments(attachments);

        if (!fileAttachments.length) {
            return null; // No file attachments available
        }

        // if more than 25 attachments, limit to first 25
        if (fileAttachments.length > 25) {
            let toRemove = fileAttachments.length - 25;
            for (let i = fileAttachments.length - 1; i >= 0 && toRemove > 0; i--) {
                const file = fileAttachments[i];
                if (!currentAttachments.some(att => att.id === file.id)) {
                    fileAttachments.splice(i, 1);
                    toRemove--;
                }
            }

            // if still more than 25, slice the array
            if (fileAttachments.length > 25) {
                fileAttachments.splice(25);
            }
        }

        return this.getBuilder(fileAttachments, currentAttachments);
    }

    async execute(guildHolder: GuildHolder, interaction: StringSelectMenuInteraction): Promise<void> {
        const submissionId = interaction.channelId
        const submission = await guildHolder.getSubmissionsManager().getSubmission(submissionId)
        if (!submission) {
            replyEphemeral(interaction, 'Submission not found')
            return
        }

        if (
            !canEditSubmission(interaction, submission)
        ) {
            replyEphemeral(interaction, 'You do not have permission to use this!')
            return
        }

        if (submission.attachmentsProcessing) {
            replyEphemeral(interaction, 'Attachments are currently being processed. Please wait until they are done.');
            return;
        }

        if (interaction.values.includes('none')) {
            replyEphemeral(interaction, 'No files found')
            return
        }

        await interaction.deferUpdate()
        const attachments = await submission.getAttachments()
        const currentAttachments = submission.getConfigManager().getConfig(SubmissionConfigs.ATTACHMENTS) ?? [];
        const newAttachments = reorderToPreserveOldOrder(currentAttachments, interaction.values.map(id => {
            return currentAttachments.find(attachment => attachment.id === id) ?? attachments.find(attachment => attachment.id === id);
        }).filter(o => !!o));

        const addedAttachmentsWithoutDescriptions = newAttachments.filter(newAtt => {
            return (!newAtt.description || newAtt.description === "(no content)") && !currentAttachments.some(currAtt => currAtt.id === newAtt.id);
        });

        if (addedAttachmentsWithoutDescriptions.length > 0) {
            const data: AttachmentAskDescriptionData = {
                areImages: false,
                toAsk: addedAttachmentsWithoutDescriptions,
                toSet: newAttachments
            }

            const identifier = guildHolder.getBot().getTempDataStore().getNewId();
            guildHolder.getBot().getTempDataStore().addEntry(identifier, data, 30 * 60 * 1000); // 30 minutes


            const nextAttachment = data.toAsk[0];
            const askButton = new SetDescriptionButton().getBuilder(nextAttachment.name, false, nextAttachment.id, identifier);
            const skipButton = new SkipDescriptionButton().getBuilder(false, nextAttachment.id, identifier, false);
            const row = new ActionRowBuilder().addComponents(askButton, skipButton);
            if (addedAttachmentsWithoutDescriptions.length > 1) {
                const skipAllButton = new SkipDescriptionButton().getBuilder(false, nextAttachment.id, identifier, true);
                row.addComponents(skipAllButton);
            }
            const embed = new EmbedBuilder()
                .setTitle(truncateFileName(escapeDiscordString(nextAttachment.name), 256))
                .setDescription(getAttachmentDescriptionForMenus(nextAttachment) || 'No description');

            // check if image is a png/jpg/jpeg/gif and add as embed image
            if (isAttachmentImage(nextAttachment)) {
                embed.setThumbnail(nextAttachment.url);
            }

            await interaction.editReply({
                content: `We've detected that you added ${addedAttachmentsWithoutDescriptions.length} attachment${addedAttachmentsWithoutDescriptions.length > 1 ? 's' : ''} without descriptions.` +
                    `\n\nSet a description for the attachment **${escapeDiscordString(nextAttachment.name)}**?`,
                components: [row as any],
                embeds: [embed]
            });
        } else {
            await SetAttachmentsMenu.setAttachmentsAndSetResponse(submission, newAttachments, interaction);
        }
    }

    public static async setAttachmentsAndSetResponse(submission: Submission, newAttachments: Attachment[], interaction: StringSelectMenuInteraction | ModalSubmitInteraction | ButtonInteraction): Promise<void> {
        await interaction.editReply({
            content: 'Processing attachments...',
            embeds: [],
            components: [],
            files: [],
        }).catch(() => { });

        submission.getConfigManager().setConfig(SubmissionConfigs.ATTACHMENTS, newAttachments);
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

        const newAttachmentsProcessed = submission.getConfigManager().getConfig(SubmissionConfigs.ATTACHMENTS) ?? [];

        submission.save()

        const rows: ActionRowBuilder<any>[] = [];

        if (newAttachmentsProcessed.length > 0) {
            rows.push(new ActionRowBuilder().addComponents(new EditInfoMultipleButton().getBuilder(false)));
        }

        let description = `Attachments set by <@${interaction.user.id}>:\n\n` + getAttachmentsSetMessage(newAttachmentsProcessed);

        const split = splitIntoChunks(description, 2000);

        await this.sendAttachmentsMenuAndButton(submission, interaction, true);

        await interaction.followUp({
            content: split[0],
            flags: [MessageFlags.SuppressEmbeds, MessageFlags.SuppressNotifications],
            allowedMentions: { parse: [] },
            components: split.length === 1 ? rows : []
        });


        for (let i = 1; i < split.length; i++) {
            if (!interaction.channel || !interaction.channel.isSendable()) continue;
            await interaction.channel.send({
                content: split[i],
                flags: [MessageFlags.SuppressEmbeds, MessageFlags.SuppressNotifications],
                allowedMentions: { parse: [] },
                components: i === split.length - 1 ? rows : []
            })
        }

        const sizeWarningThreshold = submission.getGuildHolder().getConfigManager().getConfig(GuildConfigs.ATTACHMENT_SIZE_WARNING_THRESHOLD);
        const largeAttachments = newAttachmentsProcessed.filter(att => att.size && att.size >= sizeWarningThreshold);
        if (largeAttachments.length > 0) {
            let warningMessage = `⚠️ **Warning:** The following attachment${largeAttachments.length > 1 ? 's are' : ' is'} quite large (over ${formatSize(sizeWarningThreshold)}):\n`;
            largeAttachments.forEach(att => {
                warningMessage += `- ${escapeDiscordString(att.name)} (${formatSize(att.size || 0)})\n`;
            });
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

    public static async sendAttachmentsMenuAndButton(submission: Submission, interaction: Interaction, useUpdate: boolean = false) {
        submission.clearAttachmentsCache();

        const menu = await new SetAttachmentsMenu().getBuilderOrNull(submission);
        const attachments = submission.getConfigManager().getConfig(SubmissionConfigs.ATTACHMENTS);
        if (menu) {
            const rows = [new ActionRowBuilder().addComponents(menu)];
            const secondRow = new ActionRowBuilder().addComponents(new RefreshListButton().getBuilder(false), new AddAttachmentButton().getBuilder());
            if (attachments === null) {
                secondRow.addComponents(new SkipAttachmentsButton().getBuilder())
            } else if ( attachments.length > 0) {
                secondRow.addComponents(new EditInfoMultipleButton().getBuilder(false));
            }

            rows.push(secondRow);
            await replyReplace(useUpdate, interaction, `Please choose other attachments (eg: Schematics/WDLs) for the submission`, rows);
        } else {
            const row = new ActionRowBuilder().addComponents(new RefreshListButton().getBuilder(false), new AddAttachmentButton().getBuilder());
            if (attachments === null) {
                row.addComponents(new SkipAttachmentsButton().getBuilder())
            } else if ( attachments.length > 0) {
                row.addComponents(new EditInfoMultipleButton().getBuilder(false));
            }

            await replyReplace(useUpdate, interaction, `No attachments found! Try uploading attachments first and then press the button below.`, [
                row as any
            ])
        }
    }
}