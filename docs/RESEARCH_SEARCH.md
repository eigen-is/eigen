# Unified Search

> **TLDR**: Single search field across all apps. SQLite FTS5 per-user search index at
> `data/home/{userId}/eigen.search/search.db`. Content table + FTS5 virtual table with auto-sync triggers. Indexes mail,
> docs, chat, stickies, contacts, calendar, drive metadata. Shared data searched via existing `shared.db` and
> `shared_calendars` tables. Future: hybrid FTS5 + vector search.

## Problem Statement

- Users need one search field (Cmd+K) that returns results across Mail, Drive, Docs, Chat, Stickies, Contacts, Calendar
- Must cover owned data AND data shared with the user (via ACL or team membership)
- Must be self-hosted, no external search services

## What's Searchable

| Domain   | Storage                          | What to Index                              | Source DB/Path                               |
|----------|----------------------------------|--------------------------------------------|----------------------------------------------|
| Mail     | `mail.db` + Maildir `.eml` files | subject, fromShort, textShort              | `eigen.mail/mail.db` (emails table)          |
| Docs     | Yjs `data.db` (binary)           | Extracted plain text from Yjs doc          | `mounts/{id}/data/{pathId}` (collab DB)      |
| Chat     | SQLite `data.db` per room        | message content, authorEmail               | `mounts/{id}/data/{pathId}` (messages table) |
| Stickies | Yjs `data.db` (binary)           | Card titles, descriptions from Yjs         | `mounts/{id}/data/{pathId}` (collab DB)      |
| Slides   | Yjs `data.db` (binary)           | Slide text content from Yjs                | `mounts/{id}/data/{pathId}` (collab DB)      |
| Sheets   | Yjs `data.db` (binary)           | Cell text values from Yjs                  | `mounts/{id}/data/{pathId}` (collab DB)      |
| Contacts | `contacts.db`                    | firstName, lastName, email, company, notes | `eigen.contacts/contacts.db`                 |
| Calendar | `calendar.db`                    | title, description, location               | `eigen.calendar/calendar.db`                 |
| Drive    | `metadata.db` per mount          | file/folder name                           | `mounts/{id}/metadata.db` (paths table)      |

### Current Data Available in SQLite (no extraction needed)

- **Mail**: `emails.subject`, `emails.fromShort`, `emails.textShort`
- **Chat**: `messages.content`, `messages.authorEmail`
- **Contacts**: `contacts.firstName`, `contacts.lastName`, `contacts.data` (JSON with email, company, notes)
- **Calendar**: `events.title`, `events.description`, `events.location`
- **Drive**: `paths.name` (file/folder names)

### Requires Yjs Text Extraction

- **Docs/Stickies/Slides/Sheets**: Binary Yjs state in `doc_snapshots.stateData`. Decode Yjs doc, walk XML/Map tree,
  extract plain text. Runs on snapshot creation (every 100 updates, see `CollabDocument.DbProvider`).

## Approach: SQLite FTS5

### Why FTS5

- Already using SQLite everywhere — zero new dependencies
- FTS5 is built into Bun's SQLite (compiled with `-DSQLITE_ENABLE_FTS5`)
- Fast: sub-millisecond queries on moderate data
- Supports ranking (`bm25()`), snippet extraction, prefix queries
- Per-user isolation matches existing data layout

### Search Index Location

```
data/home/{userId}/eigen.search/
  search.db          # FTS5 search index
```

Teams: `data/team/{teamId}/eigen.search/search.db` (Drive + Calendar only, matching `TeamHome` scope).

### Schema

Uses the FTS5 **external content table** pattern: a regular `search_entries` table holds all data (domain, metadata,
etc.), while FTS5 only indexes `title` and `body`. SQLite triggers keep FTS in sync automatically.

```sql
CREATE TABLE search_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,        -- 'mail' | 'doc' | 'chat' | 'stickies' | 'contacts' | 'calendar' | 'drive'
    item_id TEXT NOT NULL,       -- domain-specific ID (email id, pathId, contact id, event id)
    mount_id TEXT,               -- NULL for non-drive domains (mail, contacts, calendar)
    title TEXT NOT NULL,         -- primary searchable text (subject, name, title)
    body TEXT NOT NULL DEFAULT '',-- secondary searchable text (email body, doc content, message)
    metadata TEXT,               -- JSON: { mailbox, mimeType, authorEmail, ... }
    updated_at INTEGER DEFAULT (unixepoch()),
    UNIQUE(domain, item_id)
);

CREATE VIRTUAL TABLE search_fts USING fts5(
    title, body,
    content='search_entries',
    content_rowid='id',
    tokenize='unicode61'
);

-- Triggers to keep FTS in sync with content table
CREATE TRIGGER search_ai AFTER INSERT ON search_entries BEGIN
    INSERT INTO search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

CREATE TRIGGER search_ad AFTER DELETE ON search_entries BEGIN
    INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
END;

CREATE TRIGGER search_au AFTER UPDATE ON search_entries BEGIN
    INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
    INSERT INTO search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
```

This avoids indexing non-searchable columns (domain, item_id, metadata) in FTS5 while keeping domain filtering via
a simple JOIN on the content table.

### Drizzle Schema

```typescript
// apps/api/src/lib/search/schema.ts
import {sql} from 'drizzle-orm';
import {integer, sqliteTable, text, uniqueIndex} from 'drizzle-orm/sqlite-core';

export const searchEntries = sqliteTable('search_entries', {
    id: integer('id').primaryKey({autoIncrement: true}),
    domain: text('domain').notNull(),
    itemId: text('item_id').notNull(),
    mountId: text('mount_id'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    metadata: text('metadata'),
    updatedAt: integer('updated_at').default(sql`(unixepoch())`),
}, (table) => ({
    domainItem: uniqueIndex('idx_domain_item').on(table.domain, table.itemId),
}));
```

### DatabaseConfig

```typescript
// apps/api/src/lib/search/db-config.ts
export const SEARCH_DB_CONFIG: DatabaseConfig<typeof schema> = {
    name: 'search',
    currentVersion: 1,
    schema,
    migrations: [{
        version: 1,
        up: (db) => db.exec(`
            CREATE TABLE IF NOT EXISTS search_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                domain TEXT NOT NULL,
                item_id TEXT NOT NULL,
                mount_id TEXT,
                title TEXT NOT NULL,
                body TEXT NOT NULL DEFAULT '',
                metadata TEXT,
                updated_at INTEGER DEFAULT (unixepoch()),
                UNIQUE(domain, item_id)
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
                title, body,
                content='search_entries', content_rowid='id',
                tokenize='unicode61'
            );
            CREATE TRIGGER IF NOT EXISTS search_ai AFTER INSERT ON search_entries BEGIN
                INSERT INTO search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
            END;
            CREATE TRIGGER IF NOT EXISTS search_ad AFTER DELETE ON search_entries BEGIN
                INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
            END;
            CREATE TRIGGER IF NOT EXISTS search_au AFTER UPDATE ON search_entries BEGIN
                INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
                INSERT INTO search_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
            END;
        `)
    }]
};
```

### SearchIndex Class

Lazy-initialized domain service on `Home`, like `Contacts`, `Calendar`, etc. Accessed via `home.searchIndex`.

```typescript
// apps/api/src/lib/search/search-index.ts
export class SearchIndex {
    private home: Home;
    private managedDb!: ManagedDatabase<typeof schema>;
    private db!: BunSQLiteDatabase<typeof schema>;

    constructor(home: Home) {
        this.home = home;
    }

    async init() {
        this.managedDb = await this.home.getLocalDatabase(SEARCH_DB_CONFIG, 'eigen.search/search.db');
        this.db = this.managedDb.db;
    }

    upsert(domain: string, itemId: string, title: string, body: string, metadata?: Record<string, unknown>, mountId?: string) {
        // INSERT OR REPLACE triggers search_ad + search_ai, keeping FTS in sync
        this.db.insert(schema.searchEntries).values({
            domain, itemId, mountId: mountId ?? null,
            title, body, metadata: metadata ? JSON.stringify(metadata) : null,
        }).onConflictDoUpdate({
            target: [schema.searchEntries.domain, schema.searchEntries.itemId],
            set: { title, body, metadata: metadata ? JSON.stringify(metadata) : null, updatedAt: sql`(unixepoch())` },
        }).run();
    }

    delete(domain: string, itemId: string) {
        this.db.delete(schema.searchEntries)
            .where(and(eq(schema.searchEntries.domain, domain), eq(schema.searchEntries.itemId, itemId)))
            .run();
    }

    deleteByMount(mountId: string) {
        this.db.delete(schema.searchEntries)
            .where(eq(schema.searchEntries.mountId, mountId))
            .run();
    }

    query(q: string, options?: { domain?: string; limit?: number; offset?: number }) {
        const limit = Math.min(options?.limit ?? 20, 100);
        const offset = options?.offset ?? 0;
        const ftsQuery = sanitizeFtsQuery(q);

        const domainFilter = options?.domain
            ? sql`AND e.domain IN (${sql.raw(options.domain.split(',').map(d => `'${d.trim()}'`).join(','))})`
            : sql``;

        const results = this.db.all(sql`
            SELECT e.domain, e.item_id, e.title,
                   snippet(search_fts, 1, '<mark>', '</mark>', '...', 30) AS snippet,
                   e.metadata, e.updated_at,
                   bm25(search_fts) AS rank
            FROM search_fts f
            JOIN search_entries e ON e.id = f.rowid
            WHERE search_fts MATCH ${ftsQuery}
            ${domainFilter}
            ORDER BY rank
            LIMIT ${limit} OFFSET ${offset}
        `);

        return results;
    }

    async destruct() {
        if (this.managedDb) await this.managedDb.close();
    }
}
```

### Indexing Strategy

Index on write — each domain hooks into its existing mutation flow. The `SearchIndex` is passed to domain classes
that call `upsert()` / `delete()` after their own DB writes.

| Domain   | Trigger                                              | What Happens                    |
|----------|------------------------------------------------------|---------------------------------|
| Mail     | `MailDB.addEmail()` / `deleteEmail()`                | Upsert/delete from search index |
| Chat     | `ChatRoom.postMessage()` / `editMessage()`           | Upsert message                  |
| Contacts | `Contacts.addContact()` / `updateContact()`          | Upsert contact fields           |
| Calendar | `Calendar.createEvent()` / `updateEvent()`           | Upsert event title/desc         |
| Drive    | `Drive.createFolder()` / `renamePath()` / `deleteFile()` | Upsert/delete file name    |
| Docs     | `DbProvider.createSnapshot()`                        | Extract Yjs text, upsert        |
| Stickies | `DbProvider.createSnapshot()`                        | Extract Yjs text, upsert        |
| Slides   | `DbProvider.createSnapshot()`                        | Extract Yjs text, upsert        |
| Sheets   | `DbProvider.createSnapshot()`                        | Extract Yjs text, upsert        |

### Yjs Text Extraction

Bun has no DOM, so `.toDOM().textContent` cannot be used. Walk the Yjs XML tree directly instead.

```typescript
// apps/api/src/lib/search/yjs-extract.ts
import * as Y from 'yjs';

function extractXmlText(element: Y.XmlElement | Y.XmlFragment): string {
    const parts: string[] = [];
    for (const child of element.toArray()) {
        if (child instanceof Y.XmlText) {
            parts.push(child.toJSON());
        } else if (child instanceof Y.XmlElement || child instanceof Y.XmlFragment) {
            parts.push(extractXmlText(child));
        }
    }
    return parts.join(' ');
}

export function extractTextFromYjs(stateData: Uint8Array, docType: string): string {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, stateData);

    switch (docType) {
        case 'doc':
            return extractXmlText(doc.getXmlFragment('default'));
        case 'stickies':
            return extractStickiesText(doc);
        case 'slides':
            return extractSlidesText(doc);
        case 'sheets':
            return extractSheetsText(doc);
        default:
            return '';
    }
}
```

Extraction runs inside `DbProvider.createSnapshot()` (every 100 Yjs updates). The `SearchIndex` reference is passed
through `CollabDocument` → `DbProvider` at construction time.

## Search API

### Endpoint

```
GET /search/:ownerId?q=<query>&domain=<domain>&limit=<n>&offset=<n>
```

- `q`: FTS5 query string (supports `"exact phrase"`, `prefix*`, `OR`, `NOT`)
- `domain`: optional filter (comma-separated: `mail,chat`)
- `limit`: default 20, max 100
- `offset`: pagination offset
- Returns results sorted by FTS5 `bm25()` rank

### Response

```typescript
// packages/lib/src/types/search.ts
type SearchResult = {
    domain: string;
    itemId: string;
    title: string;
    snippet: string;
    metadata: Record<string, unknown>;
    updatedAt: number;
};

type SearchResponse = {
    results: SearchResult[];
    total: number;
};
```

### Route

Follows existing route patterns. Uses `parseOwnerId` + access checks matching `drive` and `calendar` routes.

```typescript
// apps/api/src/routes/search.ts
import {Elysia, t} from 'elysia';
import {betterAuth} from './auth';
import {getHome} from '../lib/home';
import {requireSelf} from '../lib/core/access';
import {parseOwnerId} from '@workspace/lib/types';
import {requireTeamAccess} from '../lib/core/access';

export const searchRouter = new Elysia({name: 'search'})
    .use(betterAuth)
    .get('/search/:ownerId', async ({params, query, user}) => {
        const parsed = parseOwnerId(params.ownerId);
        if (parsed.type === 'user') requireSelf(params.ownerId, user.id);
        else if (parsed.type === 'team') await requireTeamAccess(user.id, parsed.id);

        const home = await getHome(params.ownerId);
        return home.searchIndex.query(query.q, {
            domain: query.domain,
            limit: query.limit ? Number(query.limit) : undefined,
            offset: query.offset ? Number(query.offset) : undefined,
        });
    }, {auth: true});
```

### Searching Shared Data

No cross-home DB access needed. The user's own databases already contain shared item metadata:

- **Shared Drive paths**: Query `shared.db` → `shared_paths` table (has `name`, `ownerId`, `mountId`, `mimeType`).
  Filter by name using SQL `LIKE` or index shared paths into the user's own `search.db` at share-receive time
  (in `Drive.receiveACLChange()`).
- **Shared calendars**: Query `calendar.db` → `shared_calendars` table (has `calendarName`, `ownerUserId`). Shared
  calendar events are fetched on-demand via the existing `resolveCalendarForEvents()` pattern.

For v1, shared Drive path names are searchable via the user's index (indexed on `receiveACLChange`). Shared document
*content* search is deferred to a later phase.

## Frontend

### Search UI

- **Trigger**: `Mod+K` hotkey via `@tanstack/react-hotkeys` (see `docs/HOTKEYS.md`)
- **Component**: `packages/ui/src/components/layout/app/search-dialog.tsx`
- **Pattern**: Dialog/command palette, rendered inside `EigenApp` provider stack
- **Debounce**: 200ms on input before API call
- **Display**: Results grouped by domain, each with app icon + title + snippet with `<mark>` highlights
- **Navigation**: Click result → cross-app navigation via URL helpers from `packages/lib/src/core/api.ts`
- **Hook**: `packages/lib/src/core/search/hooks/use-search.ts`

### Query Keys

```typescript
// packages/lib/src/core/search/keys.ts
export const searchKeys = {
    all: ['search'] as const,
    query: (ownerId: string, q: string, domain?: string) =>
        [...searchKeys.all, ownerId, q, domain] as const,
};
```

### Result Navigation

Each result's `metadata` JSON contains the IDs needed to construct the target URL. The helpers are path-based
(see `packages/lib/src/core/api.ts`):

| Domain   | URL Construction                                                      |
|----------|-----------------------------------------------------------------------|
| Mail     | `getMailAppUrl(`box/${metadata.mailbox}/${itemId}`)`                  |
| Drive    | `getDriveAppUrl(`fs/${ownerId}/${metadata.mountId}/${itemId}`)`       |
| Docs     | `getDocUrl(ownerId, metadata.mountId, itemId)`                        |
| Stickies | `getStickiesBoardUrl(ownerId, metadata.mountId, itemId)`              |
| Slides   | `getSlideUrl(ownerId, metadata.mountId, itemId)`                      |
| Sheets   | `getSheetUrl(ownerId, metadata.mountId, itemId)`                      |
| Chat     | `getChatRoomUrl(ownerId, metadata.mountId, itemId)`                   |
| Contacts | `getContactsAppUrl(itemId)`                                           |
| Calendar | `getCalendarAppUrl(itemId)`                                           |

## Research: Self-Hosted AI for Search (2026 Landscape)

### Do Embeddings Make Sense for Eigen?

FTS5 keyword search handles the majority of search use cases well. Embeddings add value in specific scenarios:

**Where embeddings help:**
- Semantic matching without keyword overlap ("firearm courtroom" → finds "gun trial")
- Natural language queries across domains ("meeting notes about the budget from last week")
- Cross-language retrieval (query in English, find Dutch documents)
- Finding related content (similar emails, related docs)

**Where FTS5 is sufficient:**
- Exact keyword search, subject/name lookup
- Known-item search ("find the invoice from Acme Corp")
- Small corpora (typical self-hosted deployment: < 50K indexed items per user)

**Verdict**: FTS5 is the right v1. Embeddings are a compelling v2 enhancement for users with large mailboxes
(> 10K messages), multilingual content, or natural-language search habits. The self-hosted AI ecosystem in 2026 makes
this feasible without cloud dependencies — but it adds deployment complexity that should be opt-in.

### Embedding Models (2026 State of the Art)

The embedding model landscape has matured significantly. Several models now run efficiently on CPU with minimal RAM,
making them viable for self-hosted deployments.

| Model                    | Params | Dims         | Context | RAM (q8) | License    | Notes                                             |
|--------------------------|--------|--------------|---------|----------|------------|----------------------------------------------------|
| **EmbeddingGemma-300M**  | 308M   | 768 (MRL→128)| 2K      | ~200MB   | Gemma      | Google. Best-in-class <500M on MMTEB. ONNX available. Encoder architecture (not decoder). 100+ languages. Transformers.js compatible. |
| **Qwen3-Embedding-0.6B** | 0.6B   | 1024 (MRL→32)| 32K     | ~400MB   | Apache 2.0 | Alibaba. Instruction-aware. Flexible output dims 32–1024. GGUF available. 100+ languages. Long context for chunked docs. |
| **Nomic Embed Text v2**  | 475M (305M active) | 768 (MRL→256) | 512 | ~300MB | Open source | First MoE embedding model. Strong on BEIR/MIRACL. GGUF available. 100+ languages. |
| **all-MiniLM-L6-v2**    | 22M    | 384          | 256     | ~80MB    | Apache 2.0 | Sentence-transformers classic. Tiny, fast, well-understood. Good baseline. ONNX available. |
| **snowflake-arctic-embed-s** | 33M | 384         | 512     | ~60MB    | Apache 2.0 | Strong retrieval for its size. Optimized for search. |
| **BGE-M3**               | 568M   | 1024         | 8K      | ~600MB   | MIT        | Multi-functionality (dense + sparse + multi-vector). 100+ languages. Overkill for most Eigen deployments. |

**Recommendation for Eigen**: **EmbeddingGemma-300M** offers the best balance of quality, size, and ecosystem support.
At ~200MB quantized it fits comfortably alongside the Eigen server. ONNX format works directly with Transformers.js
in the Bun process — no sidecar service needed. Falls back to **all-MiniLM-L6-v2** (~80MB) for minimal-resource
deployments.

### Small Language Models (2026 State of the Art)

Beyond embeddings, small LLMs could power features like query expansion, search result summarization, or AI-assisted
email triage. The 2026 landscape has capable models that run on CPU or a single consumer GPU.

| Model                    | Params | Context | VRAM/RAM  | License    | Notes                                             |
|--------------------------|--------|---------|-----------|------------|----------------------------------------------------|
| **Qwen3.5-0.8B**        | 0.8B   | 262K    | ~1GB q4   | Apache 2.0 | Multimodal (text+image). 200+ languages. Smallest viable instruct model. Thinking mode can be unstable. |
| **SmolLM3-3B**           | 3B     | 64K→128K| ~2GB q4   | Apache 2.0 | HuggingFace. Dual-mode reasoning (/think, /no_think). Fully open training recipe. Best transparency. |
| **Phi-4-mini (3.8B)**    | 3.8B   | 128K    | ~2.5GB q4 | MIT        | Microsoft. Strong reasoning for its size. Comparable to 7–9B models. Multilingual (20+ languages). |
| **Gemma-3n-E2B**         | ~5B (2B effective) | 32K | ~2GB | Gemma | Google. Selective parameter activation. Multimodal (text+image+audio+video). Mobile-first. |
| **Ministral-3-3B**       | 3.4B   | 256K    | ~2.5GB q4 | Apache 2.0 | Mistral. Agent-ready (function calling, JSON output). Vision encoder included. |

**For Eigen search specifically**, LLMs are not needed for v1 or v2. They become relevant if Eigen adds broader AI
features (email drafting, document summarization, meeting prep). If added, **Ollama as a sidecar** is the most
practical deployment model — users configure an Ollama endpoint, Eigen calls it via HTTP API.

### Runtime Options for Embedding Inference

Four viable paths for running embedding models in a Bun/TypeScript server:

#### 1. Transformers.js (`@huggingface/transformers`) — Recommended for Eigen

In-process ONNX inference via WASM backend. No native dependencies, no sidecar.

```typescript
import { AutoModel, AutoTokenizer } from '@huggingface/transformers';

const model = await AutoModel.from_pretrained('onnx-community/embeddinggemma-300m-ONNX', {
    dtype: 'q8',  // quantized: smaller, faster
});
const tokenizer = await AutoTokenizer.from_pretrained('onnx-community/embeddinggemma-300m-ONNX');

function embed(text: string): Promise<Float32Array> {
    const inputs = await tokenizer(text, { padding: true, truncation: true });
    const { sentence_embedding } = await model(inputs);
    return sentence_embedding.data;
}
```

- **Pros**: Zero external dependencies. Runs in the Bun process. ~50–200ms per embedding on modern CPU. Model files
  cached locally after first download (or bundled in Docker image). Supports EmbeddingGemma, all-MiniLM, and most
  ONNX models.
- **Cons**: WASM is slower than native. First load downloads model files (~200MB). Memory overhead for model in
  process. Not suitable for LLMs (too slow for generation).
- **Bun compatibility**: Transformers.js v3 officially supports Node.js server-side. Bun compatibility is functional
  with WASM backend (no WebGPU on server). May need `node_compat` flag in Bun for some ONNX runtime features.

#### 2. Ollama (sidecar service)

Separate process running llama.cpp under the hood. HTTP API for embeddings and chat.

```typescript
const response = await fetch('http://localhost:11434/api/embed', {
    method: 'POST',
    body: JSON.stringify({ model: 'nomic-embed-text', input: text }),
});
const { embeddings } = await response.json();
```

- **Pros**: Mature, well-tested. Supports both embedding and LLM models. GPU acceleration. Easy model management
  (`ollama pull nomic-embed-text`). Already common in self-hosted setups.
- **Cons**: Requires separate process/container. Network hop latency (~5–20ms overhead). Another moving part in
  deployment. Users must install and configure Ollama.
- **Best for**: Deployments that already run Ollama, or when LLM features are also needed.

#### 3. sqlite-lembed + sqlite-vec (SQL-native)

SQLite extensions that generate embeddings and store/query vectors directly in SQL. Powered by llama.cpp.

```sql
-- Load extensions
.load ./lembed0
.load ./vec0

-- Register model
INSERT INTO temp.lembed_models(name, model)
    SELECT 'embed', lembed_model_from_file('embeddinggemma-300m.q8_0.gguf');

-- Generate embedding + store in vector table
INSERT INTO search_vectors(rowid, embedding)
    SELECT id, lembed('embed', title || ' ' || body)
    FROM search_entries;

-- KNN query
SELECT rowid, distance
FROM search_vectors
WHERE embedding MATCH lembed('embed', 'firearm courtroom')
ORDER BY distance LIMIT 10;
```

- **Pros**: Elegant — embedding + vector search in pure SQL. No HTTP calls. Fast (llama.cpp native). Pairs perfectly
  with sqlite-vec. GGUF models from Ollama/HuggingFace work directly.
- **Cons**: Native SQLite extensions need to be compiled per platform. May conflict with Bun's built-in SQLite (Bun
  uses its own SQLite build). Docker image must include the `.so`/`.dylib` files. Pre-v1 maturity for sqlite-lembed.
- **Best for**: If the native extension compatibility with Bun's SQLite can be confirmed.

#### 4. llama.cpp server (standalone)

Dedicated C++ inference server with OpenAI-compatible API, including `/v1/embeddings` endpoint.

- **Pros**: Maximum performance. GPU support. Can serve both embeddings and chat completions.
- **Cons**: Another binary to deploy. More operational complexity than Ollama.
- **Best for**: High-throughput or GPU-accelerated deployments.

### Recommended Approach for Eigen

**Embedding inference**: Use **Transformers.js** with **EmbeddingGemma-300M** (ONNX, q8) for zero-dependency
in-process embedding. This keeps deployment simple — no sidecar, no native extensions. The model file (~200MB) ships
in the Docker image or is downloaded on first use.

**Vector storage**: Use **sqlite-vec** (`npm install sqlite-vec`) for KNN search. Pure C extension with npm package,
loads via `Database.loadExtension()`. Store vectors in a `vec0` virtual table alongside the existing `search_entries`
content table.

**Configuration**: Make embedding optional and configurable. Users can:
- Disable it entirely (FTS5-only, default)
- Use built-in Transformers.js (opt-in, downloads model on first use)
- Point to an Ollama endpoint (for users who already run Ollama)

### Vector Storage Schema

Extends the existing `search.db` with a `vec0` virtual table:

```sql
-- Requires sqlite-vec extension loaded
CREATE VIRTUAL TABLE IF NOT EXISTS search_vectors USING vec0(
    embedding float[768]  -- EmbeddingGemma-300M output dims (or 384 for MiniLM)
);
```

The `search_vectors` rowid maps 1:1 to `search_entries.id`. Insert embeddings alongside FTS content:

```typescript
// In SearchIndex.upsert(), after writing to search_entries:
if (this.embeddingEnabled) {
    const vector = await this.embedder.embed(title + ' ' + body);
    this.db.run(sql`INSERT OR REPLACE INTO search_vectors(rowid, embedding) VALUES (${entryId}, ${vector})`);
}
```

### Hybrid Search Query

When embeddings are available, combine FTS5 keyword scores with vector similarity:

```sql
-- Step 1: FTS5 candidate retrieval (fast, narrows to ~100 candidates)
WITH fts_matches AS (
    SELECT e.id, e.domain, e.item_id, e.title, e.metadata, e.updated_at,
           bm25(search_fts) AS fts_rank,
           snippet(search_fts, 1, '<mark>', '</mark>', '...', 30) AS snippet
    FROM search_fts f
    JOIN search_entries e ON e.id = f.rowid
    WHERE search_fts MATCH ?
    LIMIT 100
)
-- Step 2: Re-rank with vector similarity
SELECT m.*, v.distance AS vec_distance,
       (m.fts_rank * 0.7 + v.distance * 0.3) AS hybrid_rank
FROM fts_matches m
LEFT JOIN search_vectors v ON v.rowid = m.id
WHERE v.embedding MATCH ? -- query embedding
ORDER BY hybrid_rank
LIMIT 20;
```

FTS5 acts as a fast first-pass filter. Vector similarity re-ranks the candidates. The `alpha` weighting (0.7/0.3)
can be tuned. When embeddings are disabled, the query falls back to pure FTS5 ranking.

### Use Cases Beyond Search

If Eigen adds LLM support (via Ollama sidecar), several features become possible:

| Feature              | Model needed        | Description                                                    |
|----------------------|---------------------|----------------------------------------------------------------|
| Query expansion      | Small LLM (0.8–3B) | Rewrite "budget meeting" → "financial planning discussion meeting notes quarterly review" for better FTS5 recall |
| Result summarization | Small LLM (0.8–3B) | Summarize top-N search results into a concise answer           |
| Email triage         | Small LLM (3B+)    | Auto-categorize incoming mail (urgent, newsletter, receipt)    |
| Document Q&A         | Small LLM (3B+)    | RAG: retrieve relevant chunks, answer questions about own docs |
| Smart compose        | Small LLM (3B+)    | Draft email replies based on conversation context              |

These are future features beyond search. They all benefit from the same Ollama sidecar architecture — Eigen
communicates via HTTP, the user chooses which model to run. No Eigen code changes needed when better models release.

### What Not to Do

- **Don't bundle an LLM in the Docker image** — too large (2–8GB), not everyone wants it
- **Don't make embeddings mandatory** — FTS5 must work standalone, embeddings are an enhancement
- **Don't run LLM inference in the Bun process** — too slow via WASM, blocks the event loop. Ollama sidecar only
- **Don't build a custom embedding pipeline** — use Transformers.js or Ollama, both are battle-tested
- **Don't store vectors in a separate database** — keep them in `search.db` alongside FTS5 for atomic operations

## Implementation Plan

| Phase | Scope                                                                                                           | Effort |
|-------|-----------------------------------------------------------------------------------------------------------------|--------|
| 1     | `search.db` schema + `SearchIndex` class + wire into `Home` (lazy init) + indexing hooks for mail, contacts, calendar, drive | M |
| 2     | Chat message indexing (requires opening per-room DBs)                                                           | S      |
| 3     | Yjs text extraction for docs, stickies, slides, sheets (hook into `DbProvider.createSnapshot`)                  | M      |
| 4     | Search API endpoint (`apps/api/src/routes/search.ts`)                                                           | S      |
| 5     | Frontend Cmd+K dialog + `useSearch` hook + result navigation                                                    | M      |
| 6     | Shared data: index shared paths on `receiveACLChange`, search `shared_calendars`                                | S      |
| 7     | Full re-index command (backfill existing data by walking all domain DBs)                                        | S      |
| 8     | Semantic/vector search (future)                                                                                 | L      |

### File Structure

```
apps/api/src/lib/search/
  schema.ts           # Drizzle schema (search_entries table)
  db-config.ts        # SEARCH_DB_CONFIG with FTS5 + triggers migration
  search-index.ts     # SearchIndex class (upsert, delete, query)
  yjs-extract.ts      # Yjs text extraction helpers (server-safe, no DOM)

apps/api/src/routes/search.ts   # Search endpoint

packages/lib/src/types/search.ts              # SearchResult, SearchResponse types
packages/lib/src/core/search/keys.ts          # Query key factory
packages/lib/src/core/search/hooks/           # useSearch hook
packages/ui/src/components/layout/app/search-dialog.tsx  # Cmd+K UI
```

### Key Decisions

- **Per-user index** (not global) — matches existing data isolation model, avoids ACL filtering at query time for
  owned data
- **Content table + FTS5** (not bare FTS5) — domain, item_id, metadata stay in a regular table; only title/body are
  full-text indexed. Triggers keep FTS in sync. Enables efficient domain filtering via JOIN
- **Index on write** (not batch) — keeps index current, leverages existing mutation flow
- **Yjs extraction on snapshot** (every ~100 updates) — acceptable staleness, avoids per-keystroke overhead
- **No cross-home search for v1** — shared data searched via user's own `shared.db` and `shared_calendars`, not by
  opening remote search indexes. Simpler and avoids concurrent DB access issues
- **FTS5 first, vectors later** — FTS5 is sufficient for v1, semantic search adds complexity with diminishing returns
  for typical self-hosted deployments
