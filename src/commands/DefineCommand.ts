import { AutocompleteInteraction, ChatInputCommandInteraction, EmbedBuilder, InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";
import { GuildHolder } from "../GuildHolder.js";
import { Command } from "../interface/Command.js";
import { MarkdownCharacterRegex, transformOutputWithReferencesForDiscord } from "../utils/ReferenceUtils.js";
import { replyEphemeral, splitIntoChunks, truncateStringWithEllipsis } from "../utils/Util.js";
import { BasicDictionaryIndexEntry } from "../archive/IndexManager.js";
import { base64ToInt8Array, generateQueryEmbeddings } from "../llm/EmbeddingUtils.js";

const MIN_RESULTS = 5;
const AUTOCOMPLETE_LIMIT = 25;

export class DefineCommand implements Command {
    getID(): string {
        return "define";
    }

    getBuilder(_guildHolder: GuildHolder): SlashCommandBuilder {
        const data = new SlashCommandBuilder();
        data.setName(this.getID())
            .setDescription("Look up a dictionary definition")
            .setContexts(InteractionContextType.Guild);

        data.addStringOption(option =>
            option
                .setName("term")
                .setDescription("Dictionary term to define")
                .setRequired(true)
                .setAutocomplete(true)
        );

        return data;
    }

    private normalizeTerm(term: string): string {
        return term.toLowerCase().replace(MarkdownCharacterRegex, "").trim();
    }

    private rankTermEntries(terms: BasicDictionaryIndexEntry[], query: string): { termsRanked: { term: string, score: number }[]; term: BasicDictionaryIndexEntry; score: number }[] {
        const normalizedQuery = this.normalizeTerm(query);
        if (normalizedQuery.length === 0) {
            return terms.map(termEntry => ({
                termsRanked: termEntry.terms.map(term => ({ term, score: 0 })),
                term: termEntry,
                score: 0
            }));
        }

        const scoredTermEntries = terms.map(termEntry => {
            let score = 0;
            let totalScore = 0;
            const scoredTerms = termEntry.terms.map(term => {
                const normalizedTerm = this.normalizeTerm(term);
                let score = 0;
                if (normalizedTerm === normalizedQuery) {
                    score += 100;
                } else if (normalizedTerm.startsWith(normalizedQuery)) {
                    score += 50;
                } else if (normalizedTerm.includes(normalizedQuery)) {
                    score += 10;
                }
                totalScore += score;
                return { term, score };
            });

            if (totalScore > 0) {
                scoredTerms.sort((a, b) => b.score - a.score);
            }

            if (scoredTerms.length > 0) {
                score = scoredTerms[0].score;
            }

            return {
                termsRanked: scoredTerms,
                term: termEntry,
                score
            };
        }).filter(entry => entry.score > 0);
        scoredTermEntries.sort((a, b) => b.score - a.score);
        return scoredTermEntries;
    }

    private rankTerms(terms: string[], query: string): { term: string, score: number }[] {
        const normalizedQuery = this.normalizeTerm(query);

        const scoredTerms = terms.map(term => {
            const normalizedTerm = this.normalizeTerm(term);
            let score = 0;
            if (normalizedTerm === normalizedQuery) {
                score += 100;
            } else if (normalizedTerm.startsWith(normalizedQuery)) {
                score += 50;
            } else if (normalizedTerm.includes(normalizedQuery)) {
                score += 10;
            }
            return { term, score };
        }).filter(entry => entry.score > 0);

        scoredTerms.sort((a, b) => b.score - a.score);

        return scoredTerms;
    }

    private async getTraditionalResults(guildHolder: GuildHolder, query: string): Promise<BasicDictionaryIndexEntry[]> {
        const results: BasicDictionaryIndexEntry[] = [];
        const seenIds = new Set<string>();

        if (/^[0-9]{17,19}$/.test(query)) {
            const directEntry = await guildHolder.getDictionaryManager().getEntry(query);
            if (directEntry) {
                results.push({ terms: directEntry.terms, id: directEntry.id });
                seenIds.add(directEntry.id);
            }
        }

        const terms = await guildHolder.getDictionaryManager().getBasicDictionaryIndex();
        for (const ranked of this.rankTermEntries(terms, query)) {
            if (seenIds.has(ranked.term.id)) {
                continue;
            }
            results.push({
                terms: ranked.termsRanked.map(term => term.term),
                id: ranked.term.id,
            });
            seenIds.add(ranked.term.id);
        }

        return results;
    }

    private async getSemanticResults(guildHolder: GuildHolder, query: string, limit: number, seenIds: Set<string>): Promise<BasicDictionaryIndexEntry[]> {
        if (limit <= 0 || query.trim().length === 0) {
            return [];
        }

        const queryEmbeddings = await generateQueryEmbeddings([query.trim()]).catch(e => {
            console.error("Error generating query embeddings for define command:", e);
            return null;
        });
        if (!queryEmbeddings || queryEmbeddings.embeddings.length === 0) {
            return [];
        }

        const queryEmbeddingVector = base64ToInt8Array(queryEmbeddings.embeddings[0]);
        const closest = await guildHolder.getDictionaryManager().getClosest(queryEmbeddingVector, limit + seenIds.size).catch(e => {
            console.error("Error getting semantic define results:", e);
            return [];
        });

        const results: BasicDictionaryIndexEntry[] = [];
        for (const result of closest) {
            if (results.length >= limit) {
                break;
            }

            if (seenIds.has(result.identifier)) {
                continue;
            }

            const entry = await guildHolder.getDictionaryManager().getEntry(result.identifier);
            if (!entry) {
                continue;
            }

            results.push({ terms: entry.terms, id: entry.id });
            seenIds.add(entry.id);
        }

        return results;
    }

    private async getCombinedResults(guildHolder: GuildHolder, query: string, minimumResults: number): Promise<BasicDictionaryIndexEntry[]> {
        const traditional = await this.getTraditionalResults(guildHolder, query);
        if (traditional.length >= minimumResults) {
            return traditional;
        }

        const seenIds = new Set(traditional.map(entry => entry.id));
        const semantic = await this.getSemanticResults(guildHolder, query, minimumResults - traditional.length, seenIds);
        return [...traditional, ...semantic];
    }

    private async getEntryEmbeds(guildHolder: GuildHolder, termId: string, query: string): Promise<EmbedBuilder[]> {
        const entry = await guildHolder.getDictionaryManager().getEntry(termId);
        if (!entry) {
            return [];
        }

        const url = entry.statusURL || entry.threadURL || "";
        const definitionSplit = splitIntoChunks(transformOutputWithReferencesForDiscord(entry.definition, entry.references), 4000);
        const closestMatchTerm = this.rankTerms(entry.terms, query)[0]?.term || entry.terms[0];

        return definitionSplit.map((definition, index) => {
            const embed = new EmbedBuilder()
                .setTitle(truncateStringWithEllipsis(closestMatchTerm, 256))
                .setDescription(definition)
                .setColor(0x2d7d46);

            if (definitionSplit.length > 1) {
                embed.setFooter({ text: `Part ${index + 1} of ${definitionSplit.length}` });
            }

            if (url) {
                embed.setURL(url);
            }

            return embed;
        });
    }

    async execute(guildHolder: GuildHolder, interaction: ChatInputCommandInteraction): Promise<void> {
        if (!interaction.inGuild()) {
            await replyEphemeral(interaction, "This command can only be used in a guild.");
            return;
        }

        const termId = interaction.options.getString("term", true);
        const results = await this.getCombinedResults(guildHolder, termId, MIN_RESULTS);
        const embeds: EmbedBuilder[] = [];

        for (const result of results.slice(0, MIN_RESULTS)) {
            embeds.push(...await this.getEntryEmbeds(guildHolder, result.id, termId));
        }

        if (embeds.length === 0) {
            await replyEphemeral(interaction, `No definition found for "${termId}".`);
            return;
        }

        for (let i = 0; i < embeds.length; i++) {
            if (i === 0) {
                await interaction.reply({ 
                    content: `Definition results for "${termId}":`,
                    embeds: [embeds[i]],
                    flags: [MessageFlags.SuppressNotifications],
                    allowedMentions: { parse: [] }
                });
            } else {
                await interaction.followUp({ 
                    embeds: [embeds[i]],
                    flags: [MessageFlags.SuppressNotifications],
                    allowedMentions: { parse: [] }
                });
            }
        }
    }

    async autocomplete(guildHolder: GuildHolder, interaction: AutocompleteInteraction): Promise<void> {
        const focused = interaction.options.getFocused() || "";
        const ranked = await this.getCombinedResults(guildHolder, focused, MIN_RESULTS);

        const choices = ranked.slice(0, AUTOCOMPLETE_LIMIT).map(term => ({
            name: term.terms.join(", ").slice(0, 100),
            value: term.id
        }));

        await interaction.respond(choices);
    }
}
