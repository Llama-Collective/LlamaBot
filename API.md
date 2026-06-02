# Storage Tech Bot API

Base URL (production):

`https://botapi.llamamc.org`

All endpoints require bearer auth.

## Authentication

Send this header on every request:

`Authorization: Bearer <token>`

Token creation and management is done in Discord with `/token`:

- `/token get [label]` creates a server-scoped token (current server)
- `/token get [label] global:true` creates a global token (SysAdmin only)
- `/token list` lists tokens:
  - SysAdmin sees all tokens
  - server admins see tokens scoped to their current server
- `/token revoke tokenid` revokes tokens:
  - SysAdmin can revoke any token
  - server admins can revoke tokens scoped to their current server
- `/token delete tokenid` deletes tokens:
  - SysAdmin can delete any token
  - server admins can delete tokens scoped to their current server

Token list output includes usage tracking (`uses`) and `last_used`.

If auth is missing/invalid/revoked, API returns `401`:

```json
{
  "ok": false,
  "error": "Unauthorized"
}
```

If a token is valid but not allowed for the requested server, API returns `403`:

```json
{
  "ok": false,
  "error": "Forbidden for this server"
}
```

## Type Reference

```ts
type APIErrorResponse = {
  ok: false;
  error: string;
};

type APIServerInfo = {
  id: string;
  name: string;
};

type APISubmissionTimestampInfo = {
  createdMs: number | null; // unix ms
  updatedMs: number | null; // unix ms
};

type APISubmissionSummary = {
  id: string;
  name: string;
  status: string;
  timestamp: APISubmissionTimestampInfo;
  authors: string[];
  tags: string[];
};

type APIPagination = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
};

type APIHealthResponse = {
  ok: true;
  service: "storage-tech-bot-api";
  timestamp: string;
};

type APIServersResponse = {
  ok: true;
  servers: APIServerInfo[];
};

type APISubmissionsResponse = {
  ok: true;
  server: APIServerInfo;
  submissions: APISubmissionSummary[];
  pagination: APIPagination;
};

type APISubmissionRevision = {
  id: string;
  timestamp: number;
  records: Record<string, unknown>;
  styles: Record<string, unknown>;
};

type APISubmissionDetails = {
  id: string;
  name: string;
  status: string;
  threadId: string;
  threadUrl: string;
  archiveChannelId: string | null;
  isLocked: boolean; // true when non-privileged republishing is locked
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

type APISubmissionResponse = {
  ok: true;
  server: APIServerInfo;
  submission: APISubmissionDetails;
};
```

Notes:

- `createdMs` and `updatedMs` are numeric timestamps only (milliseconds since epoch).
- `isLocked` indicates the submission is locked against republishing; it does not mean edits are blocked.
- In summary results, `authors` and `tags` are string arrays.
- In full submission results, `authors`, `tags`, `endorsers`, `images`, and `attachments` are full stored objects.
- `Tag`, `Author`, `DiscordAuthor`, `Image`, and `Attachment` use the same serialized structures as in the archive.

## Endpoints

### GET `/healthz`
Also available as `/health` and `/ping`.

Response:

```json
{
  "ok": true,
  "service": "storage-tech-bot-api",
  "timestamp": "2026-02-11T00:00:00.000Z"
}
```

### GET `/servers`

Returns guilds currently loaded by the bot.

Scope behavior:

- Global token: returns all loaded servers.
- Server-scoped token: returns only its scoped server (if loaded).

Response:

```json
{
  "ok": true,
  "servers": [
    {
      "id": "123456789012345678",
      "name": "Example Server"
    }
  ]
}
```

### GET `/server/:serverId/submissions`

Returns paginated submissions for a server.

Scope behavior:

- Returns `403` when a server-scoped token targets a different server.

Query params:

- `page` integer, default `1`, min `1`
- `pageSize` integer, default `50`, min `1`, max `200`

Sort order:

- Sorted by submission snowflake ID descending (newest first)

Response:

```json
{
  "ok": true,
  "server": {
    "id": "123456789012345678",
    "name": "Example Server"
  },
  "submissions": [
    {
      "id": "234567890123456789",
      "name": "My submission",
      "status": "waiting",
      "timestamp": {
        "createdMs": 1739330000000,
        "updatedMs": 1739400000000
      },
      "authors": ["AuthorA", "AuthorB"],
      "tags": ["Tree", "Decorative"]
    }
  ],
  "pagination": {
    "page": 1,
    "pageSize": 50,
    "total": 123,
    "totalPages": 3,
    "hasNext": true,
    "hasPrevious": false
  }
}
```

### GET `/server/:serverId/submission/:submissionId`

Returns full details for one submission.

Scope behavior:

- Returns `403` when a server-scoped token targets a different server.

Response:

```json
{
  "ok": true,
  "server": {
    "id": "123456789012345678",
    "name": "Example Server"
  },
  "submission": {
    "id": "234567890123456789",
    "name": "My submission",
    "status": "waiting",
    "threadId": "234567890123456789",
    "threadUrl": "https://discord.com/channels/...",
    "archiveChannelId": "345678901234567890",
    "isLocked": false,
    "lockReason": "",
    "onHold": false,
    "holdReason": "",
    "rejectionReason": "",
    "retractionReason": "",
    "tags": [],
    "authors": [],
    "endorsers": [],
    "images": [],
    "attachments": [],
    "revision": null,
    "timestamp": {
      "createdMs": 1739330000000,
      "updatedMs": 1739400000000
    }
  }
}
```

### GET `/server/:serverId/submission/:submissionId/attachments/:attachmentId`

Returns attachment content.

Behavior:

- If file is locally available, streams the file (`200`)
- Otherwise, redirects (`302`) to upstream URL when available
- Returns `404` if attachment or content is unavailable
- Returns `403` when a server-scoped token targets a different server

### GET `/server/:serverId/submission/:submissionId/images/:imageId`

Returns image content.

Behavior:

- If file is locally available, streams the file (`200`)
- Otherwise, redirects (`302`) to upstream URL when available
- Returns `404` if image or content is unavailable
- Returns `403` when a server-scoped token targets a different server

## Common error responses

`404`:

```json
{
  "ok": false,
  "error": "Not Found"
}
```

`403`:

```json
{
  "ok": false,
  "error": "Forbidden for this server"
}
```

Server-specific missing resource examples:

- `Server not found: <id>`
- `Submission not found: <id>`
- `Attachment not found: <id>`
- `Image not found: <id>`

`500`:

```json
{
  "ok": false,
  "error": "Internal Server Error"
}
```

## Curl examples

```bash
TOKEN='paste_token_here'
BASE='https://botapi.llamamc.org'

# health
curl -i -H "Authorization: Bearer $TOKEN" "$BASE/healthz"

# servers
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/servers" | jq

# submissions page 1
SERVER_ID='123456789012345678'
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/server/$SERVER_ID/submissions?page=1&pageSize=25" | jq

# one submission
SUBMISSION_ID='234567890123456789'
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/server/$SERVER_ID/submission/$SUBMISSION_ID" | jq

# attachment download
ATTACHMENT_ID='345678901234567890'
curl -L -H "Authorization: Bearer $TOKEN" \
  "$BASE/server/$SERVER_ID/submission/$SUBMISSION_ID/attachments/$ATTACHMENT_ID" \
  -o attachment.bin

# image download
IMAGE_ID='456789012345678901'
curl -L -H "Authorization: Bearer $TOKEN" \
  "$BASE/server/$SERVER_ID/submission/$SUBMISSION_ID/images/$IMAGE_ID" \
  -o image.bin
```
