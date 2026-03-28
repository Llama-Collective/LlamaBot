import { ButtonBuilder, ButtonInteraction, ButtonStyle } from "discord.js";
import { GuildHolder } from "../../GuildHolder.js";
import { Button } from "../../interface/Button.js";
import { canEditSubmission, replyEphemeral } from "../../utils/Util.js";
import { AuthorModal } from "../modals/AuthorModal.js";
import { SubmissionConfigs } from "../../submissions/SubmissionConfigs.js";

export class AddAuthorButton implements Button {
    getID(): string {
        return "add-author-button";
    }

    getBuilder(): ButtonBuilder {
        return new ButtonBuilder()
            .setCustomId(this.getID())
            .setLabel('Add Author Not In List')
            .setStyle(ButtonStyle.Primary)
    }

    async execute(guildHolder: GuildHolder, interaction: ButtonInteraction): Promise<void> {
        const submission = await guildHolder.getSubmissionsManager().getSubmission(interaction.channelId);
        if (!submission) {
            replyEphemeral(interaction, 'Submission not found');
            return;
        }

        if (
            !canEditSubmission(interaction, submission)
        ) {
            replyEphemeral(interaction, 'You do not have permission to use this!')
            return;
        }

        const authors = submission.getConfigManager().getConfig(SubmissionConfigs.AUTHORS) ?? await submission.getPotentialAuthorsFromMessageContent() ?? [];
        if (authors.length >= 25) {
            replyEphemeral(interaction, 'You cannot have more than 25 authors for a submission.');
            return;
        }

        const modal = new AuthorModal().getBuilder(authors.length + 1);
        await interaction.showModal(modal);
    }
}