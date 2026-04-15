import { ButtonBuilder, ButtonInteraction, ButtonStyle } from "discord.js";
import { GuildHolder } from "../../GuildHolder.js";
import { Button } from "../../interface/Button.js";
import { canEditSubmission, replyEphemeral } from "../../utils/Util.js";
import { SetAttachmentsMenu } from "../menus/SetAttachmentsMenu.js";
import { SetImagesMenu } from "../menus/SetImagesMenu.js";

export class RefreshListButton implements Button {
    getID(): string {
        return "refresh-list-button";
    }

    getBuilder(isImages: boolean): ButtonBuilder {
        return new ButtonBuilder()
            .setCustomId(this.getID() + '|' + (isImages ? "y" : "n"))
            .setLabel("Refresh List")
            .setStyle(ButtonStyle.Success);
    }

    async execute(guildHolder: GuildHolder, interaction: ButtonInteraction, isImages: string): Promise<void> {
        const submission = await guildHolder.getSubmissionsManager().getSubmission(interaction.channelId);
        if (!submission) {
            replyEphemeral(interaction, "Submission not found");
            return;
        }

        if (!canEditSubmission(interaction, submission)) {
            replyEphemeral(interaction, "You do not have permission to use this!");
            return;
        }

        submission.clearAttachmentsCache();


        if (isImages == "y") {
            await SetImagesMenu.sendImagesMenuAndButton(submission, interaction, true);
        } else {
            await SetAttachmentsMenu.sendAttachmentsMenuAndButton(submission, interaction, true);
        }
        

    }
}