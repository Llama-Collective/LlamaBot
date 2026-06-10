import { AutocompleteInteraction, ChatInputCommandInteraction, EmbedBuilder, InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { Command } from "../interface/Command.js";
import { GuildHolder } from "../GuildHolder.js";
import { getAuthorsString, replyEphemeral, truncateStringWithEllipsis } from "../utils/Util.js";
import { PostCodePattern, transformOutputWithReferencesForDiscord } from "../utils/ReferenceUtils.js";
import { ArchiveIndexEntry } from "../archive/IndexManager.js";
import { base64ToInt8Array, generateQueryEmbeddings } from "../llm/EmbeddingUtils.js";

const MIN_RESULTS = 5;
const AUTOCOMPLETE_LIMIT = 25;

export class SearchCommand implements Command {
    getID(): string {
        return "search";
    }

    getBuilder(_guildHolder: GuildHolder): SlashCommandBuilder {
        const data = new SlashCommandBuilder()
            .setName(this.getID())
            .setDescription("Search archived posts by code or name")
            .setContexts(InteractionContextType.Guild)


        data.addStringOption(opt =>
            opt
                .setName("query")
                .setDescription("Post code or name to search for")
                .setRequired(true)
                .setAutocomplete(true)
        );

        return data;
    }

    private async getIndexEntries(guildHolder: GuildHolder): Promise<ArchiveIndexEntry[]> {
        const archiveIndex = await guildHolder.getDictionaryManager().getArchiveIndex();
        return archiveIndex.idToData.values().toArray();
    }

    private rank(entries: ArchiveIndexEntry[], queryRaw: string): ArchiveIndexEntry[] {
        const query = queryRaw.trim().toLowerCase();
        if (!query) return entries;

        // check if query is code
        const isCode = /[a-z]+[0-9]{0,3}/i.test(query);
        const scored = entries.map(entry => {
            let score = 0;

            if (isCode) {
                if (entry.code.toLowerCase() === query) {
                    score += 100;
                } else if (entry.code.toLowerCase().startsWith(query)) {
                    score += 50;
                } else if (entry.code.toLowerCase().includes(query)) {
                    score += 10;
                }
            }

            // check name
            if (entry.name) {
                const nameLower = entry.name.toLowerCase();
                if (nameLower === query) {
                    score += 80;
                } else if (nameLower.startsWith(query)) {
                    score += 40;
                } else if (nameLower.includes(query)) {
                    score += 8;
                }
            }

            return { entry, score };
        }).filter(item => item.score > 0);

        scored.sort((a, b) => b.score - a.score);

        return scored.map(item => item.entry);
    }

    private async getTraditionalResults(guildHolder: GuildHolder, query: string): Promise<ArchiveIndexEntry[]> {
        const entries = await this.getIndexEntries(guildHolder);
        const results: ArchiveIndexEntry[] = [];
        const seenCodes = new Set<string>();

        if (PostCodePattern.test(query)) {
            const directEntry = await guildHolder.getRepositoryManager().getEntryByPostCode(query);
            if (directEntry) {
                const data = directEntry.entry.getData();
                results.push({
                    name: data.name,
                    code: data.code,
                    thread: data.post?.threadId || "",
                    url: data.post?.threadURL || "",
                    path: "",
                });
                seenCodes.add(data.code.toLowerCase());
            }
        }

        for (const entry of this.rank(entries, query)) {
            const normalizedCode = entry.code.toLowerCase();
            if (seenCodes.has(normalizedCode)) {
                continue;
            }
            results.push(entry);
            seenCodes.add(normalizedCode);
        }

        return results;
    }

    private async getSemanticResults(guildHolder: GuildHolder, query: string, limit: number, seenCodes: Set<string>): Promise<ArchiveIndexEntry[]> {
        if (limit <= 0 || query.trim().length === 0) {
            return [];
        }

        const queryEmbeddings = await generateQueryEmbeddings([query.trim()]).catch(e => {
            console.error("Error generating query embeddings for search command:", e);
            return null;
        });
        if (!queryEmbeddings || queryEmbeddings.embeddings.length === 0) {
            return [];
        }

        const queryEmbeddingVector = base64ToInt8Array(queryEmbeddings.embeddings[0]);
        const closest = await guildHolder.getRepositoryManager().getClosest(queryEmbeddingVector, limit + seenCodes.size).catch(e => {
            console.error("Error getting semantic search results:", e);
            return [];
        });

        const results: ArchiveIndexEntry[] = [];
        for (const result of closest) {
            if (results.length >= limit) {
                break;
            }

            const normalizedCode = result.identifier.toLowerCase();
            if (seenCodes.has(normalizedCode)) {
                continue;
            }

            const entry = await guildHolder.getRepositoryManager().getEntryByPostCode(result.identifier);
            if (!entry) {
                continue;
            }

            const data = entry.entry.getData();
            results.push({
                name: data.name,
                code: data.code,
                thread: data.post?.threadId || "",
                url: data.post?.threadURL || "",
                path: "",
            });
            seenCodes.add(data.code.toLowerCase());
        }

        return results;
    }

    private async getCombinedResults(guildHolder: GuildHolder, query: string, minimumResults: number): Promise<ArchiveIndexEntry[]> {
        const traditional = await this.getTraditionalResults(guildHolder, query);
        if (traditional.length >= minimumResults) {
            return traditional;
        }

        const seenCodes = new Set(traditional.map(entry => entry.code.toLowerCase()));
        const semantic = await this.getSemanticResults(guildHolder, query, minimumResults - traditional.length, seenCodes);
        return [...traditional, ...semantic];
    }

    private async getEntryEmbed(guildHolder: GuildHolder, code: string): Promise<EmbedBuilder | null> {
        const entry = await guildHolder.getRepositoryManager().getEntryByPostCode(code);
        if (!entry) {
            return null;
        }

        const entryData = entry.entry.getData();
        const name = entryData.code + ': ' + entryData.name;
        const authors = getAuthorsString(entryData.authors);
        const tags = entryData.tags.map(tag => tag.name).join(', ');
        const description = entryData.records.description as string || '';
        const image = guildHolder.getPostThumbnailURL(entryData);

        const textArr = [
            `**Authors:** ${authors}`,
            `**Tags:** ${tags || 'None'}`,
        ];
        if (description) {
            textArr.push('\n' + transformOutputWithReferencesForDiscord(description, entryData.references));
        }

        const embed = new EmbedBuilder()
            .setTitle(truncateStringWithEllipsis(name, 256))
            .setDescription(truncateStringWithEllipsis(textArr.join('\n'), 500))
            .setColor(0x00AE86)
            .setURL(entryData.post?.threadURL || '');
        if (image) {
            embed.setThumbnail(image);
        }

        return embed;
    }

    async execute(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction): Promise<void> {
        if (!interaction.inGuild()) {
            await replyEphemeral(interaction, "This command can only be used in a guild.");
            return;
        }

        const query = interaction.options.getString("query", true);
        const results = await this.getCombinedResults(guildHolder, query, MIN_RESULTS);
        const embeds = [];

        for (const result of results.slice(0, MIN_RESULTS)) {
            const embed = await this.getEntryEmbed(guildHolder, result.code);
            if (embed) {
                embeds.push(embed);
            }
        }

        if (embeds.length === 0) {
            await interaction.reply({ content: `No results found for "${query}".`, ephemeral: true });
            return;
        }

        await interaction.reply({ 
            content: `Search results for "${query}":`,
            embeds,
            flags: [MessageFlags.SuppressNotifications],
            allowedMentions: { parse: [] }
        });
    }

    async autocomplete(guildHolder: GuildHolder, interaction: AutocompleteInteraction): Promise<void> {
        const query = interaction.options.getFocused() || "";
        const ranked = await this.getCombinedResults(guildHolder, query, MIN_RESULTS);

        const choices = ranked.slice(0, AUTOCOMPLETE_LIMIT).map(entry => ({
            name: `${entry.code} — ${entry.name}`.slice(0, 100),
            value: entry.code.slice(0, 100),
        }));

        await interaction.respond(choices);
    }
}
