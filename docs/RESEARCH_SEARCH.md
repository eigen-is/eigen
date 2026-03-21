# Unified Search

> **TLDR**: Single search field across all apps. SQLite FTS5 per-user search index at
> `data/home/{userId}/eigen.search/search.db`. Indexes mail, docs, chat, stickies, contacts, calendar, drive metadata.
> Shared data searched via ACL-aware cross-home queries. Future: hybrid FTS5 + vector search.

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

- **Mail**: `emails.subject`, `emails.fromShort`, `emails.textShort` -- already stored as text columns
- **Chat**: `messages.content`, `messages.authorEmail` -- plain text in SQLite
- **Contacts**: `contacts.firstName`, `contacts.lastName`, `contacts.data` (JSON with email, company, notes)
- **Calendar**: `events.title`, `events.description`, `events.location`
- **Drive**: `paths.name` (file/folder names)

### Requires Yjs Text Extraction

- **Docs/Stickies/Slides/Sheets**: Binary Yjs state in `doc_snapshots.stateData`. Must decode Yjs doc, extract text
  nodes, index as plain text. Extract on snapshot creation (every 100 updates, see `CollabDocument.DbProvider`).

## Approach: SQLite FTS5

### Why FTS5

- Already using SQLite everywhere -- zero new dependencies
- FTS5 is built into Bun's SQLite (compiled with `-DSQLITE_ENABLE_FTS5`)
- Fast: sub-millisecond queries on moderate data
- Self-hosted, no external service
- Supports ranking (`bm25()`), snippet extraction, prefix queries
- Per-user isolation matches existing data layout

### Search Index Location

```
data/home/{userId}/eigen.search/
  search.db          # FTS5 search index
```

Teams: `data/team/{teamId}/eigen.search/search.db` (Drive + Calendar only, matching `TeamHome` scope).

### Schema

```sql
-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE search_index USING fts5(
    domain,           -- 'mail' | 'doc' | 'chat' | 'stickies' | 'contacts' | 'calendar' | 'drive'
    item_id,          -- domain-specific ID (email id, pathId, contact id, event id)
    title,            -- primary searchable text (subject, name, title)
    body,             -- secondary searchable text (email body, doc content, message)
    metadata UNINDEXED, -- JSON: { mountId, mailbox, mimeType, authorEmail, ... }
    updated_at UNINDEXED,
    tokenize='unicode61'
);

-- Mapping table for deduplication and deletion
CREATE TABLE search_entries (
    domain TEXT NOT NULL,
    item_id TEXT NOT NULL,
    mount_id TEXT,        -- NULL for non-drive domains
    PRIMARY KEY (domain, item_id)
);
```

Single FTS5 table with domain column. Filter by domain at query time:
`WHERE domain MATCH 'mail' AND search_index MATCH ?`.

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
            CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
                domain, item_id, title, body,
                metadata UNINDEXED, updated_at UNINDEXED,
                tokenize='unicode61'
            );
            CREATE TABLE IF NOT EXISTS search_entries (
                domain TEXT NOT NULL, item_id TEXT NOT NULL,
                mount_id TEXT,
                PRIMARY KEY (domain, item_id)
            );
        `)
    }]
};
```

### Indexing Strategy

Index on write -- each domain hooks into its existing mutation/SSE flow:

| Domain   | Trigger                                                | What Happens                    |
|----------|--------------------------------------------------------|---------------------------------|
| Mail     | `MailDB.addEmail()` / `deleteEmail()`                  | Upsert/delete from search index |
| Chat     | `ChatRoom.postMessage()` / `editMessage()`             | Upsert message                  |
| Contacts | `Contacts.createContact()` / `updateContact()`         | Upsert contact fields           |
| Calendar | `Calendar.createEvent()` / `updateEvent()`             | Upsert event title/desc         |
| Drive    | `Drive.createPath()` / `renamePath()` / `deletePath()` | Upsert/delete file name         |
| Docs     | `CollabDocument.DbProvider.createSnapshot()`           | Extract Yjs text, upsert        |
| Stickies | Same as Docs                                           | Extract Yjs text, upsert        |

### Yjs Text Extraction

```typescript
import * as Y from 'yjs';

function extractTextFromYjs(stateData: Uint8Array, docType: string): string {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, stateData);

    switch (docType) {
        case 'doc':
            // Tiptap stores content in Y.XmlFragment('default')
            return doc.getXmlFragment('default').toDOM().textContent ?? '';
        case 'stickies':
            // Cards stored in Y.Map -- iterate and extract text fields
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

Run extraction in `DbProvider.createSnapshot()` -- happens every 100 Yjs updates, so indexing stays reasonably current
without per-keystroke overhead.

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
type SearchResult = {
    domain: string;
    itemId: string;
    title: string;
    snippet: string;    // FTS5 snippet() with highlight markers
    metadata: Record<string, unknown>;
    updatedAt: number;
};

type SearchResponse = {
    results: SearchResult[];
    total: number;
    grouped: Record<string, SearchResult[]>; // grouped by domain
};
```

### Query Implementation

```sql
SELECT domain, item_id, title,
       snippet(search_index, 3, '<mark>', '</mark>', '...', 30) AS snippet,
       metadata, updated_at,
       bm25(search_index) AS rank
FROM search_index
WHERE search_index MATCH ?
ORDER BY rank
LIMIT ? OFFSET ?
```

### Route File

```typescript
// apps/api/src/routes/search.ts
export const searchRouter = new Elysia({ name: 'search' })
    .use(betterAuth)
    .get('/search/:ownerId', async ({ params, query, user }) => {
        requireSelfOrTeamMember(params.ownerId, user);
        const home = await getHome(params.ownerId);
        return home.search(query.q, {
            domain: query.domain,
            limit: query.limit,
            offset: query.offset,
        });
    }, { auth: true });
```

### Searching Shared Data

User searches their own index first. For shared items:

1. Query `shared.db` (`shared_paths` table) to get list of `ownerId`s who shared with this user
2. Query team memberships to get `team_{teamId}` owner IDs
3. For each remote ownerId, search their `search.db` with domain filter limited to `drive` (shared items are Drive
   paths)
4. Merge results by rank, deduplicate

Shared calendar events: query `shared_calendars` table for `ownerUserId`s, search their calendar domain.

This is O(number of unique sharers), but sharers are typically few. Cache the list of sharing owners.

## Frontend

### Search UI

- **Trigger**: Cmd+K / Ctrl+K hotkey, search icon in Topbar
- **Component**: `packages/ui/src/components/layout/app/search-dialog.tsx`
- **Pattern**: Dialog/command palette (similar to VS Code / Spotlight)
- **Debounce**: 200ms on input before API call
- **Display**: Results grouped by domain, each with icon + title + snippet
- **Navigation**: Click result -> navigate to item in correct app via app URL helpers (`getMailAppUrl`,
  `getDriveAppUrl`, etc.)
- **Hook**: `packages/lib/src/core/search/hooks/use-search.ts` with TanStack Query

### Query Keys

```typescript
export const searchKeys = {
    all: ['search'] as const,
    query: (q: string, domain?: string) => [...searchKeys.all, q, domain] as const,
};
```

### Result Navigation

| Domain   | Navigate To                                   |
|----------|-----------------------------------------------|
| Mail     | `getMailAppUrl(ownerId, mailbox, messageId)`  |
| Drive    | `getDriveAppUrl(ownerId, mountId, pathId)`    |
| Docs     | `getDocsAppUrl(ownerId, mountId, pathId)`     |
| Stickies | `getStickiesAppUrl(ownerId, mountId, pathId)` |
| Slides   | `getSlidesAppUrl(ownerId, mountId, pathId)`   |
| Sheets   | `getSheetsAppUrl(ownerId, mountId, pathId)`   |
| Chat     | `getChatAppUrl(ownerId, mountId, pathId)`     |
| Contacts | `getContactsAppUrl(ownerId, contactId)`       |
| Calendar | `getCalendarAppUrl(ownerId, eventId)`         |

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

Run via `@xenova/transformers` (transformers.js) in Bun -- WASM/ONNX backend, no native dependencies.
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
- Not needed for v1 -- FTS5 keyword search covers 90% of use cases

## Implementation Plan

| Phase | Scope                                                                                               | Effort |
|-------|-----------------------------------------------------------------------------------------------------|--------|
| 1     | `search.db` schema + `SearchIndex` class + indexing hooks for mail, chat, contacts, calendar, drive | M      |
| 2     | Yjs text extraction for docs, stickies, slides, sheets                                              | S      |
| 3     | Search API endpoint + frontend Cmd+K dialog                                                         | M      |
| 4     | Shared data search (cross-home queries via ACL)                                                     | M      |
| 5     | Full re-index command (backfill existing data)                                                      | S      |
| 6     | Semantic/vector search (future)                                                                     | L      |

### File Structure

```
apps/api/src/lib/search/
  schema.ts           # Drizzle schema (search_entries table)
  db-config.ts        # SEARCH_DB_CONFIG with FTS5 migration
  search-index.ts     # SearchIndex class (upsert, delete, query)
  yjs-extract.ts      # Yjs text extraction helpers
  sse-events.ts       # SSE events for search index updates (optional)

apps/api/src/routes/search.ts   # Search endpoint

packages/lib/src/types/search.ts           # SearchResult, SearchResponse types
packages/lib/src/core/search/hooks/        # useSearch hook
packages/ui/src/components/layout/app/search-dialog.tsx  # Cmd+K UI
```

### Key Decisions

- **Per-user index** (not global) -- matches existing data isolation model, avoids ACL filtering at query time for
  owned data
- **Single FTS5 table** (not per-domain) -- simpler schema, single query with optional domain filter
- **Index on write** (not batch) -- keeps index current, leverages existing mutation flow
- **Yjs extraction on snapshot** (every ~100 updates) -- acceptable staleness, avoids per-keystroke overhead
- **FTS5 first, vectors later** -- FTS5 is sufficient for v1, semantic search adds complexity with diminishing returns
  for typical self-hosted deployments
