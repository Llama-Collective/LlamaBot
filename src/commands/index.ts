import { BulkDeleteCommand } from "./BulkDeleteCommand.js";
import { EditCommand } from "./EditCommand.js";
import { EditorPowersCommand } from "./EditorPowersCommand.js";
import { EndorseCommand } from "./EndorseCommand.js";
import { GetPostCommand } from "./GetPostCommand.js";
import { GetPostsByCommand } from "./GetPostsByCommand.js";
import { GetStatsCommand } from "./GetStatsCommand.js";
import { GetThanksCommand } from "./GetThanksCommand.js";
import { AntiSpamCommand } from "./AntiSpamCommand.js";
import { KickRoleCommand } from "./KickRoleCommand.js";
import { MoveConvoCommand } from "./MoveConvoCommand.js";
import { MoveConvoEndContextCommand } from "./MoveConvoEndContextCommand.js";
import { MoveConvoStartContextCommand } from "./MoveConvoStartContextCommand.js";
import { Mwa } from "./MwaCommand.js";
import { DictionaryEditCommand } from "./DictionaryEditCommand.js";
import { SubscribeCommand } from "./SubscribeCommand.js";
import { ToggleDncCommand } from "./ToggleDncCommand.js";
import { ToggleHelper } from "./ToggleHelper.js";
import { UnsubscribeCommand } from "./UnsubscribeCommand.js";
import { TopHelpersCommand } from "./TopHelpersCommand.js";
import { DiscordsCommand } from "./DiscordsCommand.js";
import { DebugCommand } from "./DebugCommand.js";
import { DefineCommand } from "./DefineCommand.js";
import { SearchCommand } from "./SearchCommand.js";
import { JoinDiscordCommand } from "./JoinDiscordCommand.js";
import { AskCommand } from "./AskCommand.js";
import { TokenCommand } from "./TokenCommand.js";
export function getCommands() {
    const Commands = [
        new Mwa(),
        new TokenCommand(),
        new EndorseCommand(),
        new EditorPowersCommand(),
        new AntiSpamCommand(),
        new GetPostCommand(),
        new GetThanksCommand(),
        new GetPostsByCommand(),
        new GetStatsCommand(),
        new EditCommand(),
        new ToggleHelper(),
        new ToggleDncCommand(),
        new MoveConvoStartContextCommand(),
        new MoveConvoEndContextCommand(),
        new MoveConvoCommand(),
        new BulkDeleteCommand(),
        new KickRoleCommand(),
        new SubscribeCommand(),
        new UnsubscribeCommand(),
        new TopHelpersCommand(),
        new DictionaryEditCommand(),
        new DiscordsCommand(),
        new AskCommand(),
        new DebugCommand(),
        new DefineCommand(),
        new SearchCommand(),
        new JoinDiscordCommand()
    ];
    return Commands;
}
