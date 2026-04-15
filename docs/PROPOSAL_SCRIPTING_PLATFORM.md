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
- **SDK design**: Proxy-based domain access — the runner is completely generic. Adding new SDK methods requires
  zero changes to the runner, only a backend handler. Domain methods mirror route structure, ownerId defaults
  to the executing user
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
├── Build SDK via Proxy          (eigen.drive.*, eigen.calendar.*, etc. — generic, no method enumeration)
├── Override console.log/warn/error → capture locally in logLines
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

3. Deno: runner.ts builds SDK via Proxy, executes script

   SDK call flow (e.g. eigen.drive.listFolder({ mountId, pathId })):
   a. Script calls eigen.drive.listFolder({ mountId, pathId })
   b. Proxy intercepts → RPC stdout: { id: 1, method: "drive.listFolder", params: { ownerId, mountId, pathId } }
      (ownerId auto-injected from eigen.user.id)
   c. ScriptRunner reads stdout, resolves ownerId:
      getHome(params.ownerId) → home.drive.list(mountId, pathId)
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

### `cron_triggers` (server-level, in `eigen.db` — Phase 2)

Server-level index so the cron scheduler doesn't need to scan every user's DB on startup. Canonical trigger
data stays in the user's `scripts.db`; this is a lookup table only.

| Column | Type | Notes |
|--------|------|-------|
| triggerId | text PK | References triggers.id in user's scripts.db |
| scriptId | text | |
| ownerId | text | Home that owns the script |
| cron | text | Cron expression (e.g. `"0 9 * * MON-FRI"`) |
| enabled | integer | |

CRUD operations on triggers update both the user's `scripts.db` and this server-level index atomically.

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
- SDK calls from the runner are handled inline: `getHome(params.ownerId)` → domain method → write result to stdin
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

The runner executes inside the Deno subprocess. It uses a Proxy-based SDK so domain methods are dispatched
generically — the runner never enumerates SDK methods. Adding new backend capabilities requires zero runner
changes.

Console output (`console.log/warn/error`) is captured locally in `logLines` and sent with the final
done/error message. No RPC needed for logging — stdout is reserved for SDK calls only.

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

// --- Console capture (local only, no RPC) ---

globalThis.console = {
    ...console,
    log: (...args: unknown[]) => logLines.push(args.map(String).join(" ")),
    warn: (...args: unknown[]) => logLines.push(`[warn] ${args.map(String).join(" ")}`),
    error: (...args: unknown[]) => logLines.push(`[error] ${args.map(String).join(" ")}`),
};

// --- Proxy-based SDK ---
// Domain methods are dispatched generically via Proxy. The runner never enumerates
// methods — adding new SDK capabilities requires only a backend handler, not runner changes.
// ownerId defaults to the executing user but can be overridden (e.g. for team data).

function createDomainProxy(domain: string) {
    return new Proxy({} as Record<string, (params?: Record<string, unknown>) => Promise<unknown>>, {
        get(_, method: string) {
            return (params: Record<string, unknown> = {}) =>
                rpc(`${domain}.${method}`, { ownerId: init.context.user.id, ...params });
        },
    });
}

const eigen = {
    drive: createDomainProxy("drive"),
    calendar: createDomainProxy("calendar"),
    mail: createDomainProxy("mail"),
    contacts: createDomainProxy("contacts"),
    // Future domains are added here — one line each

    fetch: (url: string, opts?: RequestInit) => fetch(url, opts),  // Deno native, domain-restricted
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

**Key design points:**
- `createDomainProxy("drive")` creates a Proxy where `eigen.drive.anyMethod(params)` becomes
  `rpc("drive.anyMethod", { ownerId: user.id, ...params })` — completely generic
- `ownerId` is auto-injected from `eigen.user.id` but can be overridden:
  `eigen.drive.listFolder({ ownerId: "team_abc", mountId, pathId })` for team data
- Console capture is local-only — no RPC calls for logging. Stdout stays clean for SDK calls
- Adding a new domain = one `createDomainProxy()` line in the runner + backend handlers. That's it.

### SDK Handler

The main API fulfills SDK calls from the runner. Method names arrive as `"domain.method"` from the Proxy.
Each call is validated against the script's granted permissions before execution. The handler resolves
`ownerId` from params and uses `getHome()` — respecting the sharding seam.

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
    "drive.listFolder": "drive:read",
    "drive.getPath": "drive:read",
    "drive.readFile": "drive:read",
    "docs.getText": "drive:read",
    "docs.getJson": "drive:read",
    "sheets.getCellValue": "drive:read",
    "sheets.getRange": "drive:read",
    "sheets.getSheetData": "drive:read",
    // Phase 2: "drive.writeFile": "drive:write", "drive.create": "drive:write",
    // Phase 2: "docs.insertContent": "drive:write", "sheets.setCellValue": "drive:write",
    // Phase 2: "mail.list": "mail:read", "calendar.listEvents": "calendar:read", etc.
};

type SDKMethod = (home: Home, params: Record<string, unknown>) => Promise<unknown>;

const METHOD_HANDLERS: Record<string, SDKMethod> = {
    // Drive
    "drive.listFolder": (home, p) =>
        home.drive.list(p.mountId as string, p.pathId as string | undefined),
    "drive.getPath": (home, p) =>
        home.drive.getPath(p.mountId as string, p.pathId as string),
    "drive.readFile": (home, p) =>
        home.drive.readFile(p.mountId as string, p.pathId as string),
    // Docs — uses shared DocumentReader (see Document Content Layer)
    "docs.getText": (home, p) =>
        readDocContent(home.drive, p.mountId as string, p.pathId as string).then(c => c.text),
    "docs.getJson": (home, p) =>
        readDocContent(home.drive, p.mountId as string, p.pathId as string).then(c => c.json),
    // Sheets — uses shared DocumentReader
    "sheets.getCellValue": (home, p) =>
        readSheetCellValue(home.drive, p.mountId as string, p.pathId as string,
            p.sheet as number, p.row as number, p.col as number, p.render as string | undefined),
    "sheets.getRange": (home, p) =>
        readSheetRange(home.drive, p.mountId as string, p.pathId as string,
            p.sheet as number, p.startRow as number, p.startCol as number,
            p.endRow as number, p.endCol as number, p.render as string | undefined),
    "sheets.getSheetData": (home, p) =>
        readSheetContent(home.drive, p.mountId as string, p.pathId as string).then(c => c.sheets[p.sheet as number]),
    // Phase 2: "drive.writeFile", "drive.create", "docs.insertContent", "sheets.setCellValue", ...
};

export async function executeSDKMethod(
    method: string,
    params: Record<string, unknown>,
    permissions: string[],
): Promise<unknown> {
    const handler = METHOD_HANDLERS[method];
    if (!handler) {
        return { error: { code: SDK_ERROR.INVALID_PARAMS, message: `Unknown method: ${method}` } };
    }

    const required = PERMISSION_MAP[method];
    if (required && !permissions.includes(required)) {
        return { error: { code: SDK_ERROR.PERMISSION_DENIED, message: `${method} requires ${required}` } };
    }

    try {
        const home = await getHome(params.ownerId as string);
        return handler(home, params);
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

**Adding a new SDK method** is two lines:
1. Add to `PERMISSION_MAP`: `"calendar.listEvents": "calendar:read"`
2. Add to `METHOD_HANDLERS`: `"calendar.listEvents": (home, p) => home.calendar.listEvents(p.calendarId)`

The runner needs no changes — the Proxy already forwards `eigen.calendar.listEvents(...)` as
`rpc("calendar.listEvents", ...)`.

Document-aware SDK methods (`docs.getText`, `sheets.getRange`) use the shared Document Content Layer (see
below) — the same readers that power export, preview, and import.

### SDK Error Contract

Scripts receive structured errors with a `code` field. This contract is stable from Phase 1 — scripts can
rely on error codes for control flow.

```javascript
// In a user script
try {
    const files = await eigen.drive.listFolder({ mountId, pathId });
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
drive:read                  # drive.listFolder, drive.getPath, drive.readFile,
                            # docs.getText, docs.getJson,
                            # sheets.getCellValue, sheets.getRange, sheets.getSheetData
fetch                       # eigen.fetch() — Deno native, domain-restricted
```

Document read methods (`docs.*`, `sheets.*`) use the `drive:read` permission because documents are drive
items — reading their content is reading drive data. This keeps the permission model simple: one token
covers all read access to a user's files, whether raw or structured.

Phase 2+:

```
drive:write                 # drive.writeFile, drive.create, docs.insertContent,
                            # sheets.setCellValue, sheets.setCellRange
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

### Cron (Phase 2)

Uses Bun's built-in `Bun.cron()` — no custom scheduler, no external dependencies.

**Server-level cron index**: `cron_triggers` table in `eigen.db` (alongside the share registry). This is a
lookup table so the scheduler doesn't need to scan every user's DB on startup. The canonical trigger data
stays in the user's `scripts.db`.

**Lifecycle:**
1. **API startup**: load all enabled triggers from `cron_triggers` in `eigen.db`, register each with
   `Bun.cron(name, schedule, callback)`
2. **Callback fires**: `getHome(ownerId)` (cold-starts Home if needed) → `runScript()`
3. **Trigger CRUD**: update both user's `scripts.db` and server-level `cron_triggers`, then
   register/unregister the `Bun.cron()` in the same operation
4. **API shutdown**: Bun handles cleanup of registered crons

```typescript
// On startup
const triggers = await loadEnabledCronTriggers();  // from eigen.db
for (const trigger of triggers) {
    Bun.cron(trigger.triggerId, trigger.cron, async () => {
        const home = await getHome(trigger.ownerId);
        const script = await home.scripts.get(trigger.scriptId);
        if (script?.enabled) {
            await runScript({ ...script, ownerId: trigger.ownerId });
        }
    });
}
```

Bun handles cron expression evaluation and timing. Missed runs (server down) are skipped, not queued.
Home cold-start on cron trigger is the same as any request after idle — `getHome()` reconstructs on demand.

### Event-Driven (Future — Phase 2)

- Subscribe to existing `SSEventType` events: `drive:created`, `mail:created`, `chat:message`, etc.
- Optional filter: `{ event: "mail:created", filter: { from: "*@github.com" } }`
- Scripts service registers a listener on `Home.broadcast()` — on event, checks enabled triggers for matches
  and dispatches execution
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
    // Text selection (Docs, Sheets, Slides, Mail, Chat)
    selection?: string;
    // Drive
    selectedFiles?: { id: string; name: string; mimeType: string }[];
    // Docs — from live ProseMirror editor
    documentText?: string;                                // Full plain text
    documentJson?: JSONContent;                           // ProseMirror JSON tree
    // Sheets — from live fortune-sheet editor
    activeCell?: { sheet: number; row: number; col: number; value: unknown; formula?: string };
    selectedRange?: { sheet: number; startRow: number; startCol: number;
                      endRow: number; endCol: number; values: unknown[][] };
    [key: string]: unknown;                               // app-specific fields
};

// Discriminated union — exhaustive, type-safe
type ScriptAction =
    | { action: "replaceSelection"; value: string }
    | { action: "insertText"; value: string; position?: "before" | "after" }
    | { action: "insertContent"; content: JSONContent }                           // Docs: structured ProseMirror node
    | { action: "setCellValue"; sheet: number; row: number; col: number; value: unknown }  // Sheets
    | { action: "setCellRange"; sheet: number; row: number; col: number; values: unknown[][] }
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
| Docs | `selection`, `documentText`, `documentJson`, `mountId` | `replaceSelection`, `insertText`, `insertContent`, `notify` |
| Drive | `selectedFiles`, `mountId` | `notify` |
| Sheets | `selection`, `activeCell`, `selectedRange`, `mountId` | `replaceSelection`, `setCellValue`, `setCellRange`, `notify` |
| Slides | `selection`, `activeObject`, `mountId` | `replaceSelection`, `notify` |
| Mail | `selection`, `subject`, `body` | `replaceSelection`, `notify` |
| Chat | `selection`, `roomId` | `replaceSelection`, `notify` |
| Calendar | `activeEvent`, `eventId` | `notify` |

**Phase 1 implements: Docs + Drive.** These exercise different capabilities (text selection vs file selection)
and prove the pattern works across very different app types. Other apps add context providers later, following
the same interface.

### Phase 1 Context Providers

- **Docs**: `getContext()` reads `editor.state.selection` via Tiptap/ProseMirror + full document content via
  `editor.getJSON()` and `editor.getText()`. `applyResult()` dispatches ProseMirror transactions for
  `replaceSelection`, `insertText`, `insertContent`. Rich document content is available without a backend
  round-trip because the live editor already has it in memory.
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

### Example: Drive File Processing Script

A script that uses the SDK to read drive contents:

```javascript
// Name: "List folder sizes"
// Permissions: ["drive:read"]
// Extensions: [
//   { app: "drive", type: "context-action", label: "List folder sizes", icon: "hard-drive",
//     function: "onRun", requires: ["selectedFiles"] }
// ]

export async function onRun() {
    const files = eigen.context.selectedFiles;
    if (!files?.length) return { action: "notify", message: "No files selected" };

    // SDK call — ownerId auto-injected from eigen.user.id
    for (const file of files) {
        const path = await eigen.drive.getPath({ mountId: eigen.context.mountId, pathId: file.id });
        console.log(`${path.name}: ${path.size} bytes`);
    }

    // Access team data by overriding ownerId
    // const teamFiles = await eigen.drive.listFolder({ ownerId: "team_abc", mountId, pathId });

    return { action: "notify", message: `Processed ${files.length} files — see log` };
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
apps/api/src/lib/document/                  # Document Content Layer (shared by SDK, export, import, preview)
  types.ts              # DocContent, SheetContent, CellData, DocumentContent union
  doc-reader.ts         # readDocContent() — Yjs → ProseMirror JSON + plain text
  doc-writer.ts         # writeDocContent() — ProseMirror JSON → Yjs update (for import)
  sheets-reader.ts      # readSheetContent() — Yjs → SheetContent with cell values/formulas
  sheets-writer.ts      # writeSheetContent() — SheetContent → Yjs update (for import)

apps/api/src/lib/scripts/
  scripts.ts            # Scripts domain class (CRUD, execution lifecycle)
  db-config.ts          # Drizzle schema + versioned migrations
  schema.ts             # Drizzle table definitions
  script-runner.ts      # Spawns + manages Deno subprocesses directly
  sdk-handler.ts        # METHOD_HANDLERS + PERMISSION_MAP — delegates to document readers
  sse-events.ts         # SSE event builders for script domain

apps/api/src/routes/
  scripts.ts            # Elysia router (CRUD, execute, cancel, list)

docker/scripts/
  runner.ts             # Deno runner (Proxy SDK + console capture + script execution)

packages/lib/src/types/
  script.ts             # Shared types: Script, Execution, ScriptExtension, ScriptContext, ScriptAction
  document.ts           # Shared content types: DocContent, SheetContent, CellData

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

SDK calls include `ownerId` explicitly. When a script accesses shared data (e.g. a team mount via
`eigen.drive.listFolder({ ownerId: "team_abc", mountId, pathId })`), the SDK handler calls
`getHome("team_abc")` — which in a sharded deployment routes through `home-relay.ts` automatically. No
special handling needed in the scripts system.

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

## Document Content Layer

Collaborative document types (eigendoc, eigensheets, eigenslides) store content as Yjs databases, not plain
files. Multiple systems need to read and write their structured content: the scripting SDK, export, import,
preview, and future search indexing. The Document Content Layer is a shared abstraction that serves all of them.

### The Problem

`drive.readFile()` returns raw file data — useless for Yjs-backed documents. A scripting SDK that can only
read binary Yjs blobs is not a real API. Export, preview, and import all need the same thing: structured
access to document content. Today, `loadEigendocContent()` in the export system does this for docs only. No
equivalent exists for sheets, slides, or stickies.

### Architecture

Two paths to document content, both needed:

```
Context path (frontend, live editor)           SDK path (backend, Yjs extraction)
─────────────────────────────────────          ──────────────────────────────────
Live ProseMirror / fortune-sheet editor        data.db (Yjs storage)
  ↓ getContext()                                 ↓ yjs-loader.ts (exists)
ScriptContext with documentText,               Y.Doc
  documentJson, activeCell, etc.                 ↓ DocumentReader (new)
  ↓                                            Structured content (DocContent, SheetContent)
Available in sidebar scripts                     ↓
(current document only,                        Available to SDK, export, import, preview
 no backend round-trip)                        (any document, even closed ones)
```

**Context path**: fast, free, but only the currently-open document. The live editor already has content in
memory — the context provider just exposes it.

**SDK path**: works for any document, needed for cron/event triggers (no frontend), batch processing, and
cross-document scripts. Requires backend Yjs extraction.

### Shared Content Types

```typescript
// packages/lib/src/types/document.ts

// --- Docs ---

type DocContent = {
    type: 'doc';
    json: JSONContent;                // ProseMirror JSON (canonical intermediate)
    text: string;                     // Plain text extraction
    media: Map<string, MediaRef>;     // Referenced images/files
};

// --- Sheets ---

type SheetContent = {
    type: 'sheets';
    sheets: SheetData[];
};

type SheetData = {
    id: string;
    name: string;
    cells: CellData[];                // Sparse — only non-empty cells
    config?: SheetConfig;             // Merges, row/col sizing
};

type CellData = {
    row: number;
    col: number;
    value: unknown;                   // Computed value (fortune-sheet `v`)
    formula?: string;                 // Formula string (fortune-sheet `f`), omitted if none
    display?: string;                 // Formatted display (fortune-sheet `m`)
    type?: 'number' | 'string' | 'boolean' | 'date' | 'error';
};

// --- Union ---

type DocumentContent = DocContent | SheetContent;   // grows with slides/stickies
```

These types map directly to the underlying storage:

| Content field | Fortune-sheet | Google Sheets API equivalent |
|---|---|---|
| `CellData.value` | `cell.v` | `effectiveValue` (computed) |
| `CellData.formula` | `cell.f` | `userEnteredValue.formulaValue` |
| `CellData.display` | `cell.m` | `formattedValue` |
| `CellData.type` | `cell.ct.t` | `ExtendedValue` discriminant |

### DocumentReaders

```typescript
// apps/api/src/lib/document/doc-reader.ts
// Refactored from existing loadEigendocContent() in export/doc/content.ts

async function readDocContent(drive: Drive, mountId: string, pathId: string): Promise<DocContent> {
    // 1. Open data.db via mount system
    // 2. Load Yjs state (existing yjs-loader.ts — snapshots + incremental updates)
    // 3. Y.XmlFragment → ProseMirror JSON (existing @tiptap/y-tiptap)
    // 4. Extract plain text (ProseMirror textBetween or static render)
    // 5. Build media map
}

// apps/api/src/lib/document/sheets-reader.ts

async function readSheetContent(drive: Drive, mountId: string, pathId: string): Promise<SheetContent> {
    // 1. Open data.db via mount system
    // 2. Load Yjs state → Y.Map('state') → parse JSON snapshot → Sheet[]
    // 3. Map fortune-sheet cells to CellData[] (sparse, non-empty only)
    //    cell.v → value, cell.f → formula, cell.m → display, cell.ct.t → type
}
```

**Sheets formula note:** Fortune-sheet calculates formulas client-side only. The server reads last-saved
computed values (`cell.v`) from the Yjs snapshot. These are fresh enough for scripting and export — they're
synced whenever fortune-sheet flushes its snapshot (on save, on `beforeunload`, periodically during editing).
Server-side formula recalculation is a future enhancement; when it arrives, `readSheetContent()` recalculates
before returning, transparently to consumers.

### DocumentWriters (for import)

```typescript
// apps/api/src/lib/document/doc-writer.ts

async function writeDocContent(drive: Drive, mountId: string, pathId: string, content: DocContent): Promise<void> {
    // 1. ProseMirror JSON → Y.XmlFragment (prosemirrorJSONToYDoc from y-prosemirror)
    // 2. Write Yjs update via CollabDocument
    // 3. Store media files in document container
}

// apps/api/src/lib/document/sheets-writer.ts

async function writeSheetContent(drive: Drive, mountId: string, pathId: string, content: SheetContent): Promise<void> {
    // 1. CellData[] → fortune-sheet Sheet[] JSON
    // 2. Write to Y.Map('state') as snapshot
    // 3. Write Yjs update via CollabDocument
}
```

If other editors are connected when a write happens, the Yjs update syncs automatically via the existing
WebSocket collaboration. If nobody's editing, the update is written directly to the database.

### Scripting SDK Methods

Following Google Sheets API patterns — default to computed values, optional `render` parameter:

```javascript
// --- Docs ---

const text = await eigen.docs.getText({ mountId, pathId });
// → "Hello world\nSecond paragraph..."

const json = await eigen.docs.getJson({ mountId, pathId });
// → { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }] }

// --- Sheets ---

// Single cell — returns computed value by default
const val = await eigen.sheets.getCellValue({ mountId, pathId, sheet: 0, row: 0, col: 0 });
// → 42

// With render option (like Google's ValueRenderOption)
const formula = await eigen.sheets.getCellValue({
    mountId, pathId, sheet: 0, row: 0, col: 0, render: "formula"
});
// → "=SUM(A1:A5)"

const display = await eigen.sheets.getCellValue({
    mountId, pathId, sheet: 0, row: 0, col: 0, render: "formatted"
});
// → "$42.00"

// Range — returns 2D array of computed values
const values = await eigen.sheets.getRange({
    mountId, pathId, sheet: 0,
    startRow: 0, startCol: 0, endRow: 9, endCol: 3,
});
// → [[1, "Alice", 95], [2, "Bob", 87], ...]

// Full sheet data — returns all non-empty cells with value + formula + display
const sheet = await eigen.sheets.getSheetData({ mountId, pathId, sheet: 0 });
// → { id, name, cells: [{ row, col, value, formula, display, type }], config }
```

### ScriptActions for Document Writes

Write operations on the currently-open document go through `applyResult()` on the context provider. The
provider dispatches to the live editor — no backend round-trip needed.

```javascript
// Docs — insert structured ProseMirror content
return { action: "insertContent", content: {
    type: "paragraph",
    content: [{ type: "text", text: "Generated by script" }]
}};

// Sheets — set a single cell
return { action: "setCellValue", sheet: 0, row: 5, col: 0, value: 42 };

// Sheets — set a range (row-major 2D array)
return { action: "setCellRange", sheet: 0, row: 0, col: 0, values: [
    ["Name", "Score", "Grade"],
    ["Alice", 95, "A"],
    ["Bob", 87, "B+"],
]};
```

Backend SDK write methods (`docs.insertContent`, `sheets.setCellValue`) are Phase 2 — they apply Yjs
updates through the Collab system and are needed for cron/event-triggered scripts that run without a frontend.

### Consumers

| Consumer | Uses reader | Uses writer | Exists today? |
|----------|-------------|-------------|---------------|
| **Scripting SDK** (`docs.getText`, `sheets.getRange`) | Yes | Phase 2 | No — built in Phase 1 |
| **Export** (DOCX, PDF, HTML) | Yes | — | Docs only (`loadEigendocContent`) |
| **Preview** (HTML rendering) | Yes | — | Docs only |
| **Import** (DOCX, XLSX, ODS) | — | Yes | No |
| **Search indexing** (future) | Yes | — | No |

The existing `loadEigendocContent()` in `apps/api/src/lib/export/doc/content.ts` becomes a thin wrapper
around `readDocContent()`. The export system, preview system, and scripting SDK all use the same reader.

### File Structure

```
apps/api/src/lib/document/
  doc-reader.ts         # readDocContent() — refactored from export/doc/content.ts
  doc-writer.ts         # writeDocContent() — for import (Phase 2)
  sheets-reader.ts      # readSheetContent() — new
  sheets-writer.ts      # writeSheetContent() — for import (Phase 2)

packages/lib/src/types/
  document.ts           # DocContent, SheetContent, CellData — shared FE + BE

apps/api/src/lib/export/
  doc/content.ts        # → becomes thin wrapper around doc-reader.ts

apps/api/src/lib/import/                    # Future
  docx-import.ts        # DOCX → DocContent → writeDocContent()
  xlsx-import.ts        # XLSX → SheetContent → writeSheetContent()
  ods-import.ts         # ODS → DocContent/SheetContent → writer
```

## Implementation Phases

### Phase 1 — MVP

The minimum that proves the full pipeline end-to-end:

**Backend:**
- `Scripts` domain class (CRUD + execute + cancel)
- `db-config.ts` with `scripts` + `executions` tables
- `ScriptRunner` (direct Deno subprocess management from main API)
- `runner.ts` (Proxy SDK + console capture + error handling)
- `sdk-handler.ts` (`METHOD_HANDLERS` + `PERMISSION_MAP`)
- SSE events for execution lifecycle
- Routes: CRUD, execute, cancel, list
- Personal scope only

**Document Content Layer:**
- `readDocContent()` — refactored from existing `loadEigendocContent()` (Yjs → PM JSON + text)
- `readSheetContent()` — new (Yjs → SheetContent with cell values/formulas/display)
- Shared types: `DocContent`, `SheetContent`, `CellData` in `packages/lib/src/types/document.ts`
- Export system refactored to use `readDocContent()` as shared reader

**SDK (read-only):**
- `eigen.drive.*` — Proxy-based, auto-injects ownerId. Methods: `listFolder`, `getPath`, `readFile`
- `eigen.docs.*` — `getText`, `getJson` (via `readDocContent()`)
- `eigen.sheets.*` — `getCellValue`, `getRange`, `getSheetData` (via `readSheetContent()`)
  with `render` option: `"value"` (default), `"formula"`, `"formatted"`
- `eigen.fetch()` — external API calls (domain-restricted via Deno `--allow-net`)
- `console.log/warn/error` — captured locally, delivered with execution result
- `eigen.context`, `eigen.config`, `eigen.user` — read-only invocation context + persisted config
- Structured error codes: `NOT_FOUND`, `PERMISSION_DENIED`, `QUOTA_EXCEEDED`, `INVALID_PARAMS`, `INTERNAL`

**Frontend:**
- Scripts app: list view + CodeMirror editor + "Run" button + output panel
- `ScriptsPanel` in `packages/ui` (PropertiesPanel-based sidebar)
- `ScriptContextProvider` interface
- Context providers for Docs (`selection`, `documentText`, `documentJson` + `replaceSelection`,
  `insertText`, `insertContent`) and Drive (`selectedFiles` + `notify`)
- Toolbar integration: `Code` icon button (alongside existing comment button)

### Phase 2 — Worker + Triggers + Writes + Import

- **Worker process extraction** — move Deno management to dedicated Bun worker with IPC, add execution queue
  and per-user concurrency limits
- **Cron triggers** — `Bun.cron()` per trigger, server-level `cron_triggers` index in `eigen.db`
- **Event-driven triggers** — listener on `Home.broadcast()`, dispatches matching script executions
- **Write SDK operations**: `drive.writeFile`, `drive.create`, `docs.insertContent`,
  `sheets.setCellValue`, `sheets.setCellRange` — with quota enforcement and ACL validation
- **DocumentWriters**: `writeDocContent()`, `writeSheetContent()` — for SDK writes and import
- **File import**: DOCX → `DocContent` → `writeDocContent()`, XLSX → `SheetContent` → `writeSheetContent()`
- Team/org script scope (Scripts domain in TeamHome/OrgHome)
- Installation/permission approval flow
- Prompt-based script inputs (`input` field in extensions)
- Extended SDK: `eigen.mail.*`, `eigen.calendar.*` (Proxy makes these instant to add)
- Context providers for remaining apps (Sheets, Slides, Mail, Chat, Calendar)
- Admin controls (disable scripting, view/kill executions)

### Phase 3 — Rich Extensions

- `sidebar-panel` extension type (custom HTML rendered in host apps)
- Script secrets/config store (encrypted, separate from script source)
- Execution metrics and quota enforcement
- Script versioning with rollback UI
- Script module/import mechanism (bundling or import maps)
- Sheets export (HTML, XLSX) via `readSheetContent()` + format-specific serializers
- Server-side formula recalculation (extract fortune-sheet formula engine)

## What Is NOT In Scope

- Public marketplace / script registry
- Collaborative script editing (single author edits at a time)
- TypeScript in-browser (scripts are plain JS; TS support is future)
- Script-to-script communication
- Billing/quota per script execution
