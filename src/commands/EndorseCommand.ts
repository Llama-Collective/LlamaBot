import { SlashCommandBuilder, ChatInputCommandInteraction, InteractionContextType } from "discord.js";
import { GuildHolder } from "../GuildHolder.js";
import { Command } from "../interface/Command.js";
import { isDiscordAuthor, isEditor, isEndorser, isModerator, replyEphemeral } from "../utils/Util.js";
import { SubmissionConfigs } from "../submissions/SubmissionConfigs.js";
import { AuthorType } from "../submissions/Author.js";
import { GuildConfigs } from "../config/GuildConfigs.js";

export class EndorseCommand implements Command {
    getID(): string {
        return "endorse";
    }

    getBuilder(_guildHolder: GuildHolder): SlashCommandBuilder {
        const data = new SlashCommandBuilder()
        data.setName(this.getID())
            .setDescription('Endorse a submission')
            .setContexts(InteractionContextType.Guild);
        return data;
    }

    async execute(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction): Promise<void> {
        if (
            !interaction.inCachedGuild()
        ) {
            replyEphemeral(interaction, 'This command can only be used in a forum channel.')
            return;
        }
        
        // Check if user has endorse role
        if (
            !isEndorser(interaction, guildHolder) && !isModerator(interaction) && !isEditor(interaction, guildHolder)
        ) {
            replyEphemeral(interaction, 'You do not have permission to use this command!');
            return;
        }

        const channelId = interaction.channelId;
        const submission = await guildHolder.getSubmissionsManager().getSubmission(channelId);
        if (!submission) {
            replyEphemeral(interaction, 'You can only use this command in a submission channel.');
            return;
        }

        // Check if self endorsement is disallowed
        const selfEndorsementDisallowed = guildHolder.getConfigManager().getConfig(GuildConfigs.SELF_ENDORSEMENT_DISALLOWED);
        if (selfEndorsementDisallowed) {
            const author = submission.getConfigManager().getConfig(SubmissionConfigs.AUTHORS) || [];
            const isAuthor = author.some(a => isDiscordAuthor(a) && a.id === interaction.user.id);

            if (isAuthor) {
                replyEphemeral(interaction, 'You cannot endorse your own submission.');
                return;
            }
        }
        
        // get endorsements
        const endorsements = submission.getConfigManager().getConfig(SubmissionConfigs.ENDORSERS);
        const index = endorsements.findIndex(endorser => endorser.id === interaction.user.id);
        if (index !== -1) {
            // User has already endorsed, remove endorsement
            endorsements.splice(index, 1);
            submission.getConfigManager().setConfig(SubmissionConfigs.ENDORSERS, endorsements);
            interaction.reply({
                content: `<@${interaction.user.id}> Has removed their endorsement.`,
            });
        } else {
            // User has not endorsed, add endorsement
            endorsements.push({ type: AuthorType.DiscordInGuild, id: interaction.user.id, username: interaction.user.username, displayName: interaction.member.displayName, iconURL: interaction.user.displayAvatarURL() });
            submission.getConfigManager().setConfig(SubmissionConfigs.ENDORSERS, endorsements);
            interaction.reply({
                content: `<@${interaction.user.id}> Has endorsed this submission.`,
            });
        }

        submission.statusUpdated();
    }

}