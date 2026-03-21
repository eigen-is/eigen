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

## Future: Semantic Search

### SQLite Vector Extensions

- **sqlite-vec**: Pure C, no dependencies, works with Bun's SQLite. Stores float32/int8 vectors. Brute-force KNN
  (fine for per-user indexes < 100K rows).
- Alternative: store vectors in a separate table alongside FTS5

### Lightweight Embedding Models

| Model                 | Size   | Dimensions | Notes                       |
|-----------------------|--------|------------|-----------------------------|
| all-MiniLM-L6-v2      | ~80MB  | 384        | ONNX available, widely used |
| gte-small             | ~60MB  | 384        | Good quality/size tradeoff  |
| nomic-embed-text-v1.5 | ~260MB | 768        | Best quality, larger        |

Run via `@xenova/transformers` (transformers.js) in Bun — WASM/ONNX backend, no native dependencies.
Alternatively, `onnxruntime-node` for faster native inference.

### Hybrid Search

```
Score = alpha * FTS5_bm25_score + (1 - alpha) * cosine_similarity
```

Index embeddings on snapshot/write alongside FTS5. Query: run FTS5 first for candidate set, re-rank with vector
similarity.

### When It Makes Sense

- Large mailboxes (> 10K messages) where keyword search misses semantic matches
- Natural language queries ("meeting notes from last week about the budget")
- Not needed for v1 — FTS5 keyword search covers 90% of use cases

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
