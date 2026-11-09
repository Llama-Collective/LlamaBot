import { createReadStream } from "fs";
import fs from "fs/promises";
import { Server } from "http";
import express, { NextFunction, Request, Response } from "express";
import path from "path";
import { Bot } from "../Bot.js";
import { SubmissionConfigs } from "../submissions/SubmissionConfigs.js";
import type { GuildHolder } from "../GuildHolder.js";
import type { Submission } from "../submissions/Submission.js";
import type {
	APIErrorResponse,
	APIHealthResponse,
	APIJsonResponse,
	APIPagination,
	APIServerInfo,
	APIServersResponse,
	APISubmissionDetails,
	APISubmissionResponse,
	APISubmissionsResponse,
	APISubmissionSummary,
	APISubmissionTimestampInfo
} from "./APITypes.js";
import type { APITokenRecord } from "./APITokenManager.js";
import { getAuthorName } from "../utils/Util.js";
import { safeResolvePathOrNull } from "../utils/SafePath.js";

const DEFAULT_PORT = 4938;
const DEFAULT_HOST = "127.0.0.1";
const DISCORD_EPOCH = 1_420_070_400_000n;
// Origins allowed to fetch attachment files without a bearer token (the Crea schematic viewer).
const PUBLIC_ATTACHMENT_ORIGINS = new Set(["https://crea.llamamc.org"]);
const ATTACHMENT_PATH_PATTERN = /^\/server\/[^/]+\/submission\/[^/]+\/attachments\/[^/]+(?:\/[^/]+)?\/?$/;

function parsePort(value: string | undefined): number {
	if (!value) return DEFAULT_PORT;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
		return DEFAULT_PORT;
	}
	return parsed;
}

export class APIServer {
	private readonly app = express();
	private server: Server | null = null;
	private readonly port: number;
	private readonly host: string;

	constructor(private readonly bot: Bot) {
		this.port = parsePort(process.env.API_SERVER_PORT);
		this.host = process.env.API_SERVER_HOST?.trim() || DEFAULT_HOST;
		this.configureApp();
	}

	public async start(): Promise<void> {
		if (this.server) return;

		await new Promise<void>((resolve, reject) => {
			const server = this.app.listen(this.port, this.host, () => {
				this.server = server;
				console.log(`API server listening on http://${this.host}:${this.port}`);
				resolve();
			});
			server.once("error", reject);
		});
	}

	public async stop(): Promise<void> {
		if (!this.server) return;

		const server = this.server;
		this.server = null;

		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	}

	private configureApp(): void {
		this.app.disable("x-powered-by");

		this.app.use((req: Request, res: Response, next: NextFunction) => {
			res.vary("Origin");
			if (!this.isPublicAttachmentOrigin(req)) {
				next();
				return;
			}

			res.setHeader("Access-Control-Allow-Origin", req.header("origin")!);
			res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, Content-Type");
			if (req.method === "OPTIONS") {
				res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
				res.setHeader("Access-Control-Allow-Headers", req.header("access-control-request-headers") || "");
				res.setHeader("Access-Control-Max-Age", "86400");
				res.status(204).end();
				return;
			}
			next();
		});

		this.app.use(async (req: Request, res: Response, next: NextFunction) => {
			try {
				if (this.isPublicAttachmentRequest(req)) {
					next();
					return;
				}
				const isAuthed = await this.authenticate(req, res);
				if (!isAuthed) return;
				next();
			} catch (error) {
				next(error);
			}
		});

		this.app.get(["/ping", "/health", "/healthz"], (_req: Request, res: Response) => {
			const payload: APIHealthResponse = {
				ok: true,
				service: "storage-tech-bot-api",
				timestamp: new Date().toISOString()
			};
			this.respondJson(res, 200, payload);
		});

		this.app.get("/servers", (req: Request, res: Response) => {
			this.handleGetServers(req, res);
		});

		this.app.get("/server/:serverId/submissions", async (req: Request, res: Response) => {
			const serverId = this.getParam(req.params.serverId);
			await this.handleGetSubmissions(serverId, req, res);
		});

		this.app.get("/server/:serverId/submission/:submissionId", async (req: Request, res: Response) => {
			const serverId = this.getParam(req.params.serverId);
			const submissionId = this.getParam(req.params.submissionId);
			await this.handleGetSubmission(serverId, submissionId, res);
		});

		// The optional trailing file name is ignored; it lets viewers like Crea detect the file type from the URL.
		this.app.get([
			"/server/:serverId/submission/:submissionId/attachments/:attachmentId",
			"/server/:serverId/submission/:submissionId/attachments/:attachmentId/:fileName"
		], async (req: Request, res: Response) => {
			const serverId = this.getParam(req.params.serverId);
			const submissionId = this.getParam(req.params.submissionId);
			const attachmentId = this.getParam(req.params.attachmentId);
			await this.handleGetSubmissionAttachment(serverId, submissionId, attachmentId, res);
		});

		this.app.get("/server/:serverId/submission/:submissionId/images/:imageId", async (req: Request, res: Response) => {
			const serverId = this.getParam(req.params.serverId);
			const submissionId = this.getParam(req.params.submissionId);
			const imageId = this.getParam(req.params.imageId);
			await this.handleGetSubmissionImage(serverId, submissionId, imageId, res);
		});

		this.app.use((_req: Request, res: Response) => {
			this.respondError(res, 404, "Not Found");
		});

		this.app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
			console.error("API request failed:", error);
			if (res.headersSent) return;
			this.respondError(res, 500, "Internal Server Error");
		});
	}

	private isPublicAttachmentOrigin(req: Request): boolean {
		const origin = req.header("origin");
		return !!origin && PUBLIC_ATTACHMENT_ORIGINS.has(origin);
	}

	/**
	 * Attachment downloads requested from an allowed viewer origin skip bearer auth.
	 * Note: Origin can be forged by non-browser clients, so this makes attachment files effectively public.
	 */
	private isPublicAttachmentRequest(req: Request): boolean {
		return (req.method === "GET" || req.method === "HEAD")
			&& this.isPublicAttachmentOrigin(req)
			&& ATTACHMENT_PATH_PATTERN.test(req.path);
	}

	private async authenticate(req: Request, res: Response): Promise<boolean> {
		const authHeader = req.header("authorization");
		if (!authHeader) {
			this.respondUnauthorized(res);
			return false;
		}

		const [scheme, tokenValue] = authHeader.trim().split(/\s+/, 2);
		if (!scheme || !tokenValue || scheme.toLowerCase() !== "bearer") {
			this.respondUnauthorized(res);
			return false;
		}

		const tokenRecord = await this.bot.getApiTokenManager().validateToken(tokenValue);
		if (!tokenRecord) {
			this.respondUnauthorized(res);
			return false;
		}

		const requestedServerId = this.getRequestedServerId(req.path);
		if (requestedServerId && !this.bot.getApiTokenManager().isTokenAllowedForServer(tokenRecord, requestedServerId)) {
			this.respondError(res, 403, "Forbidden for this server");
			return false;
		}

		this.setAuthenticatedToken(res, tokenRecord);
		await this.bot.getApiTokenManager().markTokenUsed(tokenRecord.id);
		return true;
	}

	private handleGetServers(_req: Request, res: Response): void {
		const token = this.getAuthenticatedToken(res);

		const servers: APIServerInfo[] = Array.from(this.bot.guilds.values())
			.map(holder => ({
				id: holder.getGuild().id,
				name: holder.getGuild().name
			}))
			.filter(server => {
				if (!token) return false;
				return this.bot.getApiTokenManager().isTokenAllowedForServer(token, server.id);
			})
			.sort((a, b) => a.name.localeCompare(b.name));

		const payload: APIServersResponse = {
			ok: true,
			servers
		};
		this.respondJson(res, 200, payload);
	}

	private async handleGetSubmissions(serverId: string, req: Request, res: Response): Promise<void> {
		const guildHolder = this.getGuildHolderOrRespond(serverId, res);
		if (!guildHolder) return;

		const page = this.parseIntegerQuery(req.query.page, 1, 1, Number.MAX_SAFE_INTEGER);
		const pageSize = this.parseIntegerQuery(req.query.pageSize, 50, 1, 200);

		const sortedIds = (await guildHolder.getSubmissionsManager().getSubmissionsList())
			.sort((a, b) => this.compareSnowflakeIds(b, a));

		const total = sortedIds.length;
		const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
		const currentPage = totalPages === 0 ? 1 : Math.min(page, totalPages);
		const start = (currentPage - 1) * pageSize;
		const pageIds = sortedIds.slice(start, start + pageSize);

		const submissions = await Promise.all(
			pageIds.map(id => guildHolder.getSubmissionsManager().getSubmission(id))
		);

		const pagedSubmissions = await Promise.all(
			submissions
				.filter((submission): submission is Submission => submission !== null)
				.map(submission => this.buildSubmissionSummary(submission))
		);

		const pagination: APIPagination = {
			page: currentPage,
			pageSize,
			total,
			totalPages,
			hasNext: currentPage < totalPages,
			hasPrevious: currentPage > 1
		};

		const payload: APISubmissionsResponse = {
			ok: true,
			server: this.toServerInfo(guildHolder),
			submissions: pagedSubmissions,
			pagination
		};
		this.respondJson(res, 200, payload);
	}

	private async handleGetSubmission(serverId: string, submissionId: string, res: Response): Promise<void> {
		const guildHolder = this.getGuildHolderOrRespond(serverId, res);
		if (!guildHolder) return;

		const submission = await guildHolder.getSubmissionsManager().getSubmission(submissionId);
		if (!submission) {
			this.respondError(res, 404, `Submission not found: ${submissionId}`);
			return;
		}

		const config = submission.getConfigManager();
		const timestamp = await this.getSubmissionTimestamps(submission);

		const currentRevision = submission.getRevisionsManager().getCurrentRevision();
		const revisionData = currentRevision ? await submission.getRevisionsManager().getRevisionById(currentRevision.id) : null;

		const submissionPayload: APISubmissionDetails = {
			id: submission.getId(),
			name: config.getConfig(SubmissionConfigs.NAME),
			status: config.getConfig(SubmissionConfigs.STATUS),
			threadId: config.getConfig(SubmissionConfigs.SUBMISSION_THREAD_ID) || submission.getId(),
			threadUrl: config.getConfig(SubmissionConfigs.SUBMISSION_THREAD_URL),
			archiveChannelId: config.getConfig(SubmissionConfigs.ARCHIVE_CHANNEL_ID) || null,
			isLocked: config.getConfig(SubmissionConfigs.IS_LOCKED),
			lockReason: config.getConfig(SubmissionConfigs.LOCK_REASON),
			onHold: config.getConfig(SubmissionConfigs.ON_HOLD),
			holdReason: config.getConfig(SubmissionConfigs.HOLD_REASON),
			rejectionReason: config.getConfig(SubmissionConfigs.REJECTION_REASON),
			retractionReason: config.getConfig(SubmissionConfigs.RETRACTION_REASON),
			tags: config.getConfig(SubmissionConfigs.TAGS) || [],
			authors: config.getConfig(SubmissionConfigs.AUTHORS) || [],
			endorsers: config.getConfig(SubmissionConfigs.ENDORSERS),
			images: config.getConfig(SubmissionConfigs.IMAGES) || [],
			attachments: config.getConfig(SubmissionConfigs.ATTACHMENTS) || [],
			revision: revisionData ? {
				id: revisionData.id,
				timestamp: revisionData.timestamp,
				records: revisionData.records,
				styles: revisionData.styles
			} : null,
			timestamp
		};

		const payload: APISubmissionResponse = {
			ok: true,
			server: this.toServerInfo(guildHolder),
			submission: submissionPayload
		};
		this.respondJson(res, 200, payload);
	}

	private async handleGetSubmissionAttachment(
		serverId: string,
		submissionId: string,
		attachmentId: string,
		res: Response
	): Promise<void> {
		const guildHolder = this.getGuildHolderOrRespond(serverId, res);
		if (!guildHolder) return;

		const submission = await guildHolder.getSubmissionsManager().getSubmission(submissionId);
		if (!submission) {
			this.respondError(res, 404, `Submission not found: ${submissionId}`);
			return;
		}

		const attachment = await submission.getAttachmentById(attachmentId);
		if (!attachment) {
			this.respondError(res, 404, `Attachment not found: ${attachmentId}`);
			return;
		}

		if (attachment.path) {
			const filePath = this.resolveSafePath(submission.getAttachmentFolder(), attachment.path);
			if (filePath && await this.fileExists(filePath)) {
				await this.sendFile(res, filePath, this.resolveContentType(attachment.contentType, attachment.name), attachment.name);
				return;
			}
		}

		const fallbackUrl = attachment.downloadUrl || attachment.url;
		if (fallbackUrl) {
			this.redirect(res, fallbackUrl);
			return;
		}

		this.respondError(res, 404, `Attachment content not available: ${attachmentId}`);
	}

	private async handleGetSubmissionImage(
		serverId: string,
		submissionId: string,
		imageId: string,
		res: Response
	): Promise<void> {
		const guildHolder = this.getGuildHolderOrRespond(serverId, res);
		if (!guildHolder) return;

		const submission = await guildHolder.getSubmissionsManager().getSubmission(submissionId);
		if (!submission) {
			this.respondError(res, 404, `Submission not found: ${submissionId}`);
			return;
		}

		const images = submission.getConfigManager().getConfig(SubmissionConfigs.IMAGES) || [];
		const image = images.find(entry => entry.id === imageId);
		if (!image) {
			this.respondError(res, 404, `Image not found: ${imageId}`);
			return;
		}

		if (image.path) {
			const filePath = this.resolveSafePath(submission.getProcessedImagesFolder(), image.path);
			if (filePath && await this.fileExists(filePath)) {
				await this.sendFile(res, filePath, this.resolveContentType(image.contentType, image.name), image.name);
				return;
			}
		}

		if (image.url) {
			this.redirect(res, image.url);
			return;
		}

		this.respondError(res, 404, `Image content not available: ${imageId}`);
	}

	private getGuildHolderOrRespond(serverId: string, res: Response): GuildHolder | null {
		const guildHolder = this.bot.guilds.get(serverId);
		if (guildHolder) {
			return guildHolder;
		}
		this.respondError(res, 404, `Server not found: ${serverId}`);
		return null;
	}

	private getParam(value: string | string[] | undefined): string {
		if (Array.isArray(value)) {
			return value[0] || "";
		}
		return value || "";
	}

	private getRequestedServerId(pathname: string): string | null {
		const match = pathname.match(/^\/server\/([^/]+)(?:\/|$)/);
		if (!match) {
			return null;
		}
		try {
			return decodeURIComponent(match[1]);
		} catch {
			return match[1];
		}
	}

	private setAuthenticatedToken(res: Response, tokenRecord: APITokenRecord): void {
		const locals = res.locals as { apiToken?: APITokenRecord };
		locals.apiToken = tokenRecord;
	}

	private getAuthenticatedToken(res: Response): APITokenRecord | null {
		const locals = res.locals as { apiToken?: APITokenRecord };
		return locals.apiToken || null;
	}

	private parseIntegerQuery(value: unknown, fallback: number, min: number, max: number): number {
		const raw = Array.isArray(value) ? value[0] : value;
		if (typeof raw !== "string") {
			return fallback;
		}
		const parsed = Number(raw);
		if (!Number.isInteger(parsed)) {
			return fallback;
		}
		if (parsed < min) {
			return min;
		}
		if (parsed > max) {
			return max;
		}
		return parsed;
	}

	private compareSnowflakeIds(left: string, right: string): number {
		try {
			const leftId = BigInt(left);
			const rightId = BigInt(right);
			if (leftId > rightId) return 1;
			if (leftId < rightId) return -1;
			return 0;
		} catch {
			return left.localeCompare(right);
		}
	}

	private toServerInfo(guildHolder: GuildHolder): APIServerInfo {
		return {
			id: guildHolder.getGuild().id,
			name: guildHolder.getGuild().name
		};
	}

	private async buildSubmissionSummary(submission: Submission): Promise<APISubmissionSummary> {
		const config = submission.getConfigManager();
		return {
			id: submission.getId(),
			name: config.getConfig(SubmissionConfigs.NAME) || "Unnamed Submission",
			status: config.getConfig(SubmissionConfigs.STATUS),
			timestamp: await this.getSubmissionTimestamps(submission),
			authors: (config.getConfig(SubmissionConfigs.AUTHORS) || []).map(author => getAuthorName(author)),
			tags: (config.getConfig(SubmissionConfigs.TAGS) || []).map(tag => tag.name)
		};
	}

	private async getSubmissionTimestamps(submission: Submission): Promise<APISubmissionTimestampInfo> {
		const config = submission.getConfigManager();
		const threadId = config.getConfig(SubmissionConfigs.SUBMISSION_THREAD_ID) || submission.getId();
		const createdMs = this.getSnowflakeTimestamp(threadId);
		const stats = await fs.stat(submission.getFolderPath()).catch(() => null);
		const updatedMs = stats ? Math.floor(stats.mtimeMs) : null;

		return {
			createdMs,
			updatedMs
		};
	}

	private getSnowflakeTimestamp(snowflake: string): number | null {
		if (!/^\d{17,20}$/.test(snowflake)) {
			return null;
		}
		try {
			return Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH);
		} catch {
			return null;
		}
	}

	private async sendFile(res: Response, filePath: string, contentType: string, fileName: string): Promise<void> {
		const stats = await fs.stat(filePath).catch(() => null);
		if (!stats || !stats.isFile()) {
			this.respondError(res, 404, "File not found");
			return;
		}

		res.status(200);
		res.setHeader("Content-Type", contentType);
		res.setHeader("Content-Length", stats.size.toString());
		res.setHeader("Content-Disposition", `inline; filename="${this.escapeHeaderValue(fileName)}"`);

		const stream = createReadStream(filePath);
		stream.once("error", (error) => {
			console.error(`Failed to stream file ${filePath}:`, error);
			if (!res.headersSent) {
				this.respondError(res, 500, "Failed to stream file");
				return;
			}
			res.destroy(error);
		});
		stream.pipe(res);
	}

	private resolveContentType(contentType: string | undefined, fileName: string): string {
		if (contentType && contentType.includes("/")) {
			return contentType;
		}

		const extension = path.extname(fileName).toLowerCase();
		if (extension === ".png") return "image/png";
		if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
		if (extension === ".gif") return "image/gif";
		if (extension === ".webp") return "image/webp";
		if (extension === ".bmp") return "image/bmp";
		if (extension === ".mp4") return "video/mp4";
		if (extension === ".mp3") return "audio/mpeg";
		if (extension === ".zip") return "application/zip";
		if (extension === ".json") return "application/json";
		if (extension === ".txt") return "text/plain; charset=utf-8";
		return "application/octet-stream";
	}

	private escapeHeaderValue(value: string): string {
		return value.replace(/[\\\"\r\n]/g, "_");
	}

	private resolveSafePath(basePath: string, relativePath: string): string | null {
		return safeResolvePathOrNull(basePath, relativePath);
	}

	private async fileExists(filePath: string): Promise<boolean> {
		try {
			await fs.access(filePath);
			return true;
		} catch {
			return false;
		}
	}

	private redirect(res: Response, location: string): void {
		res.redirect(302, location);
	}

	private respondUnauthorized(res: Response): void {
		res.setHeader("WWW-Authenticate", 'Bearer realm="storage-tech-bot-api"');
		this.respondError(res, 401, "Unauthorized");
	}

	private respondError(res: Response, statusCode: number, error: string): void {
		const payload: APIErrorResponse = {
			ok: false,
			error
		};
		this.respondJson(res, statusCode, payload);
	}

	private respondJson<TResponse extends APIJsonResponse>(res: Response, statusCode: number, payload: TResponse): void {
		res.status(statusCode).json(payload);
	}
}
