# Eigen Scripting Platform

A server-side scripting and extension system for eigen, enabling users to write scripts that extend functionality.
Scripts run in sandboxed Deno subprocesses, communicate with eigen via JSON-RPC, and can integrate with any
frontend app through a shared sidebar. Inspired by Google Apps Script.

## Core Decisions

- **Runtime**: Deno subprocess — each script runs in a sandboxed Deno process with granular permissions
- **Sandboxing**: Process-level isolation via Deno's permission flags. No access to eigen's filesystem, memory,
  or process. SDK calls bridge back to eigen via stdin/stdout JSON-RPC
- **Execution model**: Fully asynchronous — POST /execute returns immediately with an execution ID, progress
  and results are delivered via SSE. No HTTP request blocks on script execution
- **SDK design**: Google Apps Script–inspired object model. Document types (docs, sheets) use
  `eigen.docs.getActive()` / `eigen.docs.getById({...})` returning document proxies with chainable methods.
  Flat domains (drive, mail, calendar) use `eigen.drive.method(params)`. All data access goes through the
  backend — no dual frontend/backend paths. Proxy-based: adding new SDK methods requires zero runner changes,
  only a backend handler
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
├── Build SDK via Proxy          (eigen.docs.getActive(), eigen.drive.*, etc.)
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
   c. ScriptRunner reads stdout, resolves via SDK handler:
      getHome(params.ownerId) → handler function → result
   d. ScriptRunner writes to Deno stdin: { id: 1, result: [...] }
   e. Runner resolves RPC promise → script receives file list

   Document call flow (e.g. eigen.docs.getActive().getText()):
   a. eigen.docs.getActive() returns a Proxy with mountId/pathId baked in from context
   b. .getText() → RPC stdout: { id: 2, method: "docs.getText", params: { ownerId, mountId, pathId } }
   c. ScriptRunner: getHome(ownerId) → readDocContent(drive, mountId, pathId) → { text, json }
   d. Returns text to runner

4. Script finishes → runner sends { type: "done", result, log }
5. ScriptRunner: Scripts.completeExecution() updates DB
   home.broadcast(buildScriptEvent("scripts:completed", { executionId }))

6. Frontend: SSE handler invalidates execution queries
   → ScriptsPanel fetches result → calls applyResults() on context provider
```

### Data Flow — Context Action (Frontend Integration)

```
1. User selects text in Docs editor, opens scripts sidebar
2. Sidebar lists scripts registered for the current app
3. User clicks "Translate" → sidebar calls docsContextProvider.getContext()
   → { selection: "Hello world", app: "docs", mountId, pathId }
4. POST /scripts/:ownerId/execute/:scriptId with context body
   → Returns { executionId, status: "running" } immediately
5. Sidebar shows spinner, tracks executionId
6. [Script runs — calls eigen.fetch() to translate. All document reads go through backend SDK.]
7. SSE event: scripts:completed { executionId }
8. Sidebar fetches execution result: [{ action: "replaceSelection", value: "Bonjour le monde" }]
9. Sidebar calls docsContextProvider.applyResults(results)
   → dispatches ProseMirror transaction replacing selection
```

Note: the frontend context provides only **selection state** (what the user has selected, which only the
frontend knows). All document content reads go through the backend SDK, which reads from Yjs. This means
the same script code works identically whether triggered from a sidebar or a cron job.

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
settings). These are merged into `eigen.config` at runtime so scripts don't prompt for the same values
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

Execution records are pruned automatically: max 200 per script, oldest deleted first. Pruning runs on
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
    const runnerPath = path.resolve(import.meta.dir, "runner.ts");
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
- Progress messages from the runner are broadcast via SSE for real-time sidebar updates
- On completion/error/timeout: update execution record, broadcast SSE, clean up
- `cancelExecution()` kills the Deno process and marks the execution as `cancelled`
- On API shutdown (`shutdownAllHomes()`): kill all active Deno processes

### Deno Subprocess

Each script execution gets its own Deno process with strict sandboxing:

**Constraints:**
- Wall clock timeout: 120s default (configurable per org in future)
- Memory limit: 128MB via `--v8-flags=--max-heap-size=128`
- `proc.kill()` on timeout — clean OS-level termination, execution marked `timeout`
- `--allow-read` restricted to runner.ts path only — script cannot read eigen's filesystem
- `--deny-write` prevents any filesystem writes
- `--deny-env` prevents reading server secrets
- Network only via Deno's native `fetch`, restricted to allowlisted domains by `--allow-net`
- ~50ms subprocess startup overhead — acceptable for manual triggers, optimizable with process pooling later

### Runner (`runner.ts`)

The runner executes inside the Deno subprocess. It provides a Google Apps Script–inspired SDK with two patterns:

- **Document domains** (docs, sheets): `eigen.docs.getActive()` / `eigen.docs.getById({...})` return
  document proxies with methods like `.getText()`, `.getCell("A1")`. The proxy auto-injects mountId/pathId
- **Flat domains** (drive, mail, calendar, contacts): `eigen.drive.method(params)` — direct RPC dispatch

All SDK calls go through the same JSON-RPC bridge. The runner never enumerates methods — adding new backend
capabilities requires zero runner changes.

Console output (`console.log/warn/error`) is captured locally in `logLines` and sent with the final
done/error message. Objects are serialized via `JSON.stringify` for readable output.

```typescript
// apps/api/src/lib/scripts/runner.ts — runs inside Deno subprocess

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

const stringify = (v: unknown) =>
    typeof v === "object" && v !== null ? JSON.stringify(v, null, 2) : String(v);

globalThis.console = {
    ...console,
    log: (...args: unknown[]) => logLines.push(args.map(stringify).join(" ")),
    warn: (...args: unknown[]) => logLines.push(`[warn] ${args.map(stringify).join(" ")}`),
    error: (...args: unknown[]) => logLines.push(`[error] ${args.map(stringify).join(" ")}`),
};

// --- SDK: Document proxy (docs, sheets) ---
// Returns an object with getActive() and getById() that produce document proxies.
// The proxy auto-injects mountId/pathId into every RPC call.
// Mirrors Google Apps Script: SpreadsheetApp.getActive() / SpreadsheetApp.openById()

function createDocProxy(domain: string, mountId: string, pathId: string, ownerId: string) {
    return new Proxy({} as Record<string, (...args: unknown[]) => Promise<unknown>>, {
        get(_, method: string) {
            return (params: Record<string, unknown> | string = {}) => {
                const base = { ownerId, mountId, pathId };
                // String arg = shorthand (e.g., A1 notation for sheets)
                if (typeof params === "string") return rpc(`${domain}.${method}`, { ...base, cell: params });
                return rpc(`${domain}.${method}`, { ...base, ...params });
            };
        },
    });
}

function createDocDomain(domain: string) {
    return {
        getActive() {
            const { mountId, pathId } = init.context;
            if (!mountId || !pathId) throw new Error(`No active ${domain} document in current context`);
            return createDocProxy(domain, mountId, pathId, init.context.user.id);
        },
        getById(ids: { ownerId?: string; mountId: string; pathId: string }) {
            return createDocProxy(domain, ids.mountId, ids.pathId, ids.ownerId || init.context.user.id);
        },
    };
}

// --- SDK: Flat domain proxy (drive, mail, calendar, contacts) ---

function createDomainProxy(domain: string) {
    return new Proxy({} as Record<string, (params?: Record<string, unknown>) => Promise<unknown>>, {
        get(_, method: string) {
            return (params: Record<string, unknown> = {}) =>
                rpc(`${domain}.${method}`, { ownerId: init.context.user.id, ...params });
        },
    });
}

// --- SDK object ---

const eigen = {
    // Document domains — object model with getActive() / getById()
    docs: createDocDomain("docs"),
    sheets: createDocDomain("sheets"),

    // Flat domains — direct method dispatch
    drive: createDomainProxy("drive"),
    calendar: createDomainProxy("calendar"),
    mail: createDomainProxy("mail"),
    contacts: createDomainProxy("contacts"),

    // Utilities
    fetch: (url: string, opts?: RequestInit) => fetch(url, opts),  // Deno native, domain-restricted
    progress: (message: string) => { write({ type: "progress", message }); },
    utils: {
        sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    },

    // Context and config
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
- **Document domains** (`eigen.docs`, `eigen.sheets`): `getActive()` returns a Proxy with context
  mountId/pathId baked in — `doc.getText()` becomes `rpc("docs.getText", { ownerId, mountId, pathId })`.
  `getById({ mountId, pathId })` returns a Proxy with explicit IDs. Same Proxy, different IDs.
  Mirrors `SpreadsheetApp.getActive()` / `SpreadsheetApp.openById()`
- **Flat domains** (`eigen.drive`, `eigen.calendar`, etc.): `eigen.drive.listFolder({ mountId, pathId })`
  becomes `rpc("drive.listFolder", { ownerId: user.id, mountId, pathId })`. ownerId can be overridden
  for team data
- **String shorthand**: `sheet.getCell("A1")` auto-wraps as `{ cell: "A1" }` in the RPC params
- Console capture uses `JSON.stringify` for objects — no more `[object Object]`
- `eigen.progress(message)` sends a `{ type: "progress" }` message that the host broadcasts via SSE
- `eigen.utils.sleep(ms)` wraps `setTimeout` (available in Deno, unlike Google Apps Script)

### SDK Handler

The main API fulfills SDK calls from the runner. Each method is registered in a single map with its
permission requirement and handler function. Method names arrive as `"domain.method"` from the Proxy.

```typescript
// apps/api/src/lib/scripts/sdk-handler.ts

const SDK_ERROR = {
    NOT_FOUND: "NOT_FOUND",
    PERMISSION_DENIED: "PERMISSION_DENIED",
    QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
    INVALID_PARAMS: "INVALID_PARAMS",
    INTERNAL: "INTERNAL",
} as const;

type SDKMethod = (home: Home, params: Record<string, unknown>) => Promise<unknown>;

const SDK_METHODS: Record<string, { permission: string; handler: SDKMethod }> = {
    // Drive (flat domain)
    "drive.listFolder": {
        permission: "drive:read",
        handler: (home, p) => home.drive.list(p.mountId as string, p.pathId as string | undefined),
    },
    "drive.getPath": {
        permission: "drive:read",
        handler: (home, p) => home.drive.getPath(p.mountId as string, p.pathId as string),
    },
    "drive.readFile": {
        permission: "drive:read",
        handler: (home, p) => home.drive.readFile(p.mountId as string, p.pathId as string),
    },

    // Docs (document domain — mountId/pathId injected by document proxy)
    "docs.getText": {
        permission: "drive:read",
        handler: (home, p) =>
            readDocContent(home.drive, p.mountId as string, p.pathId as string).then(c => c.text),
    },
    "docs.getJson": {
        permission: "drive:read",
        handler: (home, p) =>
            readDocContent(home.drive, p.mountId as string, p.pathId as string).then(c => c.json),
    },

    // Sheets (document domain — mountId/pathId injected by document proxy)
    "sheets.getCell": {
        permission: "drive:read",
        handler: (home, p) =>
            readSheetCellValue(home.drive, p.mountId as string, p.pathId as string,
                p.cell as string, p.render as string | undefined),
    },
    "sheets.getRange": {
        permission: "drive:read",
        handler: (home, p) =>
            readSheetRange(home.drive, p.mountId as string, p.pathId as string,
                p.cell as string, p.render as string | undefined),
    },
    "sheets.getSheetData": {
        permission: "drive:read",
        handler: (home, p) =>
            readSheetContent(home.drive, p.mountId as string, p.pathId as string)
                .then(c => c.sheets[p.sheet as number]),
    },

    // Phase 2: "drive.writeFile", "drive.create", "docs.insertContent", "sheets.setCell", ...
    // Phase 2: "mail.list", "mail.send", "calendar.listEvents", "calendar.createEvent", ...
};

export async function executeSDKMethod(
    method: string,
    params: Record<string, unknown>,
    permissions: string[],
): Promise<unknown> {
    const entry = SDK_METHODS[method];
    if (!entry) {
        return { error: { code: SDK_ERROR.INVALID_PARAMS, message: `Unknown method: ${method}` } };
    }

    if (!permissions.includes(entry.permission)) {
        return { error: { code: SDK_ERROR.PERMISSION_DENIED, message: `${method} requires ${entry.permission}` } };
    }

    try {
        const home = await getHome(params.ownerId as string);
        return entry.handler(home, params);
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

**Adding a new SDK method** is one entry in `SDK_METHODS`:
```typescript
"calendar.listEvents": {
    permission: "calendar:read",
    handler: (home, p) => home.calendar.listEvents(p.calendarId as string),
},
```

The runner needs no changes — the Proxy already forwards `eigen.calendar.listEvents(...)` as
`rpc("calendar.listEvents", ...)`.

Document-aware SDK methods (`docs.getText`, `sheets.getCell`) use the shared Document Content Layer (see
below) — the same readers that power export, preview, and import.

### SDK Error Contract

Scripts receive structured errors with a `code` field. This contract is stable from Phase 1 — scripts can
rely on error codes for control flow.

```javascript
// In a user script
try {
    const doc = eigen.docs.getById({ mountId, pathId });
    const text = await doc.getText();
} catch (e) {
    if (e.code === "NOT_FOUND") {
        console.log("Document not found");
    } else if (e.code === "PERMISSION_DENIED") {
        console.log("No access to this document");
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
                            # sheets.getCell, sheets.getRange, sheets.getSheetData
fetch                       # eigen.fetch() — Deno native, domain-restricted
```

Document read methods (`docs.*`, `sheets.*`) use the `drive:read` permission because documents are drive
items — reading their content is reading drive data. This keeps the permission model simple: one token
covers all read access to a user's files, whether raw or structured.

Phase 2+:

```
drive:write                 # drive.writeFile, drive.create, docs.insertContent,
                            # sheets.setCell, sheets.setCellRange
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
- Context-aware: when triggered from a host app's sidebar, the app's current selection state is passed to
  the script via `eigen.context`

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

For team scripts, `eigen.config` stores per-script config set by the script author/installer. Phase 2 should
add user-scoped properties (like Google's `PropertiesService.getUserProperties()`) so each user running a
shared script can have their own settings (API keys, preferences).

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
├── Script list (filtered to scripts registered for current app)
│   └── Per script:
│       ├── Script name + description
│       ├── Icon from extension manifest
│       └── Click → execute with current context
├── Running indicator (spinner during execution)
├── Progress messages (from eigen.progress())
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

Each host app implements a context provider. The sidebar uses it to gather selection state before execution
and apply results after. All document **content** reads go through the backend SDK — the context provider
only provides what the frontend uniquely knows (user selection, UI state).

```typescript
// packages/lib/src/core/scripts/context-provider.ts

type ScriptContextProvider = {
    app: string;                                          // "docs", "sheets", "drive", etc.
    getContext: () => ScriptContext;                       // gather current selection state
    applyResults: (results: ScriptAction[]) => Promise<void>; // apply script output back to the app
};

type ScriptContext = {
    app: string;
    mountId?: string;
    pathId?: string;
    // Selection state — only things the frontend uniquely knows
    selection?: string;                                    // Selected text (Docs, Sheets, Slides, Mail)
    selectedFiles?: { id: string; name: string; mimeType: string }[];  // Drive
};
```

The sidebar shows all scripts registered for the current `app` (via extensions). Scripts that need specific
context (e.g. selected text) handle missing context gracefully in their code — no dynamic capability
filtering.

### ScriptAction (returned by scripts)

Scripts return an **array** of actions to apply. This allows a script to both modify content and show a
notification in a single execution.

```typescript
// Discriminated union — exhaustive, type-safe
type ScriptAction =
    | { action: "replaceSelection"; value: string }
    | { action: "insertText"; value: string; position?: "before" | "after" }
    | { action: "insertContent"; content: JSONContent }                           // Docs: structured ProseMirror node
    | { action: "setCellValue"; sheet: number; row: number; col: number; value: unknown }  // Sheets
    | { action: "setCellRange"; sheet: number; row: number; col: number; values: unknown[][] }
    | { action: "notify"; message: string };
```

`applyResults()` processes the array in order. Unknown actions return a structured error shown in the
scripts panel — not silently ignored.

### Context Per App

Each app provides selection state and supports result actions:

| App | Context (selection state) | Result actions |
|-----|--------------------------|----------------|
| Docs | `selection`, `mountId`, `pathId` | `replaceSelection`, `insertText`, `insertContent`, `notify` |
| Drive | `selectedFiles`, `mountId` | `notify` |
| Sheets | `selection`, `mountId`, `pathId` | `replaceSelection`, `setCellValue`, `setCellRange`, `notify` |
| Slides | `selection`, `mountId`, `pathId` | `replaceSelection`, `notify` |
| Mail | `selection` | `replaceSelection`, `notify` |
| Chat | `selection` | `replaceSelection`, `notify` |
| Calendar | — | `notify` |

Document content (full text, cell values, JSON) is always read via the backend SDK (`eigen.docs.getActive().getText()`,
`eigen.sheets.getActive().getCell("A1")`), not via context. This means scripts work identically whether triggered
from a sidebar, a cron job, or an event — same API, same data source.

**Phase 1 implements: Docs + Drive.** These exercise different capabilities (text selection + document reading vs
file selection) and prove the pattern works across different app types. Other apps add context providers later,
following the same interface.

### Phase 1 Context Providers

- **Docs**: `getContext()` reads `editor.state.selection` for selected text, provides mountId/pathId.
  `applyResults()` dispatches ProseMirror transactions for `replaceSelection`, `insertText`, `insertContent`.
  Document content reads go through `eigen.docs.getActive().getText()` / `.getJson()` on the backend
- **Drive**: `getContext()` reads selected file list from DriveTable state, `applyResults()` supports `notify`
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
};
```

The `"*"` app value means the script appears in all apps. This enables generic scripts like "Translate
selection" that work anywhere selection is available (the script checks `eigen.context.selection` and handles
the missing case).

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

A script that works in any app supporting selection + replaceSelection:

```javascript
// Name: "Translate to French"
// Permissions: ["fetch"]
// Config: { apiKey: "sk-..." }  (saved once, persisted in script config)
// Extensions: [
//   { app: "*", type: "context-action", label: "Translate to French", icon: "languages",
//     function: "onRun" }
// ]

export async function onRun() {
    const text = eigen.context.selection;
    if (!text) return [{ action: "notify", message: "No text selected" }];

    eigen.progress("Translating...");

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
    return [
        { action: "replaceSelection", value: data.choices[0].message.content.trim() },
        { action: "notify", message: "Translated to French" },
    ];
}
```

**Flow in Docs:**
1. User selects text in a document
2. Opens scripts sidebar, sees "Translate to French"
3. Clicks it → sidebar calls `docsContextProvider.getContext()` → `{ selection: "Hello world", mountId, pathId }`
4. `POST /scripts/:ownerId/execute/:scriptId` with context → `{ executionId, status: "running" }`
5. Sidebar shows spinner, displays progress messages from `eigen.progress()`
6. [Deno spawns → script calls OpenAI → returns `[{ action: "replaceSelection", ... }, { action: "notify", ... }]`]
7. SSE event `scripts:completed` → sidebar fetches result
8. Sidebar calls `docsContextProvider.applyResults(results)` → ProseMirror transaction replaces selection, toast shown

### Example: Drive File Processing Script

A script that uses the SDK to read drive contents:

```javascript
// Name: "List folder sizes"
// Permissions: ["drive:read"]
// Extensions: [
//   { app: "drive", type: "context-action", label: "List folder sizes", icon: "hard-drive",
//     function: "onRun" }
// ]

export async function onRun() {
    const files = eigen.context.selectedFiles;
    if (!files?.length) return [{ action: "notify", message: "No files selected" }];

    for (const file of files) {
        // ownerId auto-injected from eigen.user.id
        const path = await eigen.drive.getPath({ mountId: eigen.context.mountId, pathId: file.id });
        console.log(`${path.name}: ${path.size} bytes`);
    }

    return [{ action: "notify", message: `Processed ${files.length} files — see log` }];
}
```

### Example: Document Analysis Script

A script using the document object model to read content from the active document and another document:

```javascript
// Name: "Compare with template"
// Permissions: ["drive:read"]
// Extensions: [
//   { app: "docs", type: "context-action", label: "Compare with template", icon: "file-diff",
//     function: "onRun" }
// ]

export async function onRun() {
    // Read the active document (sidebar context — mountId/pathId auto-injected)
    const doc = eigen.docs.getActive();
    const currentText = await doc.getText();

    // Read a different document by explicit IDs
    const template = eigen.docs.getById({ mountId: eigen.config.templateMountId, pathId: eigen.config.templatePathId });
    const templateText = await template.getText();

    // Compare
    const currentWords = currentText.split(/\s+/).length;
    const templateWords = templateText.split(/\s+/).length;

    console.log(`Current: ${currentWords} words`);
    console.log(`Template: ${templateWords} words`);
    console.log(`Difference: ${currentWords - templateWords} words`);

    return [{ action: "notify", message: `${currentWords} words (template: ${templateWords})` }];
}
```

### Example: Sheets Script

A script reading and processing spreadsheet data using A1 notation:

```javascript
// Name: "Sum column"
// Permissions: ["drive:read"]
// Extensions: [
//   { app: "sheets", type: "context-action", label: "Sum column A", icon: "calculator",
//     function: "onRun" }
// ]

export async function onRun() {
    const sheet = eigen.sheets.getActive();

    // A1 notation — mirrors Google Sheets API
    const values = await sheet.getRange("A1:A100");
    const sum = values.flat().filter(v => typeof v === "number").reduce((a, b) => a + b, 0);

    console.log(`Sum of column A: ${sum}`);

    // Read a specific cell's formula
    const formula = await sheet.getCell("B1", { render: "formula" });
    console.log(`B1 formula: ${formula}`);

    return [
        { action: "setCellValue", sheet: 0, row: 0, col: 1, value: sum },
        { action: "notify", message: `Sum: ${sum}` },
    ];
}
```

## SSE Events

Script execution integrates with the existing SSE system for real-time updates.

### Event Types

```typescript
// In packages/lib/src/types/sse.ts

type ScriptSSEvent =
    | { type: "scripts:started"; script: { executionId: string } }
    | { type: "scripts:progress"; script: { executionId: string; message: string } }
    | { type: "scripts:completed"; script: { executionId: string } }
    | { type: "scripts:failed"; script: { executionId: string } };
```

Events are minimal (just `executionId` + optional `message`) — consistent with other domain SSE events. The
frontend invalidates execution queries on any script SSE event. Progress events update the sidebar inline.

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
        case "scripts:progress":
            // Progress messages are handled by the sidebar directly via SSE listener
            break;
    }
}
```

## Backend Structure

```
apps/api/src/lib/document/                  # Document Content Layer (shared by SDK, export, import, preview)
  doc-reader.ts         # readDocContent() — Yjs → ProseMirror JSON + plain text
  doc-writer.ts         # writeDocContent() — ProseMirror JSON → Yjs update (for import)
  sheets-reader.ts      # readSheetContent() — Yjs → SheetContent with cell values/formulas
  sheets-writer.ts      # writeSheetContent() — SheetContent → Yjs update (for import)

apps/api/src/lib/scripts/
  scripts.ts            # Scripts domain class (CRUD, execution lifecycle)
  db-config.ts          # Drizzle schema + versioned migrations
  schema.ts             # Drizzle table definitions
  script-runner.ts      # Spawns + manages Deno subprocesses directly
  runner.ts             # Deno runner (Proxy SDK + console capture + script execution)
  sdk-handler.ts        # SDK_METHODS registry — delegates to document readers + domain classes
  sse-events.ts         # SSE event builders for script domain

apps/api/src/routes/
  scripts.ts            # Elysia router (CRUD, execute, cancel, list)

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

The `runner.ts` file lives alongside the script runner in `apps/api/src/lib/scripts/` and is copied into the
Docker image with the rest of the API build.

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
| Execution timeout | 120 s | ScriptRunner (wall-clock `proc.kill()`) |
| Heap memory | 128 MB | Deno `--v8-flags=--max-heap-size=128` |
| Execution history | 200 per script | `completeExecution()` pruning |
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

This is **the** path for accessing document content — both from scripts and from other backend systems.
There is no separate frontend path for reading document data. Scripts always read via the backend SDK
(which uses this layer), ensuring consistent behavior whether triggered from a sidebar, cron job, or event.

### The Problem

`drive.readFile()` returns raw file data — useless for Yjs-backed documents. A scripting SDK that can only
read binary Yjs blobs is not a real API. Export, preview, and import all need the same thing: structured
access to document content. Today, `loadEigendocContent()` in the export system does this for docs only. No
equivalent exists for sheets, slides, or stickies.

### Architecture

```
SDK / Export / Preview / Import / Search
          ↓
Document Content Layer (backend)
  readDocContent()  / readSheetContent()
          ↓
Yjs database (data.db) → yjs-loader.ts → Y.Doc → structured content
```

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

**Sheets A1 notation:** The SDK handler parses A1 notation (e.g., `"A1"`, `"B2:D10"`, `"Sheet2!A1:C5"`)
into numeric row/col/range and delegates to `readSheetContent()`. Parsing is trivial
(`/^([A-Z]+)(\d+)$/` → col/row conversion) and lives in a shared utility.

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

const doc = eigen.docs.getActive();
const text = await doc.getText();
// → "Hello world\nSecond paragraph..."

const json = await doc.getJson();
// → { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }] }

// Read a different document
const other = eigen.docs.getById({ mountId: "...", pathId: "..." });
const otherText = await other.getText();

// Team document
const teamDoc = eigen.docs.getById({ ownerId: "team_abc", mountId: "...", pathId: "..." });

// --- Sheets ---

const sheet = eigen.sheets.getActive();

// A1 notation — mirrors Google Sheets
const val = await sheet.getCell("A1");
// → 42

// With render option (like Google's ValueRenderOption)
const formula = await sheet.getCell("A1", { render: "formula" });
// → "=SUM(A1:A5)"

const display = await sheet.getCell("A1", { render: "formatted" });
// → "$42.00"

// Range — returns 2D array of computed values
const values = await sheet.getRange("A1:D10");
// → [[1, "Alice", 95], [2, "Bob", 87], ...]

// Full sheet data — returns all non-empty cells with value + formula + display
const data = await sheet.getSheetData({ sheet: 0 });
// → { id, name, cells: [{ row, col, value, formula, display, type }], config }

// Read a different spreadsheet
const other = eigen.sheets.getById({ mountId: "...", pathId: "..." });
const otherValues = await other.getRange("A1:B5");
```

### ScriptActions for Document Writes

Write operations on the currently-open document go through `applyResults()` on the context provider. The
provider dispatches to the live editor — no backend round-trip needed.

```javascript
// Docs — insert structured ProseMirror content
return [{ action: "insertContent", content: {
    type: "paragraph",
    content: [{ type: "text", text: "Generated by script" }]
}}];

// Sheets — set a single cell
return [{ action: "setCellValue", sheet: 0, row: 5, col: 0, value: 42 }];

// Sheets — set a range (row-major 2D array)
return [{ action: "setCellRange", sheet: 0, row: 0, col: 0, values: [
    ["Name", "Score", "Grade"],
    ["Alice", 95, "A"],
    ["Bob", 87, "B+"],
]}];

// Multiple actions in one execution
return [
    { action: "setCellValue", sheet: 0, row: 5, col: 0, value: 42 },
    { action: "notify", message: "Updated cell A6" },
];
```

Backend SDK write methods (`docs.insertContent`, `sheets.setCell`) are Phase 2 — they apply Yjs
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
  a1-notation.ts        # parseA1Notation() — A1 → numeric row/col conversion

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
- `runner.ts` (Proxy SDK with document object model + flat domain proxies + console capture + utils)
- `sdk-handler.ts` (single `SDK_METHODS` registry)
- SSE events for execution lifecycle (including progress)
- Routes: CRUD, execute, cancel, list
- Personal scope only

**Document Content Layer:**
- `readDocContent()` — refactored from existing `loadEigendocContent()` (Yjs → PM JSON + text)
- `readSheetContent()` — new (Yjs → SheetContent with cell values/formulas/display)
- `a1-notation.ts` — A1 notation parser for sheets SDK methods
- Shared types: `DocContent`, `SheetContent`, `CellData` in `packages/lib/src/types/document.ts`
- Export system refactored to use `readDocContent()` as shared reader

**SDK (read-only):**
- `eigen.docs.getActive()` / `eigen.docs.getById({...})` — document proxies. Methods: `getText`, `getJson`
- `eigen.sheets.getActive()` / `eigen.sheets.getById({...})` — sheet proxies. Methods: `getCell` (A1 notation),
  `getRange` (A1 notation), `getSheetData`. Render options: `"value"` (default), `"formula"`, `"formatted"`
- `eigen.drive.*` — flat proxy, auto-injects ownerId. Methods: `listFolder`, `getPath`, `readFile`
- `eigen.fetch()` — external API calls (domain-restricted via Deno `--allow-net`)
- `eigen.progress(message)` — real-time progress via SSE
- `eigen.utils.sleep(ms)` — pause execution
- `console.log/warn/error` — captured locally with `JSON.stringify` for objects
- `eigen.context` — selection state from frontend (not document content)
- `eigen.config` — persisted per-script config
- `eigen.user` — current user
- Structured error codes: `NOT_FOUND`, `PERMISSION_DENIED`, `QUOTA_EXCEEDED`, `INVALID_PARAMS`, `INTERNAL`

**Frontend:**
- Scripts app: list view + CodeMirror editor + "Run" button + output panel
- `ScriptsPanel` in `packages/ui` (PropertiesPanel-based sidebar)
- `ScriptContextProvider` interface (selection state only, no document content)
- Context providers for Docs (`selection` + `replaceSelection`, `insertText`, `insertContent`)
  and Drive (`selectedFiles` + `notify`)
- Toolbar integration: `Code` icon button (alongside existing comment button)

### Phase 2 — Worker + Triggers + Writes + Import

- **Worker process extraction** — move Deno management to dedicated Bun worker with IPC, add execution queue
  and per-user concurrency limits
- **Cron triggers** — `Bun.cron()` per trigger, server-level `cron_triggers` index in `eigen.db`
- **Event-driven triggers** — listener on `Home.broadcast()`, dispatches matching script executions
- **Write SDK operations**: `drive.writeFile`, `drive.create`, `docs.insertContent`,
  `sheets.setCell`, `sheets.setCellRange` — with quota enforcement and ACL validation
- **DocumentWriters**: `writeDocContent()`, `writeSheetContent()` — for SDK writes and import
- **File import**: DOCX → `DocContent` → `writeDocContent()`, XLSX → `SheetContent` → `writeSheetContent()`
- **User-scoped properties** — per-user config for shared scripts (like Google's `UserProperties`)
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
- Custom sheet functions (batch evaluation of `=EIGEN_FUNC()` cells via scripting engine)

## Google Apps Script Comparison

Key design decisions mapped to Google's equivalents:

| Concept | Google Apps Script | Eigen SDK | Notes |
|---|---|---|---|
| Active document | `SpreadsheetApp.getActive()` | `eigen.sheets.getActive()` | Same pattern |
| Open by ID | `SpreadsheetApp.openById(id)` | `eigen.sheets.getById({mountId, pathId})` | Eigen uses mountId+pathId instead of single ID |
| Cell access | `sheet.getRange("A1").getValue()` | `sheet.getCell("A1")` | Simpler — no intermediate Range object |
| Range access | `sheet.getRange("A1:C10").getValues()` | `sheet.getRange("A1:C10")` | Returns 2D array directly |
| Display values | `range.getDisplayValues()` | `sheet.getCell("A1", { render: "formatted" })` | Param-based vs separate method |
| Document text | `doc.getBody().getText()` | `doc.getText()` | Flatter — no Body intermediate |
| HTTP requests | `UrlFetchApp.fetch(url, params)` | `eigen.fetch(url, opts)` | Standard fetch API (Deno native) |
| Script storage | `PropertiesService` (3 scopes) | `eigen.config` (script scope) | Phase 2 adds user scope |
| Sleep | `Utilities.sleep(ms)` | `eigen.utils.sleep(ms)` | Async (Promise-based) vs synchronous |
| Triggers | `ScriptApp.newTrigger().timeBased().everyHours(1).create()` | Cron expressions in manifest | Cron is more powerful, builder is more ergonomic |
| Custom functions | `@customfunction` in cells | Phase 3 | Hard with subprocess model |
| Runtime | V8 (synchronous, no modules, no fetch) | Deno (async, modern JS, native fetch) | Eigen's runtime is strictly superior |

## What Is NOT In Scope

- Public marketplace / script registry
- Collaborative script editing (single author edits at a time)
- TypeScript in-browser (scripts are plain JS; TS support is future)
- Script-to-script communication
- Billing/quota per script execution
