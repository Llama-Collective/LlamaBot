import { Message } from "discord.js";
import { SysAdminCommand } from "../SysAdminCommand.js";
import { SysAdminCommandContext } from "../SysAdminCommandContext.js";
import { getConnectedGuild, getErrorMessage, isValidSnowflake } from "./SysAdminGuildUtils.js";

export class LeaveSysAdminCommand implements SysAdminCommand {
    public aliases = ["leave"];

    public async execute(context: SysAdminCommandContext, message: Message, args: string[]): Promise<void> {
        const guildId = args[0];
        if (!guildId || !isValidSnowflake(guildId)) {
            await message.reply("Usage: `/leave <guild_id>`");
            return;
        }

        if (context.guildWhitelistManager.getGuildIds().includes(guildId)) {
            await message.reply(`Cannot leave ${guildId}: it is whitelisted. Remove it from the whitelist first with \`/whitelist remove ${guildId}\`.`);
            return;
        }

        const guild = getConnectedGuild(context.client, guildId);
        if (!guild) {
            await message.reply(`Not in guild ${guildId}.`);
            return;
        }

        const guildName = guild.name;
        try {
            context.guilds.delete(guildId);
            context.dayTaskTimestamps.delete(guildId);
            await guild.leave();
            await message.reply(`Left ${guildName} (${guildId}).`);
        } catch (error) {
            const errorMessage = getErrorMessage(error);
            console.error(`Error leaving guild ${guildId}:`, error);
            await message.reply(`Failed to leave ${guildName} (${guildId}): ${errorMessage}`);
        }
    }
}
