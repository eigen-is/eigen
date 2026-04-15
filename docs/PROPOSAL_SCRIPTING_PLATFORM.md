# Eigen Scripting Platform

A server-side scripting and extension system for eigen, enabling users to write scripts that extend functionality.
Scripts run in sandboxed Deno subprocesses, communicate with eigen via JSON-RPC, and can integrate with any
frontend app through a shared context provider pattern. Inspired by Google Apps Script.

## Core Decisions

- **Runtime**: Deno subprocess — each script runs in a sandboxed Deno process with granular permissions
- **Sandboxing**: Process-level isolation via Deno's permission flags. No access to eigen's filesystem, memory,
  or process. SDK calls bridge back to eigen via stdin/stdout JSON-RPC
- **Execution offloading**: A dedicated Bun worker process handles all script execution, keeping the main API's
  event loop clean for HTTP request handling
- **API access**: Scripts declare permissions in a manifest, enforced at two levels (Deno flags + SDK call
  validation)
- **Triggers**: Manual (Phase 1), cron-based and event-driven (future)
- **Distribution**: Personal scope (Phase 1), team and org scoping (future)
- **UI integration**: Shared `ScriptsPanel` sidebar in all apps (like the comments panel), plus context-aware
  script actions

### Why Deno Subprocess

- **Node.js `vm`** is explicitly not a security mechanism — code escapes the sandbox via prototype chain
  traversal (`this.constructor.constructor('return process')()`)
- **`isolated-vm`** is a native C++ V8 addon — incompatible with Bun's JavaScriptCore engine
- **Deno subprocess** provides real process-level isolation with built-in permission flags that map directly to
  manifest permissions. Single binary dependency, works regardless of eigen's runtime

### Why a Separate Worker Process

Script execution involves spawning subprocesses, managing I/O multiplexing, enforcing timeouts, and processing
SDK call results. Running this on the main API's event loop would compete with HTTP request handling under load.

A dedicated Bun worker process (spawned via `Bun.spawn` with IPC) offloads all of this:

- The main API stays responsive — script I/O, timeout enforcement, and Deno lifecycle management happen on a
  separate CPU core
- Worker crash doesn't bring down the API — the main API detects exit and restarts the worker
- Natural concurrency boundary — execution queue and per-user limits live in the worker
- SDK calls proxy back to the main API via IPC, where Home instances and DB connections live

## Architecture

### Process Model

```
Main API (Bun, port 8000)
├── Scripts domain class        (CRUD for scripts/executions, personal DB)
├── Script routes               (HTTP API — create, edit, run, list extensions)
└── ScriptBridge                (IPC bridge to worker — sends execution requests,
                                 fulfills SDK calls from worker)

Script Worker (separate Bun process, spawned at API startup)
├── Execution queue             (per-user concurrency limit, FIFO)
├── Timeout manager             (wall-clock kill per execution)
└── Per-execution Deno management
    ├── Spawn Deno subprocess
    ├── Send init (source + context) via stdin
    ├── Read JSON-RPC from stdout (SDK calls + done/error)
    ├── Forward SDK calls to main API via IPC
    └── Write SDK results to Deno stdin

Deno Runner (one per script execution, sandboxed)
├── Build SDK object (eigen.drive, eigen.fetch, eigen.log, ...)
├── Override console.log/warn/error → route through eigen.log/eigen.error
├── Import + execute script source via data URI
└── Return result or error via stdout JSON-RPC
```

### Data Flow — Script Execution

```
1. User clicks "Run" → POST /scripts/:ownerId/execute/:scriptId
2. Main API: Scripts.createExecution() writes to DB, sends IPC to worker:
   { type: "execute", executionId, source, context, permissions, timeout }
3. Worker: spawns Deno subprocess, sends init via stdin
4. Deno: runner.ts builds SDK, executes script

   SDK call flow (e.g. eigen.drive.list()):
   a. Script calls eigen.drive.list(mountId)
   b. Runner sends stdout: { id: 1, method: "drive.list", params: { mountId } }
   c. Worker reads stdout, sends IPC to main API:
      { type: "sdk", executionId, callId: 1, method: "drive.list", params: { mountId } }
   d. Main API: getHome(ownerId) → home.drive.list(mountId) → result
   e. Main API sends IPC: { type: "sdk-result", executionId, callId: 1, result: [...] }
   f. Worker writes to Deno stdin: { id: 1, result: [...] }
   g. Runner resolves RPC promise → script receives file list

5. Script finishes → runner sends { type: "done", result, log }
6. Worker sends IPC: { type: "completed", executionId, result, log, durationMs }
7. Main API: Scripts.completeExecution() updates DB, returns result to HTTP response
```

### Data Flow — Context Action (Frontend Integration)

```
1. User selects text in Docs editor, opens scripts sidebar
2. Sidebar lists scripts whose requirements the Docs context provider satisfies
3. User clicks "Translate" → sidebar calls docsContextProvider.getContext()
   → { selection: "Hello world", app: "docs", mountId, documentId }
4. POST /scripts/:ownerId/execute/:scriptId with context body
5. [execution pipeline as above — script calls eigen.fetch() to translate]
6. Response: { action: "replaceSelection", value: "Bonjour le monde" }
7. Sidebar calls docsContextProvider.applyResult(result)
   → dispatches ProseMirror transaction replacing selection
```

## Data Model

Per-user database at `{home}/eigen.scripts/scripts.db`, managed via `ManagedDatabase` with versioned migrations.
For future team/org scope, the same DB structure lives in TeamHome/OrgHome — team scripts in the team's DB, org
scripts in the org's DB. This follows the existing Home ownership model (like Drive mounts and Calendar).

### `scripts`

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | nanoid |
| name | text | Display name |
| description | text | Optional |
| source | text | JS source code |
| manifest | text (JSON) | `{ permissions: [...], extensions: [...] }` |
| config | text (JSON) | Per-script key-value config (API keys, preferences) — persisted, not re-entered |
| enabled | integer | 1 = active, 0 = disabled |
| version | integer | Incremented on each save |
| createdAt | integer | Epoch ms |
| updatedAt | integer | Epoch ms |

The `config` column stores user-provided values that persist across executions (e.g. API keys, default
settings). These are merged into `eigen.context.config` at runtime so scripts don't prompt for the same values
every time. Config values are stored as plaintext in the user's personal DB — a dedicated secrets store is a
future enhancement.

### `executions`

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | nanoid |
| scriptId | text FK | |
| status | text | `pending`, `running`, `completed`, `failed`, `timeout` |
| startedAt | integer | Epoch ms |
| finishedAt | integer | Epoch ms, nullable |
| durationMs | integer | Nullable |
| log | text | Captured console output |
| error | text | Error message if failed, nullable |
| result | text (JSON) | Return value from script, nullable |

### `triggers` (Future — Phase 2)

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | nanoid |
| scriptId | text FK | References scripts.id |
| type | text | `cron`, `event` |
| config | text (JSON) | Cron: `{ cron: "0 9 * * *" }`, Event: `{ event: "drive:created", filter: {...} }` |
| enabled | integer | |
| lastRunAt | integer | Epoch ms, nullable |

### `installations` (Future — Phase 2)

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | nanoid |
| scriptId | text FK | |
| userId | text | User who installed/approved |
| grantedPermissions | text (JSON) | Permissions the user approved |
| installedAt | integer | Epoch ms |

For team/org scripts: each user who wants to use a shared script must install it (approving its permissions).
Personal scripts don't need installation records — the author has implicit access.

## Execution Environment

### Worker Process

The script worker is a standalone Bun process spawned by the main API at startup. Communication uses Bun's
built-in IPC (`Bun.spawn` with `ipc` option).

**Main API side (`ScriptBridge`):**

```typescript
// apps/api/src/lib/scripts/script-bridge.ts
const worker = Bun.spawn(["bun", "run", WORKER_PATH], {
    ipc(message) {
        // Handle messages from worker (SDK calls, completion, errors)
        handleWorkerMessage(message);
    },
    serialization: "json",
    stderr: "inherit",  // Worker errors visible in main API logs
});

// Send execution request to worker
function requestExecution(req: ExecutionRequest) {
    worker.send({ type: "execute", ...req });
}

// Handle SDK call from worker — execute against the user's Home
async function handleSDKCall(msg: SDKCallMessage) {
    const home = await getHome(msg.ownerId);
    const result = await executeSDKMethod(home, msg.method, msg.params, msg.permissions);
    worker.send({ type: "sdk-result", executionId: msg.executionId, callId: msg.callId, result });
}
```

**Worker side:**

```typescript
// apps/api/src/lib/scripts/script-worker.ts
const executions = new Map<string, DenoProcess>();
const queue: ExecutionRequest[] = [];
const running = new Map<string, number>();  // ownerId → count

const MAX_CONCURRENT_PER_USER = 5;

process.on("message", (msg) => {
    if (msg.type === "execute") enqueueExecution(msg);
    if (msg.type === "sdk-result") forwardSDKResult(msg);
});

function forwardSDKResult(msg: SDKResultMessage) {
    const proc = executions.get(msg.executionId);
    if (proc) {
        proc.stdin.write(JSON.stringify({ id: msg.callId, result: msg.result }) + "\n");
    }
}
```

**Worker lifecycle:**
- Spawned on API startup, before routes are registered
- Main API monitors `worker.exited` — restarts on unexpected exit
- On API shutdown (`shutdownAllHomes()`), sends `{ type: "shutdown" }` via IPC — worker kills all Deno
  processes and exits
- Running executions on worker crash are marked `failed` with "worker restart" error

### Deno Subprocess

The worker spawns a Deno process per script execution. Deno's permission flags enforce the first layer of
sandboxing.

```typescript
const runnerPath = path.resolve(__dirname, "../../scripts/runner.ts");
const allowedDomains = getNetworkAllowlist(permissions);

const proc = Bun.spawn([
    "deno", "run",
    `--allow-read=${runnerPath}`,   // Runner needs to read itself
    "--deny-write",                 // No filesystem writes
    "--deny-env",                   // No environment variables
    "--deny-ffi",                   // No native code
    "--no-prompt",                  // Never prompt for permissions
    ...(allowedDomains.length
        ? [`--allow-net=${allowedDomains.join(",")}`]
        : ["--deny-net"]),
    runnerPath,
], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
});

// Send init message with script source and context
proc.stdin.write(JSON.stringify({
    type: "init",
    source: script.source,
    context: { user, config: script.config, ...appContext },
    function: targetFunction || "onRun",
}) + "\n");

// Start timeout timer
const timer = setTimeout(() => proc.kill(), timeoutMs);
```

**Constraints:**
- Wall clock timeout: 30s default (configurable per org in future)
- `proc.kill()` on timeout — clean OS-level termination, execution marked `timeout`
- `--allow-read` restricted to runner.ts path only — script cannot read eigen's filesystem
- `--deny-write` prevents any filesystem writes
- `--deny-env` prevents reading server secrets
- Network only via Deno's native `fetch`, restricted to allowlisted domains by `--allow-net`
- ~50ms subprocess startup overhead — acceptable for manual triggers, optimizable with process pooling later

### Runner (`runner.ts`)

The runner executes inside the Deno subprocess. It builds the SDK, overrides console output, executes the
script, and handles errors.

```typescript
// docker/scripts/runner.ts — runs inside Deno subprocess

// --- I/O helpers (newline-delimited JSON over stdin/stdout) ---

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let stdinBuffer = "";

function write(data: unknown) {
    Deno.stdout.writeSync(encoder.encode(JSON.stringify(data) + "\n"));
}

async function readLine(): Promise<string> {
    const buf = new Uint8Array(4096);
    while (!stdinBuffer.includes("\n")) {
        const n = await Deno.stdin.read(buf);
        if (n === null) throw new Error("stdin closed");
        stdinBuffer += decoder.decode(buf.subarray(0, n));
    }
    const idx = stdinBuffer.indexOf("\n");
    const line = stdinBuffer.slice(0, idx);
    stdinBuffer = stdinBuffer.slice(idx + 1);
    return line;
}

// --- Init ---

const init = JSON.parse(await readLine());
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const logLines: string[] = [];

// --- JSON-RPC bridge ---

async function rpc(method: string, params: unknown): Promise<unknown> {
    const id = nextId++;
    write({ id, method, params });
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
    });
}

// Background reader for SDK responses
(async () => {
    while (true) {
        try {
            const line = await readLine();
            const msg = JSON.parse(line);
            const p = pending.get(msg.id);
            if (p) {
                pending.delete(msg.id);
                if (msg.error) p.reject(new Error(msg.error));
                else p.resolve(msg.result);
            }
        } catch {
            break;  // stdin closed
        }
    }
})();

// --- Console capture ---
// Scripts will naturally use console.log(). Since stdout is our JSON-RPC channel,
// we must intercept console output and route it through the log RPC.

globalThis.console = {
    ...console,
    log: (...args: unknown[]) => {
        const msg = args.map(String).join(" ");
        logLines.push(msg);
        rpc("log", { message: msg });
    },
    warn: (...args: unknown[]) => {
        const msg = args.map(String).join(" ");
        logLines.push(`[warn] ${msg}`);
        rpc("log", { message: `[warn] ${msg}` });
    },
    error: (...args: unknown[]) => {
        const msg = args.map(String).join(" ");
        logLines.push(`[error] ${msg}`);
        rpc("error", { message: msg });
    },
};

// --- SDK object ---

const eigen = {
    drive: {
        list: (mountId: string, pathId?: string) => rpc("drive.list", { mountId, pathId }),
        read: (mountId: string, pathId: string) => rpc("drive.read", { mountId, pathId }),
        write: (mountId: string, pathId: string, data: string) =>
            rpc("drive.write", { mountId, pathId, data }),
        create: (mountId: string, name: string, opts?: Record<string, unknown>) =>
            rpc("drive.create", { mountId, name, ...opts }),
    },
    fetch: (url: string, opts?: RequestInit) => fetch(url, opts),  // Deno native, domain-restricted
    log: (msg: unknown) => { logLines.push(String(msg)); rpc("log", { message: String(msg) }); },
    error: (msg: unknown) => { logLines.push(`[error] ${msg}`); rpc("error", { message: String(msg) }); },
    context: init.context,
    config: init.context.config || {},
    user: init.context.user,
};

globalThis.eigen = eigen;

// --- Execute ---

try {
    const mod = await import(`data:text/javascript,${encodeURIComponent(init.source)}`);
    const fn = init.function || "onRun";
    const result = typeof mod[fn] === "function" ? await mod[fn]() : undefined;
    write({ type: "done", result, log: logLines.join("\n") });
} catch (e) {
    write({ type: "error", error: e.message, stack: e.stack, log: logLines.join("\n") });
}
```

### SDK Handler

The main API fulfills SDK calls from the worker. Each call is validated against the script's granted permissions
before execution.

```typescript
// apps/api/src/lib/scripts/sdk-handler.ts

const PERMISSION_MAP: Record<string, string> = {
    "drive.list": "drive:read",
    "drive.read": "drive:read",
    "drive.write": "drive:write",
    "drive.create": "drive:write",
    // Future: mail.*, calendar.*, contacts.*, chat.*
};

export async function executeSDKMethod(
    home: Home,
    method: string,
    params: Record<string, unknown>,
    permissions: string[],
): Promise<unknown> {
    const required = PERMISSION_MAP[method];
    if (required && !permissions.includes(required)) {
        throw new Error(`Permission denied: ${method} requires ${required}`);
    }

    switch (method) {
        case "drive.list":
            return home.drive.list(params.mountId as string, params.pathId as string | undefined);
        case "drive.read":
            return home.drive.readFile(params.mountId as string, params.pathId as string);
        case "drive.write":
            return home.drive.writeFile(
                params.mountId as string, params.pathId as string, params.data as string);
        case "drive.create":
            return home.drive.create(params.mountId as string, params.name as string, params);
        case "log":
        case "error":
            return;  // Captured in execution log, no backend action needed
        default:
            throw new Error(`Unknown SDK method: ${method}`);
    }
}
```

### Permission Tokens

```
drive:read  | drive:write
fetch
```

Future (Phase 2+):

```
sheets:read | sheets:write
mail:read   | mail:send
calendar:read | calendar:write
chat:read   | chat:send
contacts:read | contacts:write
```

Enforced at two levels:
1. **Deno permissions** — `--allow-net` only granted if script has `fetch` permission. Filesystem access is
   always denied
2. **SDK call validation** — each RPC call in `executeSDKMethod()` checks the script's granted permissions
   before executing

## Triggers

### Manual (Phase 1)

- User clicks "Run" in the Scripts app, or clicks a script action in the scripts sidebar
- Scripts export named functions: `export function onRun() { ... }` is the default entry point
- Named exports like `export function translateSelection() { ... }` appear as separate actions in the sidebar
- Context-aware: when triggered from a host app's sidebar, the app's current context (selection, active
  document, etc.) is passed to the script

### Cron (Future — Phase 2)

- Standard cron syntax: `"0 9 * * MON-FRI"`
- In-process scheduler in the worker — loads enabled cron triggers on startup, checks due jobs every 60s
- No external dependency (no Redis, no cron daemon) — matches eigen's single-process SQLite philosophy
- Missed runs (server down) are skipped, not queued

### Event-Driven (Future — Phase 2)

- Subscribe to existing `SSEventType` events: `drive:created`, `mail:created`, `chat:message`, etc.
- Optional filter: `{ event: "mail:created", filter: { from: "*@github.com" } }`
- Scripts service registers a listener on `Home.broadcast()` — on event, checks enabled triggers for matches
  and sends execution requests to the worker
- Asynchronous — original action (mail delivery, file upload) is never blocked by script execution
- Deduplication: if a script is already running for the same trigger+event, the new execution is skipped

## Permissions & Scoping

### Personal Scope (Phase 1)

All scripts are personal — created by the user, visible only to the author, stored in the author's
`eigen.scripts/scripts.db`. No installation required.

### Team & Org Scope (Future — Phase 2)

Team scripts live in TeamHome's `eigen.scripts/scripts.db`, org scripts in OrgHome's. This follows the existing
Home ownership model — team data lives in the team's Home, not the author's. Benefits:

- All team members can access scripts through the team Home
- Scripts survive member changes (author leaving doesn't orphan team scripts)
- Works with the sharding seam — cross-home access goes through `home-relay.ts`

| Scope | Stored in | Visible to | Install required? |
|-------|-----------|------------|-------------------|
| personal | UserHome | Author only | No |
| team | TeamHome | Team members | Yes |
| org | OrgHome | Org members | Yes |

### Execution Identity

Scripts execute **as the user who triggered them**, not the author:
- Manual run → runs as the user who clicked "Run"
- Personal cron trigger → runs as author
- Team script triggered by User B → runs as User B, accessing User B's data
- Event trigger → runs as the user whose event fired

No privilege escalation — SDK calls go through the same permission checks as regular API calls.

### Admin Controls (Future)

- Org admins can disable scripting for the org
- Org admins can view all scripts in their org
- Org admins can kill running executions and disable scripts

## Frontend — Scripts App

New `apps/scripts/` app following standard eigen app patterns.

### Script List

- Standard list view: name, last run status, enabled toggle
- "New Script" button
- Future: filter by scope (personal / team / org)

### Script Editor

- Code editor panel (CodeMirror) with JS syntax highlighting
- Right sidebar: name, description, permission checkboxes, extensions editor, config key-value editor
- "Run" button with output panel below the editor (console log + result JSON)
- Future: trigger management (cron, event)

### Execution Log

- Per-script history: status, duration, timestamp
- Expandable rows: full console log, error details, result JSON
- "Run Now" button

## Frontend — Scripts Sidebar (`ScriptsPanel`)

A shared component in `packages/ui`, following the same `PropertiesPanel` pattern as `CommentPanel`. Each app
can show a scripts sidebar via a toolbar toggle button.

### ScriptsPanel Component

```
PropertiesPanel (w-64, right side)
├── Header: "Scripts" + close button
├── Script list (filtered to scripts relevant to current app)
│   └── Per script:
│       ├── Script name + description
│       ├── Icon from extension manifest
│       └── Click → execute with current context
├── Running indicator (spinner during execution)
├── Result display (inline, replaces list temporarily)
└── Footer: "Manage scripts" link to Scripts app
```

**Location:** `packages/ui/src/components/layout/scripts/scripts-panel.tsx`

### Integration Pattern

Each app integrates the sidebar the same way as `CommentPanel` — a toolbar toggle button and conditional
rendering:

```tsx
// In any app's editor component
const [scriptsPanelOpen, setScriptsPanelOpen] = useState(false);

// In toolbar
<TooltipButton
    icon={Code}
    tooltipText="Scripts"
    onClick={() => setScriptsPanelOpen(v => !v)}
    active={scriptsPanelOpen}
/>

// In layout (next to or replacing the comment panel area)
{scriptsPanelOpen && (
    <ScriptsPanel
        ownerId={ownerId}
        contextProvider={docsContextProvider}
        onClose={() => setScriptsPanelOpen(false)}
    />
)}
```

### Context Provider Interface

Each host app implements a context provider. The `ScriptsPanel` uses it to gather context before execution and
apply results after.

```typescript
// packages/lib/src/core/scripts/context-provider.ts

type ScriptContextProvider = {
    app: string;                                     // "docs", "sheets", "slides", etc.
    capabilities: string[];                          // what this app can provide right now
    getContext: () => ScriptContext;                  // gather current app state
    applyResult: (result: ScriptResult) => void;     // apply script output back to the app
};

type ScriptContext = {
    app: string;
    mountId?: string;
    documentId?: string;
    selection?: string;
    [key: string]: unknown;                          // app-specific fields
};

type ScriptResult = {
    action: string;                                  // "replaceSelection", "notify", etc.
    [key: string]: unknown;                          // action-specific fields
};
```

The sidebar filters available scripts: a script's extension `requires` must be a subset of the provider's
current `capabilities`. This filtering happens entirely on the frontend — the backend returns all scripts with
their extensions, the sidebar filters by what the current app can provide.

### Result Actions

| Action | Params | Effect |
|--------|--------|--------|
| `replaceSelection` | `value: string` | Replace the current selection with the given text |
| `insertText` | `value: string`, `position?: "before" \| "after"` | Insert text relative to cursor/selection |
| `notify` | `message: string` | Show a toast notification |

Each context provider's `applyResult()` handles the actions it supports. Unknown actions are ignored with a
console warning.

### Context Capabilities Per App

Each app declares what context it can provide and what result actions it supports. The provider's `capabilities`
array may change dynamically (e.g., `selection` is only present when text is actually selected).

| App | Provides | Result actions |
|-----|----------|----------------|
| Docs | `selection`, `activeDocument`, `mountId` | `replaceSelection`, `insertText`, `notify` |
| Sheets | `selection`, `activeCell`, `selectedRange`, `mountId` | `replaceSelection`, `notify` |
| Slides | `selection`, `activeObject`, `mountId` | `replaceSelection`, `notify` |
| Mail | `selection`, `subject`, `body` | `replaceSelection`, `notify` |
| Chat | `selection`, `roomId` | `replaceSelection`, `notify` |
| Calendar | `activeEvent`, `eventId` | `notify` |
| Drive | `selectedFiles`, `mountId` | `notify` |

**Key insight:** `selection` and `replaceSelection` are supported across docs, sheets, slides, mail compose,
and chat input — enabling a whole class of generic text-processing scripts.

### Phase 1 Context Providers

For MVP, implement context providers for **Docs** and **Sheets** to prove the pattern across two different app
types (ProseMirror editor vs. spreadsheet grid):

- **Docs**: `getContext()` reads `editor.state.selection` via Tiptap/ProseMirror, `applyResult()` dispatches a
  transaction to replace selection
- **Sheets**: `getContext()` reads active cell from fortune-sheet, `applyResult()` calls `setCellValue()`

Other apps add their providers later, following the same interface.

## App Extensions

Scripts declare how they integrate with host apps via the `extensions` array in their manifest.

### Extension Declaration

```typescript
type ScriptExtension = {
    app: "docs" | "sheets" | "slides" | "mail" | "chat" | "calendar" | "drive" | "*";
    type: "context-action";
    label: string;                    // Display name in sidebar
    icon: string;                     // Lucide icon name
    function: string;                 // Exported function name to call
    requires?: string[];              // Context capabilities needed (e.g. ["selection"])
};
```

The `"*"` app value means the script appears in all apps that satisfy its `requires`. This enables generic
scripts like "Translate selection" that work anywhere `selection` + `replaceSelection` are available.

### Prompt-Based Scripts (Future — Phase 2)

Some scripts need user input before running (e.g. target language, rewrite prompt). Scripts signal this via
`input` fields in their extension:

```typescript
type ScriptExtension = {
    // ... existing fields
    input?: {
        fields: { name: string; label: string; type: "text" | "select"; options?: string[] }[];
    };
};
```

When a user clicks a script with `input`, the sidebar shows an inline form. On submit, field values merge into
`eigen.context.input`. For Phase 1, scripts that need parameters use `eigen.config` (persisted per-script
config) instead.

### Example: Translate Script

A script that works in any app supporting `selection` + `replaceSelection`:

```javascript
// Name: "Translate to French"
// Permissions: ["fetch"]
// Config: { apiKey: "sk-..." }  (saved once, persisted in script config)
// Extensions: [
//   { app: "*", type: "context-action", label: "Translate to French", icon: "languages",
//     function: "onRun", requires: ["selection"] }
// ]

export async function onRun() {
    const text = eigen.context.selection;
    if (!text) return { action: "notify", message: "No text selected" };

    const response = await eigen.fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${eigen.config.apiKey}`,
        },
        body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: "Translate to French. Return only the translation." },
                { role: "user", content: text },
            ],
        }),
    });

    const data = await response.json();
    return { action: "replaceSelection", value: data.choices[0].message.content.trim() };
}
```

**Flow in Docs:**
1. User selects text in a document
2. Opens scripts sidebar, sees "Translate to French"
3. Clicks it → sidebar calls `docsContextProvider.getContext()` → `{ selection: "Hello world", ... }`
4. `POST /scripts/:ownerId/execute/:scriptId` with context
5. Worker spawns Deno → script calls OpenAI → returns `{ action: "replaceSelection", value: "Bonjour le monde" }`
6. Sidebar calls `docsContextProvider.applyResult()` → ProseMirror transaction replaces selection

**Same script in Sheets** — no changes needed:
1. User clicks a cell with "Hello world"
2. Same flow → Sheets context provider calls `setCellValue()` with the translated text

## Backend Structure

```
apps/api/src/lib/scripts/
  scripts.ts            # Scripts domain class (CRUD, execution lifecycle)
  db-config.ts          # Drizzle schema + versioned migrations
  schema.ts             # Drizzle table definitions
  script-bridge.ts      # IPC bridge to worker process
  script-worker.ts      # Worker process entry point (execution queue, Deno management)
  sdk-handler.ts        # Handles SDK RPC calls from subprocess
  sse-events.ts         # SSE event builders for script domain

apps/api/src/routes/
  scripts.ts            # Elysia router (CRUD, execute, list)

docker/scripts/
  runner.ts             # Deno runner (SDK construction + script execution)

packages/lib/src/types/
  script.ts             # Shared types: Script, Execution, ScriptExtension, ScriptContext, ScriptResult

packages/lib/src/core/scripts/
  hooks/
    use-scripts.ts      # useScripts, useScript, useExecutions, useRunScript, etc.
    index.ts
  sse-handlers.ts       # Cache invalidation for script events
  context-provider.ts   # ScriptContextProvider type definition

packages/ui/src/components/layout/scripts/
  scripts-panel.tsx     # Shared scripts sidebar
  script-action-card.tsx

apps/scripts/           # Frontend app (editor, list, logs)
  src/
    routes/
    components/
```

### Home Integration

```typescript
// In UserHome constructor
this._scripts = new Scripts(this);

// In Home class
protected _scripts!: Scripts;

get scripts(): Scripts {
    this.touch();
    return this._scripts;
}
```

For Phase 1, only `UserHome` gets scripts. In Phase 2, `TeamHome` and `OrgHome` add scripts too, following the
same lazy-init pattern.

### Docker Integration

Deno must be available in the API container:

```dockerfile
# In docker/api/Dockerfile
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_DIR=/tmp/deno
ENV PATH="/root/.deno/bin:${PATH}"
```

The `runner.ts` file is copied into the Docker image alongside the API build.

## Home-Relay Integration (Future — Phase 2)

The scripts system respects the sharding seam in `home-relay.ts`.

### New HomeMessage type

```typescript
| { type: 'scripts:execute'; scriptId: string; context?: ScriptContext }
```

### Event trigger routing

When a user's Home broadcasts an event, the Scripts service checks for matching triggers. If a team/org script
needs to execute in another user's Home context, it sends a `scripts:execute` message via `sendToHome()` rather
than directly accessing the target Home.

### SDK data access

When a script accesses shared data (e.g. a team mount), the SDK handler uses the existing `pull*()`/
`sendToHome()` patterns from home-relay, keeping all cross-Home access shard-compatible.

## Implementation Phases

### Phase 1 — MVP

The minimum that proves the full pipeline end-to-end:

**Backend:**
- `Scripts` domain class (CRUD + execute)
- `db-config.ts` with `scripts` + `executions` tables
- `ScriptBridge` (IPC to worker)
- `script-worker.ts` (execution queue, Deno subprocess management)
- `runner.ts` (SDK + console capture + error handling)
- `sdk-handler.ts` (drive.list, drive.read, log, error)
- Routes: CRUD, execute, list
- Personal scope only

**SDK:**
- `eigen.drive.list()`, `eigen.drive.read()` — enough for useful file-processing scripts
- `eigen.fetch()` — external API calls (domain-restricted)
- `eigen.log()`, `eigen.error()` — captured output
- `eigen.context`, `eigen.config` — read-only invocation context + persisted config

**Frontend:**
- Scripts app: list view + CodeMirror editor + "Run" button + output panel
- `ScriptsPanel` in `packages/ui` (PropertiesPanel-based sidebar)
- `ScriptContextProvider` interface
- Context providers for Docs + Sheets
- Toolbar integration: `Code` icon button (alongside existing comment button)
- Result actions: `replaceSelection`, `notify`

### Phase 2 — Triggers & Sharing

- Cron and event-driven triggers (scheduler in worker, event listener in main API)
- Team/org script scope (Scripts domain in TeamHome/OrgHome)
- Installation/permission approval flow
- Prompt-based script inputs (`input` field in extensions)
- Extended SDK: `eigen.sheets.*`, `eigen.mail.*`, `eigen.calendar.*`
- Admin controls (disable scripting, view/kill executions)

### Phase 3 — Rich Extensions

- `sidebar-panel` extension type (custom HTML rendered in host apps)
- Script secrets/config store (encrypted, separate from script source)
- Execution metrics and quota enforcement
- Script versioning with rollback UI

## What Is NOT In Scope

- Public marketplace / script registry
- Collaborative script editing (single author edits at a time)
- TypeScript in-browser (scripts are plain JS; TS support is future)
- Script-to-script communication
- Billing/quota per script execution
