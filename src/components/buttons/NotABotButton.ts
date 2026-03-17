import { ButtonBuilder, ButtonInteraction, ButtonStyle, Snowflake } from "discord.js";
import { GuildHolder } from "../../GuildHolder.js";
import { Button } from "../../interface/Button.js";

export class NotABotButton implements Button {
    getID(): string {
        return "not-a-bot-button";
    }

    getBuilder(id: Snowflake): ButtonBuilder {
        return new ButtonBuilder()
            .setCustomId(this.getID() + '|' + id)
            .setLabel('I am not a bot')
            .setStyle(ButtonStyle.Primary);
    }

    async execute(guildHolder: GuildHolder, interaction: ButtonInteraction, userID: Snowflake): Promise<void> {
        await guildHolder.getAntiSpamSystem().handleNotABotVerification(interaction, userID);
    }
}
