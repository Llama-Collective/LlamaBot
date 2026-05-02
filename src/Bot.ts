import { AutocompleteInteraction, ChatInputCommandInteraction, Client, ContextMenuCommandInteraction, Events, GatewayIntentBits, Partials } from "discord.js";
import { GuildHolder } from "./GuildHolder.js";
import { LLMQueue } from "./llm/LLMQueue.js";
import fs from "fs/promises";
import { Command } from "./interface/Command.js";
import { Button } from "./interface/Button.js";
import { Menu } from "./interface/Menu.js";
import { Modal } from "./interface/Modal.js";
import { deployCommands, getItemsFromArray, replyEphemeral } from "./utils/Util.js";
import { getButtons } from "./components/buttons/index.js";
import { getCommands } from "./commands/index.js";
import { getMenus } from "./components/menus/index.js";
import { getModals } from "./components/modals/index.js";
import { TempDataStore } from "./utils/TempDataStore.js";
import { App } from "octokit";
import { createXai, XaiProvider } from "@ai-sdk/xai";
import { ContextMenuCommand } from "./interface/ContextMenuCommand.js";
import { DiscordServersDictionary } from "./archive/DiscordServersDictionary.js";
import { GuildWhitelistManager } from "./config/GuildWhitelistManager.js";
import { APITokenManager } from "./api/APITokenManager.js";
import { SysAdminCommandHandler } from "./sysadmin/SysAdminCommandHandler.js";
import { safeJoinPath } from "./utils/SafePath.js";

export const SysAdmin = '239078039831445504';

/**
 * The Secrets type defines the structure for the bot's secrets, including the token and client ID.
 */
export type Secrets = {
    token: string;
    clientId: string;
    githubAppId: string;
    xaiApiKey?: string;
}

/**
 * The Bot class is responsible for managing the Discord bot's lifecycle across multiple guilds.
 */
export class Bot {
    /**
     * A map of guild IDs to GuildHolder instances, which manage the state and interactions for each guild.
     */
    guilds: Map<string, GuildHolder>;

    /**
      * The discord.js Client instance used to interact with the Discord API.
      */
    client: Client;

    /**
     * The LLM request queue, which holds requests to be processed by the LLM.
     */
    llmQueue: LLMQueue;

    /**
     * Commands available for the bot, loaded from the commands directory.
     */
    commands: Map<string, Command | ContextMenuCommand>;

    /**
     * Buttons available for the bot, loaded from the buttons directory.
     */
    buttons: Map<string, Button>;

    /**
     * Menus available for the bot, loaded from the menus directory.
     */
    menus: Map<string, Menu>;

    /**
     * Modals available for the bot, loaded from the modals directory.
     */
    modals: Map<string, Modal>;

    /**
     * Indicates whether the bot is ready and connected to Discord.
     */
    ready: boolean = false;

    /**
     * Temp data store
     */
    tempData: TempDataStore;

    /**
     * Github client
     */
    githubClient?: App;

    /**
     * Xai bot client
     */
    xaiClient?: XaiProvider;

    /**
     * Global Discord servers dictionary, shared across guilds.
     */
    globalDiscordServersDictionary: DiscordServersDictionary;
    private guildWhitelistManager: GuildWhitelistManager;
    private apiTokenManager: APITokenManager;
    private sysAdminCommandHandler: SysAdminCommandHandler;

    
    dayTaskTimestamps: Map<string, number> = new Map();

    constructor() {
        this.guilds = new Map()
        this.llmQueue = new LLMQueue(this)
        this.commands = new Map()
        this.buttons = new Map()
        this.menus = new Map()
        this.modals = new Map()
        this.tempData = new TempDataStore();
        this.globalDiscordServersDictionary = new DiscordServersDictionary(safeJoinPath(process.cwd(), 'config', 'global'));
        this.guildWhitelistManager = new GuildWhitelistManager(safeJoinPath(process.cwd(), 'config', 'global', 'guild_whitelist.json'));
        this.apiTokenManager = new APITokenManager(safeJoinPath(process.cwd(), 'config', 'global', 'api_tokens.json'));

        this.client = new Client({
            intents: [
                GatewayIntentBits.DirectMessages,
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildModeration
            ],
            partials: [
                Partials.Channel,
                Partials.Message,
                Partials.Reaction
            ]
        });

        this.sysAdminCommandHandler = new SysAdminCommandHandler(SysAdmin, {
            client: this.client,
            guilds: this.guilds,
            dayTaskTimestamps: this.dayTaskTimestamps,
            guildWhitelistManager: this.guildWhitelistManager,
        });
    }

    public getGlobalDiscordServersDictionary(): DiscordServersDictionary {
        return this.globalDiscordServersDictionary;
    }

    async start() {
        const secretsPath = safeJoinPath(process.cwd(), 'secrets.json')
        const secrets = JSON.parse(await fs.readFile(secretsPath, 'utf-8')) as Secrets
        if (!secrets.token || !secrets.clientId) {
            throw new Error('Missing token or clientId in secrets.json')
        }

        await this.apiTokenManager.load();
        await this.guildWhitelistManager.load();

        this.commands = getItemsFromArray(getCommands())
        this.buttons = getItemsFromArray(getButtons())
        this.menus = getItemsFromArray(getMenus());
        this.modals = getItemsFromArray(getModals());

        this.setupListeners(secrets)
        this.client.login(secrets.token)


        this.githubClient = new App({
            appId: secrets.githubAppId,
            privateKey: await fs.readFile(safeJoinPath(process.cwd(), 'key.pem'), 'utf-8'),
        });

        if (secrets.xaiApiKey) {
            const xaiClient = createXai({
                apiKey: secrets.xaiApiKey
            });
            // const model = xaiClient("grok-3-mini");
            this.xaiClient = xaiClient;
        }

        return new Promise((resolve, reject) => {
            this.client.once('clientReady', async () => {
                this.ready = true

                const guilds = await Promise.all((await this.client.guilds.fetch()).map((guild) => guild.fetch()));
                for (const [i, guild] of guilds.entries()) {
                    if (!this.guildWhitelistManager.isGuildAllowed(guild.id)) {
                        console.log(`Guild ${guild.name} (${guild.id}) is not whitelisted. Skipping setup (leave disabled).`);
                        continue;
                    }

                    const holder = new GuildHolder(this, guild, this.globalDiscordServersDictionary);
                    this.guilds.set(guild.id, holder);
                    const now = Date.now();
                    this.dayTaskTimestamps.set(guild.id, 24 * 60 * 60 * 1000 + now + i * 60 * 60 * 1000); // staggered by 1 hour
                    deployCommands(this.commands, holder, secrets);
                }

                for (const guildHolder of this.guilds.values()) {
                    await guildHolder.dayTasks();
                }

                this.loop()

                console.log('Bot is ready')
                resolve(this)
            })

            this.client.once('error', (err) => {
                console.error('Error starting bot:', err)
                reject(err)
            })
        })
    }

    setupListeners(secrets: Secrets) {
        this.client.on(Events.GuildCreate, async (guild) => {
            console.log(`Joined guild: ${guild.name} (${guild.id})`)

            if (!this.guildWhitelistManager.isGuildAllowed(guild.id)) {
                console.log(`Guild ${guild.name} (${guild.id}) is not whitelisted. Skipping setup (leave disabled).`);
                return;
            }

            const holder = this.guilds.get(guild.id) ?? new GuildHolder(this, guild, this.globalDiscordServersDictionary);
            this.guilds.set(guild.id, holder);
            this.dayTaskTimestamps.set(guild.id, Date.now() + 24 * 60 * 60 * 1000);
            deployCommands(this.commands, holder, secrets)
        })

        this.client.on(Events.GuildDelete, (guild) => {
            console.log(`Left guild: ${guild.name} (${guild.id})`)
            this.guilds.delete(guild.id)
            this.dayTaskTimestamps.delete(guild.id);
        })


        this.client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
            const guildHolder = this.guilds.get(guild.id)
            if (!guildHolder) return;
            try {
                await guildHolder.handleAuditLogEntry(entry)
            } catch (error) {
                console.error('Error handling audit log entry:', error)
            }
        });

        this.client.on(Events.GuildRoleDelete, async (role) => {
            const guildHolder = this.guilds.get(role.guild.id)
            if (!guildHolder) return;
            try {
                await guildHolder.handleRoleDelete(role)
            } catch (error) {
                console.error('Error handling role delete:', error)
            }
        });

        this.client.on(Events.GuildMemberAdd, async (member) => {
            const guildHolder = this.guilds.get(member.guild.id)
            if (!guildHolder) return;
            try {
                await guildHolder.handleMemberAdd(member)
            } catch (error) {
                console.error('Error handling member add:', error)
            }
        });

        this.client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
            const guildHolder = this.guilds.get(newMember.guild.id)
            if (!guildHolder) return;
            try {
                await guildHolder.handleMemberUpdate(oldMember, newMember)
            } catch (error) {
                console.error('Error handling member update:', error)
            }
        });

        this.client.on(Events.GuildMemberRemove, async (member) => {
            const guildHolder = this.guilds.get(member.guild.id)
            if (!guildHolder) return;
            try {
                await guildHolder.handleMemberRemove(member)
            } catch (error) {
                console.error('Error handling member remove:', error)
            }
        });

        this.client.on(Events.ChannelCreate, async (channel) => {
            if (channel.isDMBased() || !channel.guild) return;
            const guildHolder = this.guilds.get(channel.guild.id);
            if (!guildHolder) return;
            try {
                await guildHolder.handleChannelCreate(channel);
            } catch (error) {
                console.error('Error handling channel create:', error);
            }
        });

        this.client.on(Events.ChannelDelete, async (channel) => {
            if (channel.isDMBased() || !channel.guild) return;
            const guildHolder = this.guilds.get(channel.guild.id);
            if (!guildHolder) return;
            try {
                await guildHolder.handleChannelDelete(channel);
            } catch (error) {
                console.error('Error handling channel delete:', error);
            }
        });

        this.client.on(Events.InteractionCreate, async (interaction) => {
            if (interaction.isAutocomplete()) {
                if (!interaction.inGuild()) {
                    await interaction.respond([]);
                    return;
                }

                const guildHolder = this.guilds.get(interaction.guildId);
                const command = this.commands.get(interaction.commandName) as Command | undefined;
                if (!guildHolder || !command || !command.autocomplete) {
                    await interaction.respond([]);
                    return;
                }

                try {
                    await command.autocomplete(guildHolder, interaction as AutocompleteInteraction);
                } catch (error) {
                    console.error(error);
                    await interaction.respond([]);
                }
                return;
            }

            if (!interaction.inGuild()) {
                replyEphemeral(interaction, 'Cannot use outside of guild!').catch(err => console.error('Failed to send ephemeral reply:', err));
                return;
            }

            const guildHolder = this.guilds.get(interaction.guildId)
            if (!guildHolder) {
                replyEphemeral(interaction, 'Guild not found!').catch(err => console.error('Failed to send ephemeral reply:', err));
                return;
            }

            if (interaction.isCommand()) {
                const command = this.commands.get(interaction.commandName)
                if (!command) return

                try {
                    if (interaction.isContextMenuCommand()) {
                        await (command as ContextMenuCommand).execute(guildHolder, interaction as ContextMenuCommandInteraction)
                    } else {
                        await (command as Command).execute(guildHolder, interaction as ChatInputCommandInteraction)
                    }
                } catch (error) {
                    console.error(error)
                    return replyEphemeral(interaction, 'An error occurred while executing the command.').catch(err => console.error('Failed to send ephemeral reply:', err));
                }
            } else if (interaction.isButton()) {
                const customId = interaction.customId.split('|')
                const button = this.buttons.get(customId[0])
                if (!button) return

                try {
                    await button.execute(guildHolder, interaction, ...customId.slice(1))
                } catch (error) {
                    console.error(error)
                    return replyEphemeral(interaction, 'An error occurred while executing the button.').catch(err => console.error('Failed to send ephemeral reply:', err));
                }
            } else if (interaction.isAnySelectMenu()) {
                const customId = interaction.customId.split('|')
                const menu = this.menus.get(customId[0])
                if (!menu) return

                try {
                    await menu.execute(guildHolder, interaction, ...customId.slice(1))
                } catch (error) {
                    console.error(error)
                    return replyEphemeral(interaction, 'An error occurred while executing the menu.').catch(err => console.error('Failed to send ephemeral reply:', err));
                }
            } else if (interaction.isModalSubmit()) {
                const customId = interaction.customId.split('|')
                const modal = this.modals.get(customId[0])
                if (!modal) return

                try {
                    await modal.execute(guildHolder, interaction, ...customId.slice(1))
                } catch (error) {
                    console.error(error)
                    return replyEphemeral(interaction, 'An error occurred while executing the modal.').catch(err => console.error('Failed to send ephemeral reply:', err));
                }
            } else {
                return replyEphemeral(interaction, 'Unknown interaction type!')
            }
        })

        this.client.on(Events.MessageCreate, async (message) => {
            if (message.partial) {
                await message.fetch()
                    .catch(error => {
                        console.log('Something went wrong when fetching the message: ', error);
                    });
            }

            if (!message.inGuild()) {
                await this.sysAdminCommandHandler.handleMessage(message)
                return
            }

            const guildHolder = this.guilds.get(message.guildId)
            if (!guildHolder) return

            // Handle message in guild
            try {
                await guildHolder.handleMessage(message)
            } catch (error) {
                console.error('Error handling message:', error)
            }
        })


        this.client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {


            if (!oldMessage.guildId || !newMessage.guildId) return

            const guildHolder = this.guilds.get(newMessage.guildId)
            if (!guildHolder) return;

            if (newMessage.partial) {
                await newMessage.fetch()
                    .catch(error => {
                        console.log('Something went wrong when fetching the message: ', error);
                    });
            }

            // Handle message in guild
            try {
                await guildHolder.handleMessageUpdate(oldMessage, newMessage)
            } catch (error) {
                console.error('Error handling message update:', error)
            }
        });


        this.client.on(Events.MessageDelete, async (message) => {
            if (!message.guildId) return

            const guildHolder = this.guilds.get(message.guildId)
            if (!guildHolder) return

            // Handle message in guild
            try {
                await guildHolder.handleMessageDelete(message)
            } catch (error) {
                console.error('Error handling message delete:', error)
            }
        })

        this.client.on(Events.ThreadDelete, async (thread) => {
            if (!thread.isTextBased()) return


            const guildHolder = this.guilds.get(thread.guildId)
            if (!guildHolder) return

            // Handle message in guild
            try {
                await guildHolder.handleThreadDelete(thread)
            } catch (error) {
                console.error('Error handling thread delete:', error)
            }
        })

        this.client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
            if (!newThread.isTextBased()) return

            const guildHolder = this.guilds.get(newThread.guildId)
            if (!guildHolder) return

            // Handle message in guild
            try {
                await guildHolder.handleThreadUpdate(oldThread, newThread)
            } catch (error) {
                console.error('Error handling thread update:', error)
            }
        });

        this.client.on('error', (error) => {
            console.error('Discord client error:', error)
        })
    }

    async loop() {
        if (!this.ready) {
            console.error('Bot is not ready')
            return
        }

        for (const guildHolder of this.guilds.values()) {
            await guildHolder.loop()
        }

        const now = Date.now();
        for (const [guildId, guildHolder] of this.guilds.entries()) {
            const lastDayTask = this.dayTaskTimestamps.get(guildId) || 0;
            if (now >= lastDayTask) {
                try {
                    await guildHolder.dayTasks();
                    this.dayTaskTimestamps.set(guildId, now + 24 * 60 * 60 * 1000);
                } catch (error) {
                    console.error(`Error running day tasks for guild ${guildId}:`, error);
                }
            }
        } 

        setTimeout(() => this.loop(), 1000)
    }

    public getTempDataStore(): TempDataStore {
        return this.tempData;
    }

    public getApiTokenManager(): APITokenManager {
        return this.apiTokenManager;
    }

    /**
     * Get the Github installation token for an organization.
     * @param orgId The ID of the organization.
     */
    public async getGithubInstallationToken(orgId: string): Promise<string> {
        const installations: { access_tokens_url: any; }[] = [];
        await this.githubClient?.eachInstallation(({ installation }) => {
            if (installation.account?.login === orgId) {
                installations.push(installation);
            }
        });

        if (installations.length === 0) {
            throw new Error(`No GitHub installation found for organization ${orgId}`);
        }

        const url = installations[0].access_tokens_url;

        const response = await this.githubClient?.octokit.request('POST ' + url, {
            headers: {
                'Accept': 'application/vnd.github+json',
            }
        });

        if (!response || !response.data || !response.data.token) {
            throw new Error(`Failed to get GitHub installation token for organization ${orgId}`);
        }
        return response.data.token;
    }
}
