import { Snowflake } from "discord.js";
import { Submission } from "./Submission.js";
import fs from "fs/promises";
import { GuildHolder } from "../GuildHolder.js";
import { safeJoinPath, safeWorkspacePath } from "../utils/SafePath.js";

export class SubmissionsManager {
    private submissions: Map<Snowflake, Submission>;
    private submissionPromises: Map<Snowflake, Promise<void>>;
    private storagePath: string;
    private guildHolder: GuildHolder;

    constructor(guildHolder: GuildHolder, storagePath: string) {
        this.submissions = new Map();
        this.submissionPromises = new Map();
        this.guildHolder = guildHolder;
        this.storagePath = safeWorkspacePath(storagePath);
    }

    /**
     * Creates a new submission with the given ID.
     * @param id The ID of the submission to create.
     * @returns 
     */
    async makeSubmission(id: Snowflake) {
        const folderPath = safeJoinPath(this.storagePath, id)
        await fs.mkdir(folderPath, { recursive: true })

        const submission = new Submission(this.guildHolder, id, folderPath)
        this.submissions.set(id, submission)

        return submission
    }


    /**
     * Retrieves a submission by its ID.
     * @param id The ID of the submission to retrieve.
     * @returns 
     */
    async getSubmission(id: Snowflake): Promise<Submission | null> {
        if (this.submissions.has(id)) {
            const submission = this.submissions.get(id) as Submission
            submission.updateLastAccessed();
            return submission
        }

        if (this.submissionPromises.has(id)) {
            // If a promise is already in progress, wait for it
            const existingPromise = this.submissionPromises.get(id);
            if (existingPromise) {
                await existingPromise.catch(() => { });
            }
            return this.submissions.get(id) || null;
        }

        // Check file system
        const folderPath = safeJoinPath(this.storagePath, id)
        // check if folder exists
        try {
            await fs.access(folderPath)
        } catch (e) {
            return null
        }

        // Load submission from path
        const submission = new Submission(this.guildHolder, id, folderPath)
        const promise = (async () => {
            try {
                await submission.load();
                this.submissions.set(id, submission);

                if (this.submissions.size > 10) {
                    const junkableSubmissions = Array.from(this.submissions.values()).filter(v => v.canJunk());
                    if (junkableSubmissions.length > 0) {
                        const oldestSubmission = junkableSubmissions.reduce((oldest, current) => {
                            return current.lastAccessed < oldest.lastAccessed ? current : oldest
                        });
                        await oldestSubmission.save();
                        this.submissions.delete(oldestSubmission.getId());
                    }
                }
            } catch (e) {
                console.error('Error loading submission:', e);
            } finally {
                // Always clear pending-load state to avoid permanently stuck IDs.
                this.submissionPromises.delete(id);
            }
        })();

        this.submissionPromises.set(id, promise);
        try {
            await promise;
            return this.submissions.get(id) || null;
        } catch (e) {
            console.error('Error loading submission:', e)
            return null
        }
    }

    public async getSubmissionsList(): Promise<Snowflake[]> {
        const folder = this.storagePath;
        try {
            const files = await fs.readdir(folder);
            const submissions = files.filter(file => file.match(/^\d+$/)); // Match only numeric folder names
            return submissions as Snowflake[];
        }
        catch (error) {
            console.error('Error reading submissions directory:', error);
            return [];
        }
    }

    public removeSubmission(id: Snowflake) {
        const submission = this.submissions.get(id);
        if (submission && submission.canJunk()) {
            this.submissions.delete(id);
        }
    }

    /**
     * Purges old submissions that have not been accessed in the last 24 hours.
     */
    async purgeOldSubmissions() {
        const now = Date.now()
        const threshold = 1000 * 60 * 60 * 24 // 1 day

        const submissionsToDelete = []
        for (const [forumThreadId, submission] of this.submissions.entries()) {
            if (now - submission.lastAccessed > threshold && submission.canJunk()) {
                submissionsToDelete.push(forumThreadId)
            }
        }

        for (const forumThreadId of submissionsToDelete) {
            const submission = this.submissions.get(forumThreadId)
            if (submission) {
                await submission.save()
                this.submissions.delete(forumThreadId)
            }
        }
    }

    async saveSubmissions() {
        const promises = Array.from(this.submissions.values()).map(submission => submission.save());
        await Promise.all(promises);
    }
}
