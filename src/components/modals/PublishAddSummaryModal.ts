import { LabelBuilder, ModalBuilder, ModalSubmitInteraction, TextInputBuilder, TextInputStyle } from "discord.js";
import { GuildHolder } from "../../GuildHolder.js";
import { Modal } from "../../interface/Modal.js";
import { canPublishSubmission, replyEphemeral, truncateStringWithEllipsis } from "../../utils/Util.js";
import { SubmissionConfigs } from "../../submissions/SubmissionConfigs.js";
import { PublishCommitMessage } from "../../submissions/Publish.js";

export class PublishAddSummaryModal implements Modal {
    getID(): string {
        return "publish-add-summary-mdl";
    }

    getBuilder(): ModalBuilder {

        const modal = new ModalBuilder()
            .setCustomId(this.getID())
            .setTitle('Changelog Summary');

        const titleInput = new TextInputBuilder()
            .setCustomId('titleInput')
            .setPlaceholder('One-line summary of changes made')
            .setMaxLength(200)
            .setStyle(TextInputStyle.Short)
            .setRequired(false);

        const titleLabel = new LabelBuilder()
            .setLabel('Commit Message:')
            .setTextInputComponent(titleInput);

        const descriptionInput = new TextInputBuilder()
            .setCustomId('detailInput')
            .setPlaceholder('Optional detailed description of changes made')
            .setMaxLength(1000)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false);

        const descriptionLabel = new LabelBuilder()
            .setLabel('Detailed Changelog (optional):')
            .setTextInputComponent(descriptionInput);

        modal.addLabelComponents(
            titleLabel,
            descriptionLabel
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
            !canPublishSubmission(interaction, submission)
        ) {
            replyEphemeral(interaction, 'You do not have permission to use this!')
            return;
        }

        if (!submission.isPublishable()) {
            replyEphemeral(interaction, 'Submission is not publishable yet!');
            return;
        }

        const title = interaction.fields.getTextInputValue('titleInput').trim();
        const detail = interaction.fields.getTextInputValue('detailInput').trim();

        const publishMessage: PublishCommitMessage = {
            message: title.length > 0 ? title : undefined,
            detailedDescription: detail.length > 0 ? detail : undefined,
        };


        const msg = await interaction.reply({
            content: `<@${interaction.user.id}> initiated publishing!`,
        });

        try {
            await submission.publish(false, false, false, publishMessage, async (status: string) => {
                await msg.edit({ content: `<@${interaction.user.id}> initiated publishing!\nStatus: ${status}` });
            });
        } catch (e: any) {
            console.error(e);
            await interaction.followUp({
                content: `Failed to publish submission because of error: ${e.message}`,
            });
            return;
        }

        await msg.delete().catch(() => { });

        const url = submission.getConfigManager().getConfig(SubmissionConfigs.POST)?.threadURL;
        const isLocked = submission.getConfigManager().getConfig(SubmissionConfigs.IS_LOCKED);


        // await interaction.followUp({
        //     content: `Submission published successfully! ${url}` + (isLocked ? `\nNote: The submission has been locked to prevent republishing. Please contact an editor/endorser if it needs to be republished.` : ''),
        // });

        const message = `<@${interaction.user.id}> published the submission! ${url}`;
        const lockNote = isLocked ? `\nNote: The submission has been locked to prevent republishing. Please contact an editor/endorser if it needs to be republished.` : '';

        const commitMessage = publishMessage.message ? `\nSummary: ${publishMessage.message}` : '';
        const detailedMessage = publishMessage.detailedDescription ? `\nDetails:\n${publishMessage.detailedDescription}` : '';
        
        await interaction.followUp({
            content: truncateStringWithEllipsis(message + lockNote + commitMessage + detailedMessage, 2000),
        });

    }
}
