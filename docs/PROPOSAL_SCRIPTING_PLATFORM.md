# Eigen Scripting Platform

A server-side scripting and extension system for eigen, enabling external developers to write scripts that organizations, teams, or individual users can install to extend functionality. Inspired by Google Apps Script.

## Core Decisions

- **Runtime**: Deno subprocess — each script runs in a sandboxed Deno process with granular permissions
- **Sandboxing**: Process-level isolation via Deno's permission flags (`--no-read`, `--no-write`, `--allow-net=...`). No access to eigen's filesystem, memory, or process. SDK calls bridge back to eigen via stdin/stdout JSON-RPC.
- **API access**: Graduated/modular — scripts declare permissions in a manifest, users approve at install time
- **Triggers**: Manual, cron-based, and event-driven (leveraging existing `SSEventType` system)
- **Distribution**: Personal, team, and org scoping — no public marketplace for now
- **Architecture**: Standalone service — scripts own their full lifecycle (storage, permissions, execution, logs)
- **UI integration**: Shared scripts sidebar in all apps (like the comments panel), plus context-aware script actions

### Why Deno Subprocess (Not `isolated-vm` or Node `vm`)

- **Node.js `vm`** is explicitly not a security mechanism — code can escape the sandbox via prototype chain traversal (`this.constructor.constructor('return process')()`)
- **`isolated-vm`** is a native C++ V8 addon — incompatible with Bun's JavaScriptCore engine
- **Deno subprocess** provides real process-level isolation with built-in permission flags that map directly to our manifest permissions. Single binary dependency, works regardless of eigen's runtime.

## Data Model

Per-user database at `eigen.scripts/scripts.db`, managed via `ManagedDatabase` with versioned migrations.

### `scripts`

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | nanoid |
| name | text | Display name |
| description | text | Optional |
| source | text | JS source code |
| manifest | text (JSON) | `{ permissions: [...], extensions: [...] }` |
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
| result | text (JSON) | Return value from script, nullable — used for context actions |
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

### Deno Subprocess

Each script execution spawns a Deno child process. Eigen and the subprocess communicate over stdin/stdout JSON-RPC.

**Step 1 — Eigen spawns Deno with restricted permissions:**

```typescript
const allowedDomains = getNetworkAllowlist(script, permissions);
const proc = Bun.spawn([
  "deno", "run",
  "--no-read",
  "--no-write",
  "--no-env",
  "--no-ffi",
  "--no-prompt",
  ...(allowedDomains.length ? [`--allow-net=${allowedDomains.join(",")}`] : ["--no-net"]),
  runnerPath,  // path to runner.ts (bundled with eigen)
], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
```

**Step 2 — Eigen sends script source + context via stdin:**

```json
{ "type": "init", "source": "...", "context": { "user": {...}, "trigger": {...}, "app": {...} } }
```

**Step 3 — Inside Deno, `runner.ts` builds the SDK and executes:**

```typescript
// runner.ts — runs inside Deno subprocess
const init = JSON.parse(await readLine());
let nextId = 1;

async function rpc(method: string, params: unknown) {
  const id = nextId++;
  write(JSON.stringify({ id, method, params }));
  const response = JSON.parse(await readLine());
  if (response.error) throw new Error(response.error);
  return response.result;
}

const eigen = {
  sheets: {
    get: (mountId, range) => rpc("sheets.get", { mountId, range }),
    set: (mountId, range, values) => rpc("sheets.set", { mountId, range, values }),
    getAll: (mountId) => rpc("sheets.getAll", { mountId }),
  },
  drive: {
    list: (mountId, pathId?) => rpc("drive.list", { mountId, pathId }),
    read: (mountId, pathId) => rpc("drive.read", { mountId, pathId }),
    write: (mountId, pathId, data) => rpc("drive.write", { mountId, pathId, data }),
    create: (mountId, name, opts) => rpc("drive.create", { mountId, name, ...opts }),
  },
  fetch: (url, opts) => fetch(url, opts),  // Deno's native fetch, restricted by --allow-net
  log: (msg) => rpc("log", { message: String(msg) }),
  error: (msg) => rpc("error", { message: String(msg) }),
  context: init.context,
  user: init.context.user,
  trigger: init.context.trigger,
};

// Make eigen available globally
globalThis.eigen = eigen;

// Execute the script
const mod = await import(`data:text/javascript,${encodeURIComponent(init.source)}`);

// Call the requested function (from trigger or manual invocation)
const fn = init.context.function || "onRun";
const result = typeof mod[fn] === "function" ? await mod[fn]() : undefined;

write(JSON.stringify({ type: "done", result }));
```

**Step 4 — Eigen host fulfills SDK calls:**

```typescript
// In eigen's executor.ts
for await (const line of readLines(proc.stdout)) {
  const msg = JSON.parse(line);

  if (msg.type === "done") {
    execution.result = msg.result;
    break;
  }

  // SDK call — execute with the invoking user's permissions
  const result = await executeSDKCall(home, msg.method, msg.params, executingUser);
  proc.stdin.write(JSON.stringify({ id: msg.id, result }) + "\n");
}
```

**Constraints:**
- Wall clock timeout: 30s (configurable per org) — `proc.kill()` on timeout
- No filesystem access — Deno's `--no-read --no-write` enforced at runtime level
- No env vars — `--no-env` prevents reading server secrets
- Network — only `eigen.fetch()` via Deno's native fetch, restricted to allowlisted domains by `--allow-net`
- ~50ms subprocess startup overhead — acceptable for all trigger types

**Timeout/kill:** If a script exceeds its time limit, eigen calls `proc.kill()`. Clean OS-level termination, no orphaned state. Execution record marked `timeout`.

### SDK Surface (Phase 1)

```typescript
// Sheets
eigen.sheets.get(mountId, range)         // Read cells from a range
eigen.sheets.set(mountId, range, values) // Write cells to a range
eigen.sheets.getAll(mountId)             // Read entire sheet

// Drive
eigen.drive.list(mountId, pathId?)       // List files/folders
eigen.drive.read(mountId, pathId)        // Read file content
eigen.drive.write(mountId, pathId, data) // Write file content
eigen.drive.create(mountId, name, opts)  // Create file/folder

// HTTP
eigen.fetch(url, options)               // Outbound HTTP (Deno native, domain-restricted)

// Logging
eigen.log(message)                       // Captured in execution log
eigen.error(message)                     // Captured, marks warnings

// Context (read-only, provided at invocation)
eigen.context                            // Full context object from host app
eigen.user                               // { id, name, email }
eigen.trigger                            // { type, event?, params? }
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

Enforced at two levels:
1. **Deno permissions** — `--allow-net` only granted if script has `fetch` permission
2. **SDK call validation** — each RPC call in `executeSDKCall()` checks the script's granted permissions before executing

## Triggers

### Manual

- User clicks "Run" in the Scripts app or clicks a script action in the scripts sidebar
- Scripts export named functions: `export function onRun() { ... }` is the default entry point
- Named exports like `export function translateSelection() { ... }` appear as separate actions
- Context-aware invocation: when triggered from a host app sidebar, the app's current context (selection, active document, etc.) is passed to the script

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

The scripts system respects the sharding seam in `home-relay.ts`. All cross-user script communication flows through the relay.

### New HomeMessage type

```typescript
| { type: 'scripts:execute'; scriptId: string; triggerId: string; context?: ScriptContext }
```

### Event trigger routing

When a user's Home broadcasts an event (e.g. `MAIL_RECEIVED`), the Scripts service checks for matching triggers. If a team/org script needs to execute in another user's Home context, it sends a `scripts:execute` message via `sendToHome()` rather than directly accessing the target Home.

### SDK data access

When a script accesses shared data (e.g. a team mount), the SDK implementation uses the existing `pull*()` pattern from home-relay for reads and `sendToHome()` for writes, keeping all cross-Home access shard-compatible.

## App Extensions & Scripts Sidebar

### Extension System

Scripts declare how they integrate with host apps via the `extensions` array in their manifest. Extensions define where a script appears and what context it needs.

### Extension Declaration

```typescript
type ScriptExtension = {
  app: "docs" | "sheets" | "slides" | "mail" | "chat" | "calendar" | "drive" | "*";
  type: "context-action";
  label: string;
  icon: string;                // lucide icon name
  function: string;            // exported function name to call
  requires?: ("selection" | "activeDocument" | "activeCell")[];  // what context the script needs
};
```

The `"*"` app value means the script appears in all apps that can provide its required context. This enables generic scripts like "Translate selection" that work in any app supporting `selection` + `replaceSelection`.

### Context Capabilities Per App

Each app declares what context it can provide and what result actions it supports. Scripts declare what they `require` — the sidebar only shows scripts whose requirements the current app satisfies.

| App | Provides | Result actions |
|-----|----------|----------------|
| Docs | `selection`, `activeDocument`, `mountId` | `replaceSelection`, `insertText`, `notify` |
| Sheets | `selection` (cell text), `activeCell`, `selectedRange`, `values`, `mountId` | `replaceSelection` (cell value), `setCells`, `notify` |
| Slides | `selection` (object text), `activeObject`, `mountId` | `replaceSelection`, `notify` |
| Mail | `selection` (compose body), `subject`, `body`, `from` | `replaceSelection`, `draft`, `notify` |
| Chat | `selection` (input text), `roomId` | `replaceSelection`, `notify` |
| Calendar | `activeEvent`, `eventId` | `updateEvent`, `notify` |
| Drive | `selectedFiles`, `mountId` | `notify` |

**Key insight:** `selection` and `replaceSelection` are supported across docs, sheets, slides, mail compose, and chat input — enabling a whole class of generic text-processing scripts.

### Context Provider Interface

Each host app implements a context provider that the scripts sidebar uses:

```typescript
// In @workspace/lib
type ScriptContextProvider = {
  app: string;
  capabilities: string[];                    // what this app can provide
  getContext: () => Promise<ScriptContext>;   // gather current context
  applyResult: (result: ScriptResult) => void;  // apply script output
};
```

- **Docs**: `getContext()` reads `editor.state.selection` via ProseMirror, `applyResult()` dispatches a transaction to replace selection
- **Sheets**: `getContext()` reads active cell from `workbookRef.current.getFlowdata()`, `applyResult()` calls `setCellValue()`
- **Slides**: `getContext()` reads `obj.text` from selected object, `applyResult()` calls `onUpdate(obj.id, { text })`
- **Mail**: `getContext()` reads from compose `textareaRef`, `applyResult()` replaces textarea selection
- **Chat**: `getContext()` reads from `ChatMessageInput` content, `applyResult()` replaces input content

### Scripts Sidebar

A shared `ScriptsPanel` component in `packages/ui`, following the same `PropertiesPanel` pattern as the comments sidebar. Shown in all apps via a toolbar button.

**Structure:**

```
PropertiesPanel (w-64, right side)
├── Header: "Scripts" + close button
├── Script list (filtered to current app's capabilities)
│   └── NoteCard per script
│       ├── Script name + description
│       ├── Icon from manifest
│       └── Click → execute with current context
├── Running indicator (spinner when a script is executing)
└── Footer: "Manage scripts →" link to Scripts app
```

**Behavior:**
1. On open, calls `GET /scripts/:ownerId/extensions/:app` to fetch scripts relevant to this app
2. Filters scripts to those whose `requires` are satisfied by the current app's capabilities
3. User clicks a script action → the host app's `getContext()` gathers current state → `POST /scripts/:ownerId/execute` with context → shows spinner → receives result → `applyResult()` applies it
4. If a script needs user input (e.g. a prompt for translation target language), the result can be `{ action: "prompt", message: "Translate to which language?", field: "targetLanguage" }` — the sidebar shows a simple input dialog, then re-executes with the user's answer added to context

**Toolbar integration:**
- New toolbar button in all apps: `Code` icon (from lucide) with tooltip "Scripts"
- Positioned alongside the existing comments button (in apps that have it) or in the toolbar's right section
- Badge shows count of available scripts for the current app

### Prompt-Based Scripts (User Input Before Execution)

Some scripts need user input before running — e.g. a translate script needs to know the target language, a rewrite script needs a prompt describing the desired style.

Scripts signal this by declaring `input` fields in their extension:

```typescript
type ScriptExtension = {
  // ... existing fields
  input?: {
    fields: { name: string; label: string; type: "text" | "select"; options?: string[] }[];
  };
};
```

When a user clicks a script with `input`, the sidebar shows a small inline form (or dialog) with the declared fields. On submit, the field values are merged into `eigen.context` and the script executes.

Example — a translate extension:
```typescript
{
  app: "*",
  type: "context-action",
  label: "Translate",
  icon: "languages",
  function: "translate",
  requires: ["selection"],
  input: {
    fields: [
      { name: "targetLanguage", label: "Translate to", type: "select",
        options: ["Dutch", "English", "French", "German", "Spanish"] }
    ]
  }
}
```

### Example: Translate / Rewrite Script

A concrete example of a built-in script that ships with eigen. Works in any app that supports `selection` + `replaceSelection`.

```javascript
// Name: "Translate / Rewrite"
// Permissions: ["fetch"]
// Extensions: [
//   { app: "*", type: "context-action", label: "Translate", icon: "languages",
//     function: "translate", requires: ["selection"],
//     input: { fields: [{ name: "targetLanguage", label: "To", type: "select",
//       options: ["Dutch", "English", "French", "German", "Spanish"] }] } },
//   { app: "*", type: "context-action", label: "Rewrite", icon: "pencil-line",
//     function: "rewrite", requires: ["selection"],
//     input: { fields: [{ name: "prompt", label: "Rewrite as", type: "text" }] } }
// ]

export async function translate() {
  const text = eigen.context.selection;
  const lang = eigen.context.input.targetLanguage;

  if (!text) return { action: "notify", message: "No text selected" };

  const response = await eigen.fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${eigen.context.input.apiKey || ""}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Translate the following text to ${lang}. Return only the translation, nothing else.` },
        { role: "user", content: text },
      ],
    }),
  });

  const data = await response.json();
  const translated = data.choices[0].message.content.trim();

  return { action: "replaceSelection", value: translated };
}

export async function rewrite() {
  const text = eigen.context.selection;
  const prompt = eigen.context.input.prompt;

  if (!text) return { action: "notify", message: "No text selected" };

  const response = await eigen.fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${eigen.context.input.apiKey || ""}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Rewrite the following text: ${prompt}. Return only the rewritten text.` },
        { role: "user", content: text },
      ],
    }),
  });

  const data = await response.json();
  const rewritten = data.choices[0].message.content.trim();

  return { action: "replaceSelection", value: rewritten };
}
```

**Flow in practice (Docs):**
1. User selects text in a document
2. Opens scripts sidebar → sees "Translate" and "Rewrite" actions
3. Clicks "Translate" → sidebar shows language dropdown → user picks "French"
4. Sidebar calls `getContext()` on the Docs context provider → `{ selection: "Hello world", app: "docs", mountId: "...", documentId: "..." }`
5. Merges input: `{ ...context, input: { targetLanguage: "French" } }`
6. `POST /scripts/:ownerId/execute` → Deno subprocess runs `translate()` → calls OpenAI → returns `{ action: "replaceSelection", value: "Bonjour le monde" }`
7. Sidebar calls `applyResult()` → Docs context provider dispatches ProseMirror transaction replacing the selection with "Bonjour le monde"

**Same script in Sheets:**
1. User clicks a cell with text "Hello world"
2. Opens scripts sidebar → "Translate" is visible (sheets supports `selection`)
3. Same flow → result `{ action: "replaceSelection", value: "Bonjour le monde" }` → Sheets context provider calls `workbookRef.current.setCellValue(row, col, "Bonjour le monde")`

## Frontend — Scripts App

New `apps/scripts/` app following standard eigen app patterns. For managing scripts — creating, editing, configuring triggers, viewing logs.

### Script Editor

- Code editor panel (CodeMirror) with JS syntax highlighting
- Sidebar: name, description, manifest (permission checkboxes), scope selector, extensions editor
- "Run" button with inline output panel below the editor
- Trigger management: add/remove cron or event triggers with config

### Script List (Dashboard)

- Table: name, scope, trigger count, last run status, enabled toggle
- "New Script" button
- Filter by scope (personal / team / org)
- For team/org scripts: "Install" button with permission approval dialog

### Execution Log

- Per-script history table: status, trigger type, duration, timestamp
- Expandable rows: full console log, error details, result JSON
- "Run Now" button

## Backend Structure

```
apps/api/src/lib/scripts/
  scripts.ts          # Scripts domain service class
  db-config.ts        # Drizzle schema + versioned migrations
  executor.ts         # Deno subprocess management, JSON-RPC bridge
  scheduler.ts        # Cron trigger scheduler (in-process timer)
  event-listener.ts   # SSE event → trigger matching + queue
  sdk-handler.ts      # Handles SDK RPC calls from subprocess

apps/api/src/routes/
  scripts.ts          # Elysia router (CRUD, execute, extensions)

docker/scripts/
  runner.ts           # Deno runner — SDK construction + script execution

packages/lib/src/types/
  script.ts           # Shared types: Script, Trigger, Execution, ScriptExtension, ScriptContext, ScriptResult

packages/lib/src/core/scripts/
  use-script-extensions.ts   # useScriptExtensions(app) hook
  context-provider.ts        # ScriptContextProvider interface

packages/ui/src/components/layout/scripts/
  scripts-panel.tsx          # Shared scripts sidebar (like CommentPanel)
  script-action-card.tsx     # Individual script action in the sidebar
  script-input-dialog.tsx    # Inline form/dialog for script input fields

apps/scripts/                # Frontend app (editor, list, logs)
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

### Docker Integration

Add Deno to the API Dockerfile:

```dockerfile
# In docker/api/Dockerfile
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_DIR=/tmp/deno
```

The `runner.ts` file is bundled with the API build and referenced by path in the executor.

## What Is NOT In Scope

- Public marketplace / script registry
- Script versioning with rollback (version counter exists but no rollback UI)
- Collaborative script editing (single author edits at a time)
- TypeScript compilation in-browser (scripts are plain JS in the editor; TS support is future)
- `sidebar-panel` extension type (custom HTML panels rendered in host apps)
- Script-to-script communication
- Billing/quota per script execution
- Script secrets management (API keys are provided via script input fields for now — a dedicated secrets store is a future enhancement)
