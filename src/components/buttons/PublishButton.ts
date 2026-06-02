import { ButtonBuilder, ButtonInteraction, ButtonStyle } from "discord.js";
import { GuildHolder } from "../../GuildHolder.js";
import { Button } from "../../interface/Button.js";
import { canPublishSubmission, replyEphemeral } from "../../utils/Util.js";
import { SubmissionConfigs } from "../../submissions/SubmissionConfigs.js";
import { PublishAddSummaryModal } from "../modals/PublishAddSummaryModal.js";

export class PublishButton implements Button {
    getID(): string {
        return "publish-button";
    }

    getBuilder(is_published: boolean): ButtonBuilder {
        return new ButtonBuilder()
            .setCustomId(this.getID())
            .setLabel(is_published ? 'Republish!' : 'Publish!')
            .setStyle(ButtonStyle.Success);
    }

    async execute(guildHolder: GuildHolder, interaction: ButtonInteraction): Promise<void> {
        const submission = await guildHolder.getSubmissionsManager().getSubmission(interaction.channelId);
        if (!submission) {
            replyEphemeral(interaction, 'Submission not found');
            return;
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

        const existing = await guildHolder.getRepositoryManager().findEntryBySubmissionId(submission.getId());
        if (existing) {
            await interaction.showModal(new PublishAddSummaryModal().getBuilder())
            return;
        }
        
        const msg = await interaction.reply({
            content: `<@${interaction.user.id}> initiated publishing!`,
        });

        try {
            await submission.publish(false, false, false, undefined, async (status: string) => {
                await msg.edit({ content: `<@${interaction.user.id}> initiated publishing!\nStatus: ${status}` });
            });
        } catch(e: any) {
            console.error(e);
            await interaction.followUp({
                content: `Failed to publish submission because of error: ${e.message}`,
            });
            return;
        }

        await msg.delete().catch(() => { });

        const url = submission.getConfigManager().getConfig(SubmissionConfigs.POST)?.threadURL;
        const isLocked = submission.getConfigManager().getConfig(SubmissionConfigs.IS_LOCKED);
        await interaction.followUp({
            content: `<@!${interaction.user.id}> published the submission! ${url}` + (isLocked ? `\nNote: The submission has been locked to prevent republishing. Please contact an editor/endorser if it needs to be republished.` : ''),
        });
    }

}
