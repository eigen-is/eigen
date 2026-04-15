# Eigen Scripting Platform

A server-side scripting and extension system for eigen, enabling users to write scripts that extend functionality.
Scripts run in sandboxed Deno subprocesses, communicate with eigen via JSON-RPC, and can integrate with any
frontend app through a shared context provider pattern. Inspired by Google Apps Script.

## Core Decisions

- **Runtime**: Deno subprocess — each script runs in a sandboxed Deno process with granular permissions
- **Sandboxing**: Process-level isolation via Deno's permission flags. No access to eigen's filesystem, memory,
  or process. SDK calls bridge back to eigen via stdin/stdout JSON-RPC
- **Execution model**: Fully asynchronous — POST /execute returns immediately with an execution ID, progress
  and results are delivered via SSE. No HTTP request blocks on script execution
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

### Worker Process — Deferred to Phase 2

Script execution involves spawning subprocesses, managing I/O, enforcing timeouts, and processing SDK calls.
At scale (cron triggers, event-driven execution, many concurrent users), offloading this to a dedicated Bun
worker process makes sense. But Phase 1 is manual-trigger only — a handful of executions per day. The Deno
subprocess itself provides process isolation (a crashing script can't take down the API), so the worker's
isolation benefit is redundant.

Phase 1 spawns Deno directly from the main API via a `ScriptRunner` class. The code is structured so that
extracting it into a worker process in Phase 2 is a mechanical refactor: move the Deno management code, add
an IPC bridge. No architectural changes needed.

## Architecture

### Process Model (Phase 1)

```
Main API (Bun, port 8000)
├── Scripts domain class        (CRUD for scripts/executions, personal DB)
├── Script routes               (HTTP API — create, edit, run, list extensions)
└── ScriptRunner                (spawns Deno subprocesses directly, manages lifecycle,
                                 fulfills SDK calls against Home instances)

Deno Runner (one per script execution, sandboxed)
├── Build SDK object (eigen.drive, eigen.fetch, eigen.log, ...)
├── Override console.log/warn/error → route through eigen.log/eigen.error
├── Import + execute script source via data URI
└── Return result or error via stdout JSON-RPC
```

### Process Model (Phase 2 — Worker Extraction)

```
Main API (Bun, port 8000)
├── Scripts domain class
├── Script routes
└── ScriptBridge                (IPC bridge to worker)

Script Worker (separate Bun process, spawned at API startup)
├── Execution queue             (per-user concurrency limit, FIFO)
├── Timeout manager
└── Per-execution Deno management (moved from ScriptRunner)
```

The worker extraction adds: per-user concurrency limits, execution queuing, and CPU isolation for the main
API. The Deno management code moves unchanged; only the communication layer changes (direct calls → IPC).

### Data Flow — Script Execution

Execution is fully asynchronous. The HTTP request never blocks on script execution.

```
1. User clicks "Run" → POST /scripts/:ownerId/execute/:scriptId
   → Response: { executionId, status: "running" }  (returned immediately)

2. Main API: Scripts.createExecution() writes to DB
   ScriptRunner.spawn() launches Deno subprocess, sends init via stdin

3. Deno: runner.ts builds SDK, executes script

   SDK call flow (e.g. eigen.drive.list()):
   a. Script calls eigen.drive.list(mountId)
   b. Runner sends stdout: { id: 1, method: "drive.list", params: { mountId } }
   c. ScriptRunner reads stdout, executes: getHome(ownerId) → home.drive.list(mountId)
   d. ScriptRunner writes to Deno stdin: { id: 1, result: [...] }
   e. Runner resolves RPC promise → script receives file list

4. Script finishes → runner sends { type: "done", result, log }
5. ScriptRunner: Scripts.completeExecution() updates DB
   home.broadcast(buildScriptEvent("scripts:completed", { executionId }))

6. Frontend: SSE handler invalidates execution queries
   → ScriptsPanel fetches result → calls applyResult() on context provider
```

### Data Flow — Context Action (Frontend Integration)

```
1. User selects text in Docs editor, opens scripts sidebar
2. Sidebar lists scripts whose requirements the Docs context provider satisfies
3. User clicks "Translate" → sidebar calls docsContextProvider.getContext()
   → { selection: "Hello world", app: "docs", mountId, documentId }
4. POST /scripts/:ownerId/execute/:scriptId with context body
   → Returns { executionId, status: "running" } immediately
5. Sidebar shows spinner, tracks executionId
6. [execution pipeline as above — script calls eigen.fetch() to translate]
7. SSE event: scripts:completed { executionId }
8. Sidebar fetches execution result: { action: "replaceSelection", value: "Bonjour le monde" }
9. Sidebar calls docsContextProvider.applyResult(result)
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
| source | text | JS source code (max 256KB, enforced at API layer) |
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
| status | text | `pending`, `running`, `completed`, `failed`, `timeout`, `cancelled` |
| startedAt | integer | Epoch ms |
| finishedAt | integer | Epoch ms, nullable |
| durationMs | integer | Nullable |
| log | text | Captured console output |
| error | text | Error message if failed, nullable |
| result | text (JSON) | Return value from script, nullable |

Execution records are pruned automatically: max 50 per script, oldest deleted first. Pruning runs on
`completeExecution()`.

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

### ScriptRunner

The `ScriptRunner` class manages Deno subprocess lifecycle directly from the main API process. Each execution
gets its own Deno process with a wall-clock timeout.

```typescript
// apps/api/src/lib/scripts/script-runner.ts

const activeExecutions = new Map<string, { proc: Subprocess; timer: Timer }>();

export async function runScript(req: ExecutionRequest): Promise<void> {
    const { executionId, source, context, permissions, timeout, ownerId } = req;
    const runnerPath = path.resolve(import.meta.dir, "../../../docker/scripts/runner.ts");
    const allowedDomains = getNetworkAllowlist(permissions);

    const proc = Bun.spawn([
        "deno", "run",
        `--allow-read=${runnerPath}`,
        "--deny-write",
        "--deny-env",
        "--deny-ffi",
        "--no-prompt",
        "--v8-flags=--max-heap-size=128",
        ...(allowedDomains.length
            ? [`--allow-net=${allowedDomains.join(",")}`]
            : ["--deny-net"]),
        runnerPath,
    ], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
    });

    const timer = setTimeout(() => {
        proc.kill();
        completeExecution(executionId, "timeout");
    }, timeout);

    activeExecutions.set(executionId, { proc, timer });

    // Send init
    proc.stdin.write(JSON.stringify({
        type: "init",
        sdkVersion: 1,
        source,
        context: { user: context.user, config: context.config, ...context },
        function: context.function || "onRun",
    }) + "\n");

    // Read stdout (JSON-RPC from runner)
    handleRunnerOutput(executionId, proc, ownerId, permissions);
}

export function cancelExecution(executionId: string): boolean {
    const entry = activeExecutions.get(executionId);
    if (!entry) return false;
    entry.proc.kill();
    clearTimeout(entry.timer);
    activeExecutions.delete(executionId);
    return true;
}
```

**Lifecycle:**
- `runScript()` spawns Deno, starts timeout, begins reading stdout
- SDK calls from the runner are handled inline: `getHome(ownerId)` → domain method → write result to stdin
- On completion/error/timeout: update execution record, broadcast SSE, clean up
- `cancelExecution()` kills the Deno process and marks the execution as `cancelled`
- On API shutdown (`shutdownAllHomes()`): kill all active Deno processes

### Deno Subprocess

Each script execution gets its own Deno process with strict sandboxing:

**Constraints:**
- Wall clock timeout: 30s default (configurable per org in future)
- Memory limit: 128MB via `--v8-flags=--max-heap-size=128`
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
                if (msg.error) {
                    const err = new Error(msg.error.message);
                    (err as any).code = msg.error.code;
                    p.reject(err);
                } else {
                    p.resolve(msg.result);
                }
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

The main API fulfills SDK calls from the runner. Each call is validated against the script's granted permissions
before execution. Errors are returned as structured objects with a `code` field.

```typescript
// apps/api/src/lib/scripts/sdk-handler.ts

const SDK_ERROR = {
    NOT_FOUND: "NOT_FOUND",
    PERMISSION_DENIED: "PERMISSION_DENIED",
    QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
    INVALID_PARAMS: "INVALID_PARAMS",
    INTERNAL: "INTERNAL",
} as const;

const PERMISSION_MAP: Record<string, string> = {
    "drive.list": "drive:read",
    "drive.read": "drive:read",
    // Phase 2: "drive.write": "drive:write", "drive.create": "drive:write",
    // Phase 2: "mail.list": "mail:read", "mail.send": "mail:send", etc.
};

export async function executeSDKMethod(
    home: Home,
    method: string,
    params: Record<string, unknown>,
    permissions: string[],
): Promise<unknown> {
    const required = PERMISSION_MAP[method];
    if (required && !permissions.includes(required)) {
        return { error: { code: SDK_ERROR.PERMISSION_DENIED, message: `${method} requires ${required}` } };
    }

    try {
        switch (method) {
            case "drive.list":
                return home.drive.list(params.mountId as string, params.pathId as string | undefined);
            case "drive.read":
                return home.drive.readFile(params.mountId as string, params.pathId as string);
            case "log":
            case "error":
                return;  // Captured in execution log, no backend action needed
            default:
                return { error: { code: SDK_ERROR.INVALID_PARAMS, message: `Unknown SDK method: ${method}` } };
        }
    } catch (e) {
        if (e instanceof ApiError) {
            const code = e.status === 404 ? SDK_ERROR.NOT_FOUND
                : e.status === 403 ? SDK_ERROR.PERMISSION_DENIED
                : e.status === 413 ? SDK_ERROR.QUOTA_EXCEEDED
                : SDK_ERROR.INTERNAL;
            return { error: { code, message: e.message } };
        }
        return { error: { code: SDK_ERROR.INTERNAL, message: "Internal error" } };
    }
}
```

### SDK Error Contract

Scripts receive structured errors with a `code` field. This contract is stable from Phase 1 — scripts can
rely on error codes for control flow.

```javascript
// In a user script
try {
    const files = await eigen.drive.list(mountId);
} catch (e) {
    if (e.code === "NOT_FOUND") {
        console.log("Mount not found");
    } else if (e.code === "PERMISSION_DENIED") {
        console.log("No access to this mount");
    }
}
```

Error codes: `NOT_FOUND`, `PERMISSION_DENIED`, `QUOTA_EXCEEDED`, `INVALID_PARAMS`, `INTERNAL`.
New codes may be added in future SDK versions, but existing codes are never removed or renamed.

### Permission Tokens

Phase 1:

```
drive:read
fetch
```

Phase 2+:

```
drive:write
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

### SDK Versioning

The init message includes `sdkVersion: 1`. The runner uses this to construct the SDK object. When new methods
are added in future versions, the runner adapts based on the version number. Rules:

- New SDK versions only **add** methods — never remove or change existing signatures
- Scripts don't declare a target SDK version — they always get the latest
- The version number is for the runner to know what the host API supports (forward compatibility)

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
    app: string;                                          // "docs", "sheets", "drive", etc.
    capabilities: string[];                               // what this app can provide right now
    getContext: () => ScriptContext;                       // gather current app state
    applyResult: (result: ScriptAction) => Promise<void>; // apply script output back to the app
};

type ScriptContext = {
    app: string;
    mountId?: string;
    documentId?: string;
    selection?: string;
    selectedFiles?: { id: string; name: string; mimeType: string }[];
    [key: string]: unknown;                               // app-specific fields
};

// Discriminated union — exhaustive, type-safe
type ScriptAction =
    | { action: "replaceSelection"; value: string }
    | { action: "insertText"; value: string; position?: "before" | "after" }
    | { action: "notify"; message: string };
```

The sidebar filters available scripts: a script's extension `requires` must be a subset of the provider's
current `capabilities`. This filtering happens entirely on the frontend — the backend returns all scripts with
their extensions, the sidebar filters by what the current app can provide.

`applyResult()` validates the action before applying. Unknown actions return a structured error shown in the
scripts panel — not silently ignored.

### Context Capabilities Per App

Each app declares what context it can provide and what result actions it supports. The provider's `capabilities`
array may change dynamically (e.g., `selection` is only present when text is actually selected).

| App | Provides | Result actions |
|-----|----------|----------------|
| Docs | `selection`, `activeDocument`, `mountId` | `replaceSelection`, `insertText`, `notify` |
| Drive | `selectedFiles`, `mountId` | `notify` |
| Sheets | `selection`, `activeCell`, `selectedRange`, `mountId` | `replaceSelection`, `notify` |
| Slides | `selection`, `activeObject`, `mountId` | `replaceSelection`, `notify` |
| Mail | `selection`, `subject`, `body` | `replaceSelection`, `notify` |
| Chat | `selection`, `roomId` | `replaceSelection`, `notify` |
| Calendar | `activeEvent`, `eventId` | `notify` |

**Phase 1 implements: Docs + Drive.** These exercise different capabilities (text selection vs file selection)
and prove the pattern works across very different app types. Other apps add context providers later, following
the same interface.

### Phase 1 Context Providers

- **Docs**: `getContext()` reads `editor.state.selection` via Tiptap/ProseMirror, `applyResult()` dispatches a
  transaction to replace selection. Supports: `selection`, `replaceSelection`, `insertText`, `notify`
- **Drive**: `getContext()` reads selected file list from DriveTable state, `applyResult()` supports `notify`
  only. Useful for file-processing scripts (analyze metadata, check naming, list contents)

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
4. `POST /scripts/:ownerId/execute/:scriptId` with context → `{ executionId, status: "running" }`
5. Sidebar shows spinner
6. [Deno spawns → script calls OpenAI → returns `{ action: "replaceSelection", value: "Bonjour le monde" }`]
7. SSE event `scripts:completed` → sidebar fetches result
8. Sidebar calls `docsContextProvider.applyResult()` → ProseMirror transaction replaces selection

### Example: File Lister Script (Drive)

A script that works in Drive, processing selected files:

```javascript
// Name: "Summarize Selected Files"
// Permissions: ["drive:read"]
// Extensions: [
//   { app: "drive", type: "context-action", label: "Summarize selection", icon: "file-text",
//     function: "onRun", requires: ["selectedFiles"] }
// ]

export async function onRun() {
    const files = eigen.context.selectedFiles;
    if (!files?.length) return { action: "notify", message: "No files selected" };

    const summary = files.map(f => `${f.name} (${f.mimeType})`).join("\n");
    console.log(`Processing ${files.length} files`);

    return { action: "notify", message: `${files.length} files:\n${summary}` };
}
```

## SSE Events

Script execution integrates with the existing SSE system for real-time updates.

### Event Types

```typescript
// In packages/lib/src/types/sse.ts

type ScriptSSEvent =
    | { type: "scripts:started"; script: { executionId: string } }
    | { type: "scripts:completed"; script: { executionId: string } }
    | { type: "scripts:failed"; script: { executionId: string } };
```

Events are minimal (just `executionId`) — consistent with other domain SSE events. The frontend invalidates
execution queries on any script SSE event.

### SSE Handler

```typescript
// packages/lib/src/core/scripts/sse-handlers.ts

export function handleScriptSSEvent(event: ScriptSSEvent, queryClient: QueryClient) {
    switch (event.type) {
        case "scripts:started":
        case "scripts:completed":
        case "scripts:failed":
            queryClient.invalidateQueries({ queryKey: scriptKeys.executions() });
            break;
    }
}
```

## Backend Structure

```
apps/api/src/lib/scripts/
  scripts.ts            # Scripts domain class (CRUD, execution lifecycle)
  db-config.ts          # Drizzle schema + versioned migrations
  schema.ts             # Drizzle table definitions
  script-runner.ts      # Spawns + manages Deno subprocesses directly
  sdk-handler.ts        # Handles SDK RPC calls from subprocess
  sse-events.ts         # SSE event builders for script domain

apps/api/src/routes/
  scripts.ts            # Elysia router (CRUD, execute, cancel, list)

docker/scripts/
  runner.ts             # Deno runner (SDK construction + script execution)

packages/lib/src/types/
  script.ts             # Shared types: Script, Execution, ScriptExtension, ScriptContext, ScriptAction

packages/lib/src/core/scripts/
  hooks/
    use-scripts.ts      # useScripts, useScript, useExecutions, useRunScript, useCancelScript
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

## Limits & Safety

| Limit | Value | Enforced by |
|-------|-------|-------------|
| Script source size | 256 KB | API route validation |
| Execution timeout | 30 s | ScriptRunner (wall-clock `proc.kill()`) |
| Heap memory | 128 MB | Deno `--v8-flags=--max-heap-size=128` |
| Execution history | 50 per script | `completeExecution()` pruning |
| Filesystem access | None | Deno `--deny-write`, `--allow-read` restricted to runner |
| Environment variables | None | Deno `--deny-env` |
| FFI | None | Deno `--deny-ffi` |
| Network | Allowlisted domains only | Deno `--allow-net` / `--deny-net` |

Phase 2 adds: per-user concurrency limit (5), execution queue in worker process, per-org scripting toggle.

## Script Imports (Future)

Phase 1 scripts are self-contained — no external imports. Deno supports URL imports (`import ... from
"https://..."`) but these require `--allow-net`, which is coupled to the `fetch` permission and restricted to
allowlisted domains.

Future options:
- **Bundling step**: pre-bundle scripts with their dependencies before execution
- **Curated standard library**: inject common utilities (date formatting, CSV parsing) into the runner
- **Import maps**: Deno import maps pointing to approved package URLs

This is a Phase 2+ concern. Phase 1 scripts handle enough with the SDK + `eigen.fetch()`.

## Implementation Phases

### Phase 1 — MVP

The minimum that proves the full pipeline end-to-end:

**Backend:**
- `Scripts` domain class (CRUD + execute + cancel)
- `db-config.ts` with `scripts` + `executions` tables
- `ScriptRunner` (direct Deno subprocess management from main API)
- `runner.ts` (SDK + console capture + error handling)
- `sdk-handler.ts` (drive.list, drive.read, log, error — read-only)
- SSE events for execution lifecycle
- Routes: CRUD, execute, cancel, list
- Personal scope only

**SDK (read-only):**
- `eigen.drive.list()`, `eigen.drive.read()` — enough for useful file-processing scripts
- `eigen.fetch()` — external API calls (domain-restricted)
- `eigen.log()`, `eigen.error()` — captured output
- `eigen.context`, `eigen.config` — read-only invocation context + persisted config
- Structured error codes: `NOT_FOUND`, `PERMISSION_DENIED`, `QUOTA_EXCEEDED`, `INVALID_PARAMS`, `INTERNAL`

**Frontend:**
- Scripts app: list view + CodeMirror editor + "Run" button + output panel
- `ScriptsPanel` in `packages/ui` (PropertiesPanel-based sidebar)
- `ScriptContextProvider` interface
- Context providers for Docs (selection + replaceSelection) and Drive (selectedFiles + notify)
- Toolbar integration: `Code` icon button (alongside existing comment button)
- Result actions: `replaceSelection`, `insertText`, `notify`

### Phase 2 — Worker + Triggers + Writes

- **Worker process extraction** — move Deno management to dedicated Bun worker with IPC, add execution queue
  and per-user concurrency limits
- Cron and event-driven triggers (scheduler in worker, event listener in main API)
- **Write SDK operations**: `eigen.drive.write()`, `eigen.drive.create()` with quota enforcement and ACL
  validation
- Team/org script scope (Scripts domain in TeamHome/OrgHome)
- Installation/permission approval flow
- Prompt-based script inputs (`input` field in extensions)
- Extended SDK: `eigen.sheets.*`, `eigen.mail.*`, `eigen.calendar.*`
- Context providers for remaining apps (Sheets, Slides, Mail, Chat, Calendar)
- Admin controls (disable scripting, view/kill executions)

### Phase 3 — Rich Extensions

- `sidebar-panel` extension type (custom HTML rendered in host apps)
- Script secrets/config store (encrypted, separate from script source)
- Execution metrics and quota enforcement
- Script versioning with rollback UI
- Script import mechanism (bundling or import maps)

## What Is NOT In Scope

- Public marketplace / script registry
- Collaborative script editing (single author edits at a time)
- TypeScript in-browser (scripts are plain JS; TS support is future)
- Script-to-script communication
- Billing/quota per script execution
