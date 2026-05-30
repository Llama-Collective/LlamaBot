import { SlashCommandBuilder, ChatInputCommandInteraction, InteractionContextType, MessageFlags } from "discord.js";
import { GuildHolder } from "../GuildHolder.js";
import { Command } from "../interface/Command.js";
import { replyEphemeral } from "../utils/Util.js";

export class ToggleDncCommand implements Command {
    getID(): string {
        return "togglednc";
    }

    getBuilder(_guildHolder: GuildHolder): SlashCommandBuilder {
        return new SlashCommandBuilder()
            .setName(this.getID())
            .setDescription('Toggle automatic contact from the bot')
            .setContexts(InteractionContextType.Guild);
    }

    async execute(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction): Promise<void> {
        if (!interaction.inGuild()) {
            await replyEphemeral(interaction, 'This command can only be used in a guild channel.');
            return;
        }

        const userData = await guildHolder.getUserManager().getOrCreateUserData(
            interaction.user.id,
            interaction.user.username,
        );

        userData.doNotContact = !userData.doNotContact;
        await guildHolder.getUserManager().saveUserData(userData);

        const status = userData.doNotContact ? 'disabled' : 'enabled';
        await interaction.reply({
            content: `Automatic contact has been ${status}. Use this command again if you change your mind.`,
            flags: [MessageFlags.Ephemeral],
        });
    }
}
