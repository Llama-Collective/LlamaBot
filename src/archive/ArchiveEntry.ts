import { Snowflake } from "discord.js";
import { Attachment } from "../submissions/Attachment.js";
import { Author } from "../submissions/Author.js";
import { Image } from "../submissions/Image.js";
import { Tag } from "../submissions/Tag.js";
import fs from "fs/promises";
import { StyleInfo, SubmissionRecords } from "../utils/MarkdownUtils.js";
import { Reference } from "../utils/ReferenceUtils.js";
import { safeJoinPath, safeWorkspacePath } from "../utils/SafePath.js";

export type DiscordPostReference = {
    forumId: Snowflake;
    threadId: Snowflake;
    threadURL: string;
    continuingMessageIds: Snowflake[];
    uploadMessageId: Snowflake;
}

export type ArchiveEntryData = {
    id: Snowflake;
    name: string;
    code: string;

    reservedCodes: string[];
    pastPostThreadIds: Snowflake[];

    authors: Author[];
    endorsers: Author[];
    tags: Tag[];

    images: Image[];
    attachments: Attachment[];

    records: SubmissionRecords;
    styles: Record<string, StyleInfo>;
    references: Reference[];
    author_references: Reference[];

    /// For routing
    post?: DiscordPostReference;

    timestamp?: number; // legacy
    archivedAt: number;
    updatedAt: number;

    // comments
    num_comments: number;
}

export class ArchiveEntry {
    private data: ArchiveEntryData;
    private folderPath: string;

    constructor(data: ArchiveEntryData, folderPath: string) {
        this.data = data;
        this.folderPath = safeWorkspacePath(folderPath);
    }

    public getData(): ArchiveEntryData {
        return this.data;
    }

    public setData(data: ArchiveEntryData): void {
        this.data = data;
    }

    public getFolderPath(): string {
        return this.folderPath;
    }

    public getDataPath(): string {
        return safeJoinPath(this.folderPath, 'data.json');
    }

    public async savePrivate(): Promise<void> {
        const dataPath = this.getDataPath();

        const dataCleaned: ArchiveEntryData = {
            id: this.data.id,
            name: this.data.name,
            code: this.data.code,
            reservedCodes: this.data.reservedCodes,
            pastPostThreadIds: this.data.pastPostThreadIds,
            authors: this.data.authors,
            endorsers: this.data.endorsers,
            tags: this.data.tags,
            images: this.data.images,
            attachments: this.data.attachments,
            records: this.data.records,
            styles: this.data.styles,
            references: this.data.references,
            author_references: this.data.author_references,
            post: this.data.post,
            archivedAt: this.data.archivedAt,
            updatedAt: this.data.updatedAt,
            num_comments: this.data.num_comments
        };

        return fs.writeFile(dataPath, JSON.stringify(dataCleaned, null, 2), 'utf-8');
    }

    public async load(): Promise<void> {
        const dataPath = this.getDataPath();
        this.data = JSON.parse(await fs.readFile(dataPath, 'utf-8')) as ArchiveEntryData;
    }

    public static async fromFolder(folder: string): Promise<ArchiveEntry | null> {
        const safeFolder = safeWorkspacePath(folder);
        const dataPath = safeJoinPath(safeFolder, 'data.json');
        try {
            const data: ArchiveEntryData = JSON.parse(await fs.readFile(dataPath, 'utf-8'));
            const entry = new ArchiveEntry(data, safeFolder);
            return entry;
        } catch (error) {
            return null;
        }
    }

}
