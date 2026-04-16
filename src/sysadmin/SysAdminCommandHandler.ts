import { Message } from "discord.js";
import { DeopSysAdminCommand } from "./commands/DeopSysAdminCommand.js";
import { JoinSysAdminCommand } from "./commands/JoinSysAdminCommand.js";
import { LeaveSysAdminCommand } from "./commands/LeaveSysAdminCommand.js";
import { ListSysAdminCommand } from "./commands/ListSysAdminCommand.js";
import { OpSysAdminCommand } from "./commands/OpSysAdminCommand.js";
import { PullSysAdminCommand } from "./commands/PullSysAdminCommand.js";
import { WhitelistSysAdminCommand } from "./commands/WhitelistSysAdminCommand.js";
import { SysAdminCommand } from "./SysAdminCommand.js";
import { SysAdminCommandContext } from "./SysAdminCommandContext.js";

export class SysAdminCommandHandler {
    private readonly commands: Map<string, SysAdminCommand>;

    constructor(
        private readonly sysAdminId: string,
        private readonly context: SysAdminCommandContext,
    ) {
        this.commands = this.createCommandMap([
            new ListSysAdminCommand(),
            new OpSysAdminCommand(),
            new DeopSysAdminCommand(),
            new PullSysAdminCommand(),
            new WhitelistSysAdminCommand(),
            new JoinSysAdminCommand(),
            new LeaveSysAdminCommand(),
        ]);
    }

    public async handleMessage(message: Message): Promise<void> {
        console.log(`Received admin message: ${message.content} from ${message.author.tag} (${message.author.id})`);
        if (message.inGuild()) {
            return;
        }

        if (message.author.id !== this.sysAdminId) {
            return;
        }

        if (!message.content.startsWith("/")) {
            await message.reply("Please start your command with `/`");
            return;
        }

        const args = message.content.slice(1).trim().split(/ +/);
        const commandName = args.shift()?.toLowerCase();
        if (!commandName) {
            await message.reply("Please provide a command.");
            return;
        }

        const command = this.commands.get(commandName);
        if (!command) {
            await message.reply(`Unknown command: ${commandName}`);
            return;
        }

        await command.execute(this.context, message, args);
    }

    private createCommandMap(commands: SysAdminCommand[]): Map<string, SysAdminCommand> {
        const commandMap = new Map<string, SysAdminCommand>();
        for (const command of commands) {
            for (const alias of command.aliases) {
                const commandAlias = alias.toLowerCase();
                if (commandMap.has(commandAlias)) {
                    throw new Error(`Duplicate sysadmin command alias: ${commandAlias}`);
                }
                commandMap.set(commandAlias, command);
            }
        }
        return commandMap;
    }
}
