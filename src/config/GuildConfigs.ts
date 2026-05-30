import { Snowflake } from "discord.js";
import { Config } from "./ConfigManager.js";
import { DiscordAuthor } from "../submissions/Author.js";

export const GuildConfigs = {
    /**
     * The name of the guild.
     */
    GUILD_NAME: new Config("guildName", "Unknown Guild"),

    /**
     * The ID of the guild. A snowflake.
     */
    GUILD_ID: new Config("guildId", ""),

    /**
     * The ID of the channel where submissions are sent.
     */
    SUBMISSION_CHANNEL_ID: new Config("submissionChannelId", ""),

    /**
     * The IDs of the categories where archive channels live
     */
    ARCHIVE_CATEGORY_IDS: new Config<Snowflake[]>("archiveCategoryIds", []),

    /**
     * The ID of the channel where the bot sends updates about submissions.
     */
    LOGS_CHANNEL_ID: new Config<Snowflake>("logsChannelId", ""),

    /**
     * The IDs of the roles that can endorse submissions.
     */
    ENDORSE_ROLE_IDS: new Config<Snowflake[]>("endorseRoleIds", []),

    /**
     * The IDs of the roles that can edit submissions.
     */
    EDITOR_ROLE_IDS: new Config<Snowflake[]>("editorRoleIds", []),


    /**
     * Github repository URL for the archive.
     */
    GITHUB_REPO_URL: new Config<string>("githubRepoUrl", ""),

    /**
     * Helper role
     */
    HELPER_ROLE_ID: new Config<Snowflake>("helperRoleId", ""),

    /**
     * Helper message
     */
    ACKNOWLEDGE_THANKS: new Config<boolean>("acknowledgeThanks", false),

    /**
     * Designer role
     */
    DESIGNER_ROLE_ID: new Config<Snowflake>("designerRoleId", ""),

    /**
     * Helper role threshold
     */
    HELPER_ROLE_THRESHOLD: new Config<number>("helperRoleThreshold", 5),

    /**
     * User blacklist
     */
    THANKS_BLACKLIST: new Config<DiscordAuthor[]>("thanksBlacklist", []),

    /**
     * Honeypot channel ID
     */
    HONEYPOT_CHANNEL_ID: new Config<Snowflake>("honeypotChannelId", ""),

    /**
     * Moderation log channel ID
     */
    MOD_LOG_CHANNEL_ID: new Config<Snowflake>("modLogChannelId", ""),

    /**
     * Alt account detection creation threshold in milliseconds (default: 7 days)
     */
    ALT_ACCOUNT_DETECTION_CREATION_THRESHOLD: new Config<number>("altAccountDetectionCreationThreshold", 7 * 24 * 60 * 60 * 1000),

    /**
     * Alt account detection enabled
     */
    ALT_ACCOUNT_DETECTION_ENABLED: new Config<boolean>("altAccountDetectionEnabled", false),

    /**
     * Conversational LLM enabled
     */
    CONVERSATIONAL_LLM_ENABLED: new Config<boolean>("conversationalLlmEnabled", false),

    /**
     * Conversational LLM enabled
     */
    CONVERSATIONAL_LLM_CHANNEL: new Config<Snowflake>("conversationalLlmChannel", ""),

    /**
     * Website URL
     */
    WEBSITE_URL: new Config<string>("websiteUrl", ""),

    /**
     * Dictionary channel ID
     */
    DICTIONARY_CHANNEL_ID: new Config<Snowflake>("dictionaryChannelId", ""),

    /**
     * Auto reply with server invites for detected Discord links
     */
    AUTOJOIN_ENABLED: new Config<boolean>("autojoinEnabled", true),

    /**
     * Auto reply with post embeds for detected post codes
     */
    AUTOLOOKUP_ENABLED: new Config<boolean>("autolookupEnabled", true),

    /**
     * Minimum endorsements required before publishing
     */
    MIN_ENDORSEMENTS_REQUIRED: new Config<number>("minEndorsementsRequired", 1),

    /**
     * Attachments size warning threshold in bytes
     */
    ATTACHMENT_SIZE_WARNING_THRESHOLD: new Config<number>("attachmentSizeWarningThreshold", 10 * 1024 * 1024), // 10 MB

    EDITOR_ROTATION_ENABLED: new Config<boolean>("editorRotationEnabled", false),

    EDITOR_ROTATION_INDEX: new Config<number>("editorRotationIndex", 0),

    SELF_ENDORSEMENT_DISALLOWED: new Config<boolean>("selfEndorsementDisallowed", false),
}
