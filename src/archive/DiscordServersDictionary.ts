import { Snowflake } from "discord.js"
import fs from "fs/promises";
import { RepositoryManager } from "./RepositoryManager.js";
import { ReferenceType } from "../utils/ReferenceUtils.js";
import { ArchiveEntry } from "./ArchiveEntry.js";
import { ArchiveEntryReference } from "./ArchiveChannel.js";
import { ArchiveChannelReference } from "./RepositoryConfigs.js";
import { safeJoinPath, safeWorkspacePath } from "../utils/SafePath.js";

export type DiscordServerEntry = {
    id: Snowflake,
    name: string,
    joinURL: string
}

export class DiscordServersDictionary {
    private cache: Promise<DiscordServerEntry[]> | null = null;
    private cacheTimeout?: NodeJS.Timeout;

    constructor(
        private folderPath: string,
        private repositoryManager?: RepositoryManager,
        private fallbackDictionary?: DiscordServersDictionary
    ) {
        this.folderPath = safeWorkspacePath(folderPath);
    }

    getConfigPath(): string {
        return safeJoinPath(this.folderPath, `discords.json`);
    }

    async getCachedServers(): Promise<DiscordServerEntry[]> {
        clearTimeout(this.cacheTimeout);
        this.cacheTimeout = setTimeout(() => {
            this.cache = null;
        }, 5 * 60 * 1000);

        if (this.cache) {
            return this.cache;
        }
        this.cache = this.getServers();

        return this.cache;
    }

    async getCachedServersWithFallback(): Promise<DiscordServerEntry[]> {
        const servers = await this.getCachedServers();
        if (!this.fallbackDictionary) {
            return servers;
        }

        const combined = [...servers];
        const ids = new Set(servers.map(s => s.id));
        const fallbackServers = await this.fallbackDictionary.getCachedServersWithFallback();
        for (const server of fallbackServers) {
            if (!ids.has(server.id)) {
                combined.push(server);
            }
        }

        return combined;
    }

    async getServers(): Promise<DiscordServerEntry[]> {
        await fs.mkdir(this.folderPath, { recursive: true });
        const entryPath = this.getConfigPath();
        return JSON.parse(await fs.readFile(entryPath, 'utf-8').catch(() => '[]')) as DiscordServerEntry[];
    }

    async getByID(id: Snowflake): Promise<DiscordServerEntry | undefined> {
        const servers = await this.getCachedServers();
        const entry = servers.find(s => s.id === id);
        if (entry) {
            return entry;
        }
        return this.fallbackDictionary?.getByID(id);
    }

    async updateReferences() {
        if (!this.repositoryManager) {
            return;
        }
        const servers = await this.getCachedServersWithFallback();
        const idToServer = new Map<Snowflake, DiscordServerEntry>();
        for (const server of servers) {
            if (server.id === this.repositoryManager.getGuildHolder().getGuild().id) {
                // Skip own server
                continue;
            }
            idToServer.set(server.id, server);
        }

        let numberOfArchiveUpdates = 0;
        let numberOfDictionaryUpdates = 0;

        await this.repositoryManager.iterateAllEntries(async (entry: ArchiveEntry, _entryRef: ArchiveEntryReference, channelRef: ArchiveChannelReference) => {
            const data = entry.getData();
            let modified = false;
            for (const reference of data.references) {
                if (reference.type === ReferenceType.DISCORD_LINK) {
                    const server = idToServer.get(reference.server);
                    if (server && (reference.serverName !== server.name || reference.serverJoinURL !== server.joinURL)) {
                        reference.serverName = server.name;
                        reference.serverJoinURL = server.joinURL;
                        modified = true;
                    }
                }
            }

            if (modified) {
                if (!this.repositoryManager) {
                    return;
                }
                await this.repositoryManager.addOrUpdateEntryFromData(
                    data,
                    channelRef.id,
                    {},
                    async () => { }
                ).catch((e) => {
                    console.error(`Error updating Discord server references for entry ${data.name} in channel ${channelRef.name}:`, e.message);
                });
                numberOfArchiveUpdates++;
            }

        }).catch((e) => {
            console.error("Error during Discord server tag checking:", e);
        });

        const dictionaryManager = this.repositoryManager.getDictionaryManager();
        await dictionaryManager.iterateEntries(async (definition) => {
            let modified = false;
            for (const reference of definition.references) {
                if (reference.type === ReferenceType.DISCORD_LINK) {
                    const server = idToServer.get(reference.server);
                    if (server && (reference.serverName !== server.name || reference.serverJoinURL !== server.joinURL)) {
                        reference.serverName = server.name;
                        reference.serverJoinURL = server.joinURL;
                        modified = true;
                    }
                }
            }

            if (modified) {
                await dictionaryManager.saveEntry(definition).catch((e) => {
                    console.error(`Error updating Discord server references for definition ${definition.terms[0]}:`, e.message);
                });
                await dictionaryManager.updateStatusMessage(definition).catch((e) => {
                    console.error(`Error updating status message for definition ${definition.terms[0]}:`, e.message);
                });
                numberOfDictionaryUpdates++;
            }
        }).catch((e) => {
            console.error("Error during Discord server tag checking in definitions:", e);
        });
    }

    async addOrEditServer(id: Snowflake, name: string, joinURL: string) {
        const servers = await this.getCachedServers();
        const existing = servers.find(s => s.id === id);
        if (existing) {
            existing.name = name;
            existing.joinURL = joinURL;
        } else {
            servers.push({
                id,
                name,
                joinURL
            });
        }
        const entryPath = this.getConfigPath();
        await fs.writeFile(entryPath, JSON.stringify(servers, null, 2), 'utf-8');

        if (!this.repositoryManager) {
            return;
        }

        const lock = this.repositoryManager.getLock();
        await lock.acquire();
        try {
            await this.repositoryManager.add(entryPath).catch((e) => {
                console.error("Error adding Discord servers dictionary to repository:", e);
            });
            if (!existing) {
                await this.updateReferences().catch((e) => {
                    console.error("Error updating Discord server references after adding new server:", e);
                });
            }
        } finally {
            lock.release();
        }
    }

    async removeServer(id: Snowflake): Promise<boolean> {
        const servers = await this.getCachedServers();
        const index = servers.findIndex(s => s.id === id);
        if (index === -1) {
            return false;
        }
        servers.splice(index, 1);
        const entryPath = this.getConfigPath();
        await fs.writeFile(entryPath, JSON.stringify(servers, null, 2), 'utf-8');

        if (!this.repositoryManager) {
            return true;
        }

        const lock = this.repositoryManager.getLock();
        await lock.acquire();
        try {
            await this.repositoryManager.add(entryPath).catch((e) => {
                console.error("Error adding Discord servers dictionary to repository:", e);
            });
            await this.updateReferences().catch((e) => {
                console.error("Error updating Discord server references after removing server:", e);
            });
        } finally {
            lock.release();
        }
        return true;
    }

}
