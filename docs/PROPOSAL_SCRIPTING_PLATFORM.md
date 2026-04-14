# Eigen Scripting Platform

A server-side scripting and extension system for eigen, enabling external developers to write scripts that organizations, teams, or individual users can install to extend functionality. Inspired by Google Apps Script.

## Core Decisions

- **Runtime**: Server-side V8 isolates via `isolated-vm`, with a thin client layer for UI extensions (phase 2)
- **Sandboxing**: V8 isolates with strict memory/CPU limits, no filesystem or network access except through SDK
- **API access**: Graduated/modular — scripts declare permissions in a manifest, users approve at install time
- **Triggers**: Manual, cron-based, and event-driven (leveraging existing `SSEventType` system)
- **Distribution**: Personal, team, and org scoping — no public marketplace for now
- **Architecture**: Standalone service (not Drive-based) — scripts own their full lifecycle

## Data Model

Per-user database at `eigen.scripts/scripts.db`, managed via `ManagedDatabase` with versioned migrations.

### `scripts`

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | nanoid |
| name | text | Display name |
| description | text | Optional |
| source | text | JS/TS source code |
| manifest | text (JSON) | Declared permissions array |
| extensions | text (JSON) | UI extensions for host apps (phase 2), nullable |
| scope | text | `personal`, `team`, `org` |
| scopeTargetId | text | null for personal, teamId or orgId for shared |
| authorId | text | User who created the script |
| version | integer | Incremented on each save |
| enabled | integer | 1 = active, 0 = disabled |
| createdAt | integer | Epoch ms |
| updatedAt | integer | Epoch ms |

### `triggers`

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | nanoid |
| scriptId | text FK | References scripts.id |
| type | text | `manual`, `cron`, `event` |
| config | text (JSON) | Cron: `{ cron: "0 9 * * *" }`, Event: `{ event: "MAIL_RECEIVED", filter: {...} }` |
| enabled | integer | |
| lastRunAt | integer | Epoch ms, nullable |

### `executions`

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | nanoid |
| scriptId | text FK | |
| triggerId | text FK | Nullable (null for manual runs) |
| status | text | `running`, `completed`, `failed`, `timeout` |
| startedAt | integer | Epoch ms |
| finishedAt | integer | Epoch ms, nullable |
| durationMs | integer | Nullable |
| log | text | Captured console output |
| error | text | Error message if failed, nullable |
| executedBy | text | userId who triggered the run |

### `installations`

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | nanoid |
| scriptId | text FK | |
| userId | text | User who installed/approved |
| grantedPermissions | text (JSON) | Permissions the user approved |
| installedAt | integer | Epoch ms |

Personal scripts don't need installation records — the author has implicit access. Team/org scripts require an installation per user who has approved the permissions.

## Execution Environment

### V8 Isolates

Scripts execute in `isolated-vm` isolates. The SDK is injected as a global `eigen` object — scripts never import modules directly.

**Constraints:**
- Memory: 128MB per isolate
- CPU time: 30s wall clock (configurable per org)
- No filesystem access — only eigen data through SDK
- No native modules — pure JS only
- Network: only `eigen.fetch()`, no raw sockets

**Lifecycle:**
1. Execution request arrives (manual, cron tick, or event trigger)
2. Scripts service creates an `Isolate` with memory limit
3. SDK bindings injected as host functions — each SDK call crosses the isolate boundary back into eigen's API layer, running with the executing user's permissions
4. Script source compiled and executed
5. Console output captured, execution record written
6. Isolate disposed

SDK calls are synchronous from the script's perspective but async internally — `isolated-vm` supports this via `Reference.applySync()`.

### SDK Surface (Phase 1)

```typescript
// Sheets
eigen.sheets.get(mountId, range)         // Read cells
eigen.sheets.set(mountId, range, values) // Write cells
eigen.sheets.getAll(mountId)             // Read entire sheet

// Drive
eigen.drive.list(mountId, pathId?)       // List files/folders
eigen.drive.read(mountId, pathId)        // Read file content
eigen.drive.write(mountId, pathId, data) // Write file content
eigen.drive.create(mountId, name, opts)  // Create file/folder

// HTTP
eigen.fetch(url, options)               // Outbound HTTP

// Logging
eigen.log(message)                       // Captured in execution log
eigen.error(message)                     // Captured, marks warnings

// Context
eigen.trigger                            // { type, event?, params? }
eigen.user                               // { id, name, email }
```

### Permission Tokens (Phase 1)

```
sheets:read | sheets:write
drive:read  | drive:write
fetch
mail:read   | mail:send
calendar:read | calendar:write
chat:read   | chat:send
contacts:read | contacts:write
```

Enforced at SDK call time — if a script calls `eigen.sheets.get()` without `sheets:read` in its approved manifest, it throws.

## Triggers

### Manual

- User clicks "Run" in the Scripts UI
- Scripts can export named functions: `export function generateReport() { ... }` appears as a separate action
- Default entry point: `export function onRun() { ... }`

### Cron

- Standard cron syntax: `"0 9 * * MON-FRI"`
- In-process scheduler — loads all enabled cron triggers on startup, checks due jobs every 60s
- No external dependency (no Redis, no cron daemon) — matches eigen's single-process SQLite philosophy
- Missed runs (server down) are skipped, not queued

### Event-Driven

- Subscribe to existing `SSEventType` events: `MAIL_RECEIVED`, `DRIVE_FILE_UPLOADED`, `CHAT_MESSAGE_POSTED`, etc.
- Optional filter: `{ event: "MAIL_RECEIVED", filter: { from: "*@github.com" } }`
- Scripts service registers a listener on `Home.broadcast()` — on event, checks enabled triggers for matches and queues executions
- Asynchronous — original action (mail delivery, file upload) is never blocked by script execution
- Deduplication: if a script is already running for the same trigger+event, the new execution is skipped

### Execution Queue

- In-memory queue with concurrency limit (5 concurrent isolates per user)
- Queue full: executions wait, none are dropped
- Server restart: running executions marked `failed` with "server restart" error

## Permissions & Scoping

### Scope & Visibility

| Scope | Created by | Visible to | Install required? |
|-------|-----------|------------|-------------------|
| personal | Any user | Author only | No |
| team | Team member | Team members | Yes |
| org | Org admin | Org members | Yes |

### Execution Identity

Scripts execute **as the user who triggered them**, not the author:
- Personal cron trigger → runs as author
- Team script triggered by User B → runs as User B, accessing User B's data
- Event trigger → runs as the user whose event fired

No privilege escalation — SDK calls go through the same permission checks as regular API calls.

### Admin Controls

- Org admins can disable scripting for the org
- Org admins can view all scripts in their org
- Org admins can kill running executions and disable scripts

## Home-Relay Integration

The scripts system must respect the sharding seam in `home-relay.ts`. All cross-user script communication flows through the relay:

### New HomeMessage type

```typescript
| { type: 'scripts:execute'; scriptId: string; triggerId: string; context?: ScriptContext }
```

### Event trigger routing

When a user's Home broadcasts an event (e.g. `MAIL_RECEIVED`), the Scripts service checks for matching triggers. If a team/org script needs to execute in another user's Home context, it sends a `scripts:execute` message via `sendToHome()` rather than directly accessing the target Home.

### SDK data access

When a script accesses shared data (e.g. a team mount), the SDK implementation uses the existing `pull*()` pattern from home-relay for reads and `sendToHome()` for writes, keeping all cross-Home access shard-compatible.

## Frontend — Scripts App

New `apps/scripts/` app following standard eigen app patterns.

### Script Editor

- Code editor panel (CodeMirror or Monaco) with syntax highlighting
- Sidebar: name, description, manifest (permission checkboxes), scope selector
- "Run" button with inline output below editor
- Trigger management: add/remove cron or event triggers

### Script List (Dashboard)

- Table: name, scope, trigger count, last run status, enabled toggle
- "New Script" button
- Filter by scope

### Execution Log

- Per-script history table: status, trigger type, duration, timestamp
- Expandable rows: full console log, error details
- "Run Now" button

## Phase 2: App Extensions

Scripts can declare UI extensions that appear in host apps (Docs, Sheets, Mail, etc.).

### Extension Declaration

In the script's `extensions` field:

```typescript
type ScriptExtension = {
  app: "docs" | "sheets" | "mail" | "chat" | "drive" | "calendar";
  type: "toolbar-action";      // phase 2
  // type: "sidebar-panel";    // future
  label: string;
  icon: string;                // lucide icon name
  function: string;            // exported function name
};
```

### API

- `GET /scripts/:ownerId/extensions/:app` — returns extensions from installed+enabled scripts for a given app

### Shared Hook

```typescript
// In @workspace/lib
useScriptExtensions(app: "docs" | "sheets" | ...)
// Returns: { extensions, executeExtension(scriptId, fn, context) }
```

### Context Contracts Per App

| App | Input context | Result actions |
|-----|--------------|----------------|
| Docs | `selection`, `documentId`, `mountId` | `replaceSelection`, `insertText`, `notify` |
| Sheets | `activeCell`, `selectedRange`, `values`, `mountId` | `setCells`, `notify` |
| Mail | `messageId`, `subject`, `body`, `from` | `draft`, `label`, `notify` |
| Chat | `roomId`, `messageText` | `sendMessage`, `notify` |
| Drive | `selectedFiles`, `mountId` | `notify` |
| Calendar | `eventId`, `event` | `updateEvent`, `notify` |

Host apps render extension buttons in their toolbar. On click, they call `executeExtension()` with app-specific context. The script runs server-side and returns a result action that the host app applies.

## Backend Structure

Following eigen conventions:

```
apps/api/src/lib/scripts/
  scripts.ts          # Scripts domain service class
  db-config.ts        # Schema + migrations
  executor.ts         # V8 isolate management
  scheduler.ts        # Cron trigger scheduler
  event-listener.ts   # SSE event → trigger matching
  sdk.ts              # SDK bindings injected into isolates

apps/api/src/routes/
  scripts.ts          # Elysia router

packages/lib/src/types/
  script.ts           # Shared types (Script, Trigger, Execution, ScriptExtension, ScriptContext)

packages/lib/src/core/
  scripts.ts          # useScriptExtensions hook

apps/scripts/         # Frontend app
  src/
    routes/
    components/
```

### Home Integration

```typescript
// In Home class
protected _scripts!: Scripts;

get scripts(): Scripts {
    return (this._scripts ??= new Scripts(this));
}
```

## What Is NOT In Scope

- Public marketplace / script registry
- Script versioning with rollback (version counter exists but no rollback UI)
- Collaborative script editing (single author edits at a time)
- TypeScript compilation in-browser (scripts are plain JS in the editor; TS support is future)
- Sidebar panels in host apps (toolbar actions only in phase 2)
- Script-to-script communication
- Billing/quota per script execution
