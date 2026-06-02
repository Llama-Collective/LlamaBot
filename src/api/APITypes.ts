import type { Attachment } from "../submissions/Attachment.js";
import type { Author, DiscordAuthor } from "../submissions/Author.js";
import type { Image } from "../submissions/Image.js";
import type { Revision } from "../submissions/Revision.js";
import type { SubmissionStatus } from "../submissions/SubmissionStatus.js";
import type { Tag } from "../submissions/Tag.js";

export type APIErrorResponse = {
	ok: false;
	error: string;
};

export type APIServerInfo = {
	id: string;
	name: string;
};

export type APISubmissionTimestampInfo = {
	createdMs: number | null;
	updatedMs: number | null;
};

export type APISubmissionSummary = {
	id: string;
	name: string;
	status: SubmissionStatus | string;
	timestamp: APISubmissionTimestampInfo;
	authors: string[];
	tags: string[];
};

export type APISubmissionRevision = Pick<Revision, "id" | "timestamp" | "records" | "styles">;

export type APISubmissionDetails = {
	id: string;
	name: string;
	status: SubmissionStatus | string;
	threadId: string;
	threadUrl: string;
	archiveChannelId: string | null;
	/** True when non-privileged republishing is locked. */
	isLocked: boolean;
	lockReason: string;
	onHold: boolean;
	holdReason: string;
	rejectionReason: string;
	retractionReason: string;
	tags: Tag[];
	authors: Author[];
	endorsers: DiscordAuthor[];
	images: Image[];
	attachments: Attachment[];
	revision: APISubmissionRevision | null;
	timestamp: APISubmissionTimestampInfo;
};

export type APIPagination = {
	page: number;
	pageSize: number;
	total: number;
	totalPages: number;
	hasNext: boolean;
	hasPrevious: boolean;
};

export type APIHealthResponse = {
	ok: true;
	service: "storage-tech-bot-api";
	timestamp: string;
};

export type APIServersResponse = {
	ok: true;
	servers: APIServerInfo[];
};

export type APISubmissionsResponse = {
	ok: true;
	server: APIServerInfo;
	submissions: APISubmissionSummary[];
	pagination: APIPagination;
};

export type APISubmissionResponse = {
	ok: true;
	server: APIServerInfo;
	submission: APISubmissionDetails;
};

export type APIJsonResponse = APIHealthResponse | APIServersResponse | APISubmissionsResponse | APISubmissionResponse | APIErrorResponse;
