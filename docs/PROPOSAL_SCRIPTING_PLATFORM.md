# Eigen Scripting Platform

A server-side scripting and extension system for eigen, enabling users to write scripts that extend functionality.
Scripts run in long-lived Deno worker processes, communicate with eigen via Content-Length-framed JSON-RPC,
and integrate with frontend apps through a shared sidebar. Inspired by Google Apps Script.

## Trust Model

Scripts are **trusted-by-author** code. The author can already do everything in their workspace via the API; a
script just lets them automate it. The boundary we enforce is:

- Scripts execute as the user who triggered them. SDK calls go through the same ACL checks as regular API calls,
  so a script cannot read data its triggering user couldn't read by hand
- Permission tokens declared in the manifest scope what the script *can* request. Manifest changes require a
  re-confirmation in the UI
- Process-level isolation contains crashes, runaway loops, and unintended resource use — not hostile escapes
- Workers run with `--no-prompt --deny-write --deny-env --deny-ffi --deny-run` plus a network allowlist derived
  from the manifest

We do NOT promise:

- Containment of code that *tries* to escape the runtime. Deno's permission model has had multiple bypass CVEs
  in the last six months (CVE-2025-61786, -61785, -61787, -55182). DNS rebinding against `--allow-net` allowlists
  is a known unfixed gap. `--v8-flags=--max-heap-size=N` is enforced by aborting the process, not by throwing,
  and external memory (TypedArrays from Rust, V8 LOS) is not counted toward the cap
- Containment of malicious scripts authored elsewhere and pasted in. Phase 1 scope is "I write scripts to extend
  my own workspace"

If a future Phase ever supports a public marketplace, the runtime will need OS-level controls (cgroups, network
namespaces, separate Linux user). Phase 1 builds the Deno-subprocess model because it is the right least-privilege
*convenience* for trusted code, not because it is a real sandbox.

## Core Decisions

- **Runtime**: Deno worker pool — each pool slot is a long-lived Deno process; one execution at a time per slot,
  killed and respawned between executions to enforce wall-clock timeouts
- **Sandboxing**: Process-level isolation plus Deno permission flags. SDK calls bridge back to eigen via
  stdin/stdout JSON-RPC framed with `Content-Length` headers (LSP-style)
- **Execution model**: Fully asynchronous — `POST /execute` returns immediately with an execution ID; progress
  and results arrive via SSE. No HTTP request blocks on script execution
- **SDK design**: Google Apps Script–inspired object model. Document types (docs, sheets, slides) use
  `eigen.docs.getActive()` / `eigen.docs.getById({...})` returning document proxies with chainable methods. Flat
  domains (drive, mail, calendar) use `eigen.drive.method(params)`. All data access goes through the backend —
  scripts always read via the SDK, never via a frontend cache
- **API access**: Scripts declare permissions in a manifest, enforced at three levels (Deno flags, SDK call
  validation, ACL checks against executing user)
- **Triggers**: Manual (Phase 1), cron-based and event-driven (Phase 2)
- **Distribution**: Personal scope (Phase 1), team and org scoping (Phase 2)
- **UI integration**: Shared `ScriptsPanel` sidebar in apps that opt in (like the comments panel), plus
  context-aware script actions

### Why Deno Worker Pool

- **Node `vm`** is explicitly not a security mechanism — code escapes via prototype-chain traversal
- **`isolated-vm`** is a native V8 addon, incompatible with Bun's JavaScriptCore engine
- **Deno subprocess** gives us a separate OS process with permission flags that map to manifest tokens. Single
  binary dependency, works regardless of eigen's runtime
- **Long-lived workers vs spawn-per-execution**: cold start of `deno run` is ≈130–150 ms before the first JS line
  runs (Deno's own AWS Lambda benchmarks). For sidebar UX where a user clicks "Translate selection" and waits, a
  per-execution spawn adds 150–400 ms of dead time before the script does anything. A pre-warmed pool of N
  worker processes amortizes cold start across many executions; killing and respawning the slot after each
  execution preserves the timeout guarantee

## Architecture

### Process Model (Phase 1)

```
Main API (Bun, port 8000)
├── Scripts domain class        (CRUD for scripts/executions, personal DB)
├── Script routes               (HTTP API — create, edit, run, list extensions)
├── ScriptWorkerPool            (manages N pre-warmed Deno workers, dispatches
│                                executions, kills+respawns slots between runs)
└── SDK handler                 (fulfills RPC calls against Home instances)

Deno worker (one per pool slot)
├── Build SDK via Proxy          (eigen.docs.getActive(), eigen.drive.*, etc.)
├── Override console.log/warn/error → capture in capped logLines buffer
├── Execute script source via new Function() (string) when "exec" message arrives
└── Return result or error via Content-Length-framed JSON
```

The pool is a `Map<slotId, { proc, busy, currentExecutionId }>`. `runScript()` picks an idle slot, sends an
`exec` message, awaits completion, then kills and respawns the slot. Killing between executions guarantees the
timeout, prevents memory accumulation, and avoids state leakage across users (since one user's script ran in
that slot last). The respawn happens in the background while the next request can pick a different idle slot.

### Process Model (Phase 2 — Worker Extraction)

```
Main API (Bun, port 8000)
├── Scripts domain class
├── Script routes
└── ScriptBridge                (IPC bridge to worker)

Script Worker (separate Bun process, spawned at API startup)
├── ScriptWorkerPool             (moved from main API)
├── Execution queue              (per-user concurrency limit, FIFO)
├── Cron scheduler               (Bun.cron handlers in this process)
└── SDK handler                  (still calls back into main API for Home access)
```

Phase 2 extracts the pool and queue into a separate Bun process so script CPU and memory don't compete with
HTTP request handling. The Deno-management code moves unchanged; only the communication layer changes from
direct calls to IPC.

### Data Flow — Script Execution

Execution is fully asynchronous. The HTTP request never blocks on script execution.

```
1. User clicks "Run" → POST /scripts/:ownerId/execute/:scriptId
   → Response: { executionId, status: "running" }  (returned immediately)

2. Main API: Scripts.createExecution() writes a row with status="running"
   ScriptWorkerPool.dispatch() picks an idle worker slot, sends exec init

3. Deno worker: receives init, builds SDK via Proxy, executes script

   SDK call flow (e.g. eigen.drive.listFolder({ mountId, pathId })):
   a. Script calls eigen.drive.listFolder({ mountId, pathId })
   b. Proxy intercepts → RPC stdout: { id: 1, method: "drive.listFolder",
                                       params: { ownerId, mountId, pathId } }
      (ownerId auto-injected from eigen.user.id)
   c. ScriptWorkerPool reader resolves via SDK handler:
      validateOwnerAccess(executingUser, params.ownerId) → getHome(params.ownerId) →
      handler function → result
   d. Pool writes Content-Length-framed response to worker stdin: { id: 1, result: [...] }
   e. Worker resolves RPC promise → script receives file list

   Document call flow (e.g. eigen.docs.getActive().getText()):
   a. eigen.docs.getActive() returns a Proxy with mountId/pathId baked in from context
   b. .getText() → RPC stdout: { id: 2, method: "docs.getText",
                                 params: { ownerId, mountId, pathId } }
   c. Pool: validate access → getHome(ownerId) → readDocContent(...) → { text, json }
   d. Returns text to worker

4. Script finishes → worker sends { type: "done", result, log }
5. ScriptWorkerPool: Scripts.completeExecution() updates DB row
   home.broadcast(buildScriptEvent("scripts:completed", { executionId }))
   → kill the slot, respawn a fresh worker in the background

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
6. [Script runs — calls eigen.fetch() to translate. Document reads go through backend SDK.]
7. SSE event: scripts:completed { executionId }
8. Sidebar fetches execution result: [{ action: "replaceSelection", value: "Bonjour le monde" }]
9. Sidebar calls docsContextProvider.applyResults(results)
   → dispatches ProseMirror transaction replacing selection
```

The frontend context provides only **selection state** (what the user has selected, which only the frontend
knows). Document content reads always go through the backend SDK, which reads from Yjs. This means the same
script code works identically whether triggered from a sidebar or a cron job.

## Data Model

Per-user database at `{home}/eigen.scripts/scripts.db`, managed via `ManagedDatabase` with versioned migrations.
Path follows the existing eigen convention (`eigen.mail/mail.db`, `eigen.calendar/calendar.db`, etc.). For
future team/org scope, the same DB structure lives in TeamHome/OrgHome.

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

The `config` column stores user-provided values that persist across executions. Stored as plaintext in the
user's personal DB — a dedicated secrets store is a future enhancement.

### `executions`

| Column | Type | Notes |
|--------|------|-------|
| id | text PK | nanoid |
| scriptId | text FK | |
| status | text | `pending`, `running`, `completed`, `failed`, `timeout`, `cancelled` |
| startedAt | integer | Epoch ms |
| finishedAt | integer | Epoch ms, nullable |
| durationMs | integer | Nullable |
| log | text | Captured console output (truncated to 64 KB) |
| error | text | Error message + code if failed, nullable |
| result | text (JSON) | Return value from script, nullable |

Execution records are pruned automatically: max 200 per script, oldest deleted first. Pruning runs on
`completeExecution()`.

**Recovery on startup**: when `Scripts.init()` runs (Home cold-start), every `running` or `pending` execution
in the DB is marked `failed` with `error: "API restarted before completion"`. Without this, an API restart
mid-execution leaves the row "running" forever.

### `triggers` (Phase 2)

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
| cron | text | Cron expression (e.g. `"0 9 * * MON-FRI"`) — interpreted as UTC |
| enabled | integer | |

CRUD operations on triggers update both the user's `scripts.db` and this server-level index atomically.

### `installations` (Phase 2)

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

### ScriptWorkerPool

The pool maintains N pre-warmed Deno worker processes. Each worker reads
Content-Length-framed JSON-RPC messages from stdin and writes results to stdout. Workers are killed and
respawned between executions to enforce wall-clock timeouts and prevent state leakage.

```typescript
// apps/api/src/lib/scripts/script-worker-pool.ts

const POOL_SIZE = 4;  // Phase 1 default; tune later

type Slot = {
    id: number;
    proc: Subprocess;
    busy: boolean;
    currentExecutionId: string | null;
    pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
};

const slots: Slot[] = [];

export async function initPool(): Promise<void> {
    for (let i = 0; i < POOL_SIZE; i++) {
        slots.push(await spawnSlot(i));
    }
}

async function spawnSlot(id: number): Promise<Slot> {
    const runnerPath = path.resolve(import.meta.dir, "runner.js");
    // Process group via setsid so we can kill grandchildren if the worker spawns any
    const proc = Bun.spawn([
        "setsid", "deno", "run",
        `--allow-read=${runnerPath}`,
        "--deny-write",
        "--deny-env",
        "--deny-ffi",
        "--deny-run",
        "--no-prompt",
        "--v8-flags=--max-heap-size=128",
        "--allow-net",  // Network gating happens per-execution; see below
        runnerPath,
    ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });

    const slot: Slot = { id, proc, busy: false, currentExecutionId: null, pending: new Map() };
    readSlotStdout(slot);
    return slot;
}

export async function runScript(req: ExecutionRequest): Promise<void> {
    const slot = await acquireIdleSlot();
    slot.busy = true;
    slot.currentExecutionId = req.executionId;

    const timer = setTimeout(() => completeExecution(req.executionId, "timeout"), req.timeout);

    try {
        await sendFramed(slot.proc.stdin, {
            type: "exec",
            executionId: req.executionId,
            source: req.source,
            context: req.context,
            permissions: req.permissions,
            allowedDomains: getNetworkAllowlist(req.permissions),
            function: req.function ?? "onRun",
        });
        // result comes back via readSlotStdout → completeExecution()
    } finally {
        // Slot is recycled (killed + respawned) inside completeExecution()
        clearTimeout(timer);
    }
}

export function cancelExecution(executionId: string): boolean {
    const slot = slots.find(s => s.currentExecutionId === executionId);
    if (!slot) return false;
    recycleSlot(slot, "cancelled");
    return true;
}

async function recycleSlot(slot: Slot, reason: ExecutionStatus): Promise<void> {
    if (slot.currentExecutionId) {
        await completeExecution(slot.currentExecutionId, reason);
    }
    // Kill the entire process group to clean up any grandchildren
    process.kill(-slot.proc.pid!, "SIGKILL");
    slot.proc.kill();
    const newSlot = await spawnSlot(slot.id);
    Object.assign(slot, newSlot);
}
```

**Lifecycle:**
- `initPool()` runs at API startup, spawns N workers
- `runScript()` acquires an idle slot, sends the `exec` message via Content-Length framing
- SDK calls from the worker are read by `readSlotStdout`, dispatched through the SDK handler
- On completion/error/timeout/cancel: `recycleSlot()` kills the slot's process group and respawns
- On API shutdown: kill all slots cleanly

### Deno Worker Constraints

| Constraint | Value | Rationale |
|---|---|---|
| Wall clock timeout | 120 s default | `recycleSlot()` on `setTimeout` |
| Heap memory (advisory) | 128 MB | `--v8-flags=--max-heap-size=128`. Process aborts on overflow — not catchable |
| Filesystem read | runner.js only | `--allow-read=<runner-path>` |
| Filesystem write | none | `--deny-write` |
| Environment vars | none | `--deny-env` |
| FFI | none | `--deny-ffi` |
| Subprocess spawn | none | `--deny-run` |
| Network | per-execution allowlist | `--allow-net` is broad at process startup; per-execution we wrap `fetch` in the SDK to check the manifest's `fetch` permission and a domain allowlist before dispatching the request |

The `--allow-net` flag at process start is intentionally broad; effective allowlisting happens in
`eigen.fetch()`'s SDK wrapper, which checks the manifest. This keeps the worker binary identical across
executions while letting per-script permissions vary.

### Runner (`runner.js`)

The runner executes inside the Deno worker. It is shipped as plain JavaScript (no TypeScript compile cost on
worker startup) and stays alive across executions. It provides a Google Apps Script–inspired SDK with two
patterns:

- **Document domains** (docs, sheets, slides): `eigen.docs.getActive()` / `eigen.docs.getById({...})` return
  document proxies. The proxy auto-injects `mountId/pathId`
- **Flat domains** (drive, mail, calendar, contacts): `eigen.drive.method(params)` — direct RPC dispatch

All SDK calls go through the same JSON-RPC bridge. The runner never enumerates methods — adding new backend
capabilities requires zero runner changes.

Console output is captured locally in a capped `logLines` buffer (max 64 KB, lines beyond that replaced with
`[…log truncated]`). Objects are serialized via `JSON.stringify` for readable output.

```javascript
// apps/api/src/lib/scripts/runner.js — runs inside the Deno worker, lives across executions

// --- Content-Length framed I/O (LSP-style, immune to embedded newlines) ---

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

function writeFramed(data) {
    const body = encoder.encode(JSON.stringify(data));
    const header = encoder.encode(`Content-Length: ${body.byteLength}\r\n\r\n`);
    Deno.stdout.writeSync(header);
    Deno.stdout.writeSync(body);
}

let buf = new Uint8Array(0);
async function readFramed() {
    while (true) {
        const sep = findSeparator(buf);
        if (sep >= 0) {
            const headerStr = decoder.decode(buf.subarray(0, sep));
            const m = headerStr.match(/Content-Length:\s*(\d+)/i);
            if (!m) throw new Error("missing Content-Length");
            const len = parseInt(m[1], 10);
            const start = sep + 4;
            while (buf.byteLength < start + len) buf = await readMore(buf);
            const body = JSON.parse(decoder.decode(buf.subarray(start, start + len)));
            buf = buf.subarray(start + len);
            return body;
        }
        buf = await readMore(buf);
    }
}

// --- Per-execution state ---

let nextId = 1;
let pending = new Map();
let logLines = [];
let logBytes = 0;
const LOG_CAP = 64 * 1024;

function rpc(method, params) {
    const id = nextId++;
    writeFramed({ id, method, params });
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

// Background reader for SDK responses + control messages
(async () => {
    while (true) {
        const msg = await readFramed();
        if (msg.type === "exec") { runExecution(msg); continue; }
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        if (msg.error) {
            const err = new Error(msg.error.message);
            err.code = msg.error.code;
            p.reject(err);
        } else {
            p.resolve(msg.result);
        }
    }
})();

// --- Console capture ---

const stringify = (v) =>
    typeof v === "object" && v !== null ? JSON.stringify(v, null, 2) : String(v);

function appendLog(prefix, args) {
    if (logBytes >= LOG_CAP) return;
    const line = prefix + args.map(stringify).join(" ");
    logBytes += line.length + 1;
    logLines.push(logBytes >= LOG_CAP ? "[…log truncated]" : line);
}

globalThis.console = {
    ...console,
    log: (...args) => appendLog("", args),
    warn: (...args) => appendLog("[warn] ", args),
    error: (...args) => appendLog("[error] ", args),
};

// --- SDK: Document proxy (docs, sheets, slides) ---
// Mirrors Google Apps Script: SpreadsheetApp.getActive() / SpreadsheetApp.openById()

function createDocProxy(domain, mountId, pathId, ownerId) {
    return new Proxy({}, {
        get(_, method) {
            if (typeof method !== "string") return undefined;
            return (params = {}) => {
                const base = { ownerId, mountId, pathId };
                if (typeof params === "string") return rpc(`${domain}.${method}`, { ...base, cell: params });
                return rpc(`${domain}.${method}`, { ...base, ...params });
            };
        },
    });
}

function createDocDomain(domain, ctx) {
    return {
        getActive() {
            if (!ctx.mountId || !ctx.pathId) {
                throw new Error(`No active ${domain} document in current context`);
            }
            return createDocProxy(domain, ctx.mountId, ctx.pathId, ctx.user.id);
        },
        getById(ids) {
            return createDocProxy(domain, ids.mountId, ids.pathId, ids.ownerId || ctx.user.id);
        },
    };
}

function createDomainProxy(domain, ctx) {
    return new Proxy({}, {
        get(_, method) {
            if (typeof method !== "string") return undefined;
            return (params = {}) =>
                rpc(`${domain}.${method}`, { ownerId: ctx.user.id, ...params });
        },
    });
}

// --- Per-execution entry point ---

async function runExecution(msg) {
    nextId = 1;
    pending = new Map();
    logLines = [];
    logBytes = 0;

    const ctx = msg.context;
    const eigen = Object.freeze({
        docs: createDocDomain("docs", ctx),
        sheets: createDocDomain("sheets", ctx),
        slides: createDocDomain("slides", ctx),
        drive: createDomainProxy("drive", ctx),
        calendar: createDomainProxy("calendar", ctx),
        mail: createDomainProxy("mail", ctx),
        contacts: createDomainProxy("contacts", ctx),
        fetch: (url, opts) => rpc("net.fetch", { url, opts }),  // gated by SDK handler
        progress: (message) => writeFramed({ type: "progress", executionId: msg.executionId, message }),
        utils: Object.freeze({
            sleep: (ms) => new Promise(r => setTimeout(r, ms)),
        }),
        context: ctx,
        config: ctx.config || {},
        user: ctx.user,
    });
    Object.defineProperty(globalThis, "eigen", {
        value: eigen, writable: false, configurable: false,
    });

    try {
        // new Function avoids data-URI size limits and TS-compile cost
        const fn = new Function(`${msg.source}; return typeof ${msg.function} === "function" ? ${msg.function} : null;`);
        const userFn = fn();
        if (!userFn) throw new Error(`Script does not export a function named "${msg.function}"`);
        const result = await userFn();
        writeFramed({ type: "done", executionId: msg.executionId, result, log: logLines.join("\n") });
    } catch (e) {
        writeFramed({
            type: "error",
            executionId: msg.executionId,
            error: e.message,
            code: e.code,
            stack: e.stack,
            log: logLines.join("\n"),
        });
    }
    // The pool will kill+respawn this slot regardless; no need to clean up state here.
}
```

**Key design points:**
- **Frozen `eigen` global** with `defineProperty({ writable: false, configurable: false })` — script code cannot
  reassign or delete it. Same for `eigen.utils`
- **`fetch` is RPC'd, not native** — the host enforces per-script domain allowlist before issuing the actual
  request. This is the security gate, not the Deno `--allow-net` flag
- **Document domains**: `getActive()` returns a Proxy with context `mountId/pathId` baked in. `getById({...})`
  returns a Proxy with explicit IDs. Mirrors `SpreadsheetApp.getActive()` / `SpreadsheetApp.openById()`
- **Flat domains**: `eigen.drive.listFolder({ mountId, pathId })` becomes
  `rpc("drive.listFolder", { ownerId: user.id, mountId, pathId })`. ownerId can be overridden for team data,
  but the host validates the executing user has access to that owner
- **String shorthand**: `sheet.getCell("A1")` auto-wraps as `{ cell: "A1" }` in the RPC params
- **`new Function(source)` over `import("data:...")`** — avoids data-URI size limits and parse overhead

### SDK Handler

The main API fulfills SDK calls from the worker. Each method is registered with its permission requirement,
a Zod schema for params, and a typed handler. Method names arrive as `"domain.method"`.

```typescript
// apps/api/src/lib/scripts/sdk-handler.ts

import { z } from "zod";
import { getSharedDrive } from "../drive";
import { resolveCalendar } from "../calendar/get-calendar";
import { requireOwnerAccess } from "../core/access";
import { readDocContent, readSheetContent, readSlidesContent,
         readSheetCellValue, readSheetRange } from "./sdk-readers";

const SDK_ERROR = {
    NOT_FOUND: "NOT_FOUND",
    SCRIPT_PERMISSION_DENIED: "SCRIPT_PERMISSION_DENIED",  // manifest token missing
    RESOURCE_PERMISSION_DENIED: "RESOURCE_PERMISSION_DENIED",  // ACL denial — no access to this resource for this user
    QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
    INVALID_PARAMS: "INVALID_PARAMS",
    INTERNAL: "INTERNAL",
} as const;

type SDKMethod<P> = {
    permission: string;
    params: z.ZodType<P>;
    // Handlers receive the executing User and choose the right per-domain resolver
    // (getSharedDrive, resolveCalendar, requireOwnerAccess + getHome). The SDK
    // layer doesn't reimplement ACL — it delegates to the same helpers routes use.
    handler: (user: User, params: P) => Promise<unknown>;
};

const ownerScoped = z.object({ ownerId: z.string() });
const docScoped = ownerScoped.extend({ mountId: z.string(), pathId: z.string() });

const SDK_METHODS: Record<string, SDKMethod<unknown>> = {
    // Drive — getSharedDrive enforces ACL (own drive vs shared-with-me) the same
    // way drive routes do. Returns Drive | SharedDrive transparently.
    "drive.listFolder": {
        permission: "drive:read",
        params: ownerScoped.extend({ mountId: z.string(), pathId: z.string().optional() }),
        handler: async (user, p) => {
            const drive = await getSharedDrive(p.ownerId, user);
            return drive.getFolderContents(p.mountId, p.pathId);
        },
    },
    "drive.getPath": {
        permission: "drive:read",
        params: ownerScoped.extend({ mountId: z.string(), pathId: z.string() }),
        handler: async (user, p) => {
            const drive = await getSharedDrive(p.ownerId, user);
            return drive.getPath(p.mountId, p.pathId);
        },
    },
    "drive.readFile": {
        permission: "drive:read",
        params: ownerScoped.extend({ mountId: z.string(), pathId: z.string() }),
        handler: async (user, p) => {
            const drive = await getSharedDrive(p.ownerId, user);
            return drive.downloadFile(p.mountId, p.pathId);
        },
    },

    // Document readers — pass user through so they go via getSharedDrive internally,
    // matching how editor routes (apps/api/src/routes/editor.ts) read documents.
    "docs.getText": {
        permission: "drive:read",
        params: docScoped,
        handler: async (user, p) => (await readDocContent(user, p.ownerId, p.mountId, p.pathId)).text,
    },
    "docs.getJson": {
        permission: "drive:read",
        params: docScoped,
        handler: async (user, p) => (await readDocContent(user, p.ownerId, p.mountId, p.pathId)).json,
    },

    "sheets.getCell": {
        permission: "drive:read",
        params: docScoped.extend({ cell: z.string(), render: z.enum(["value","formula","formatted"]).optional() }),
        handler: (user, p) => readSheetCellValue(user, p.ownerId, p.mountId, p.pathId, p.cell, p.render),
    },
    "sheets.getRange": {
        permission: "drive:read",
        params: docScoped.extend({ cell: z.string(), render: z.enum(["value","formula","formatted"]).optional() }),
        handler: (user, p) => readSheetRange(user, p.ownerId, p.mountId, p.pathId, p.cell, p.render),
    },
    "sheets.getSheetData": {
        permission: "drive:read",
        params: docScoped.extend({ sheet: z.number().optional() }),
        handler: async (user, p) =>
            (await readSheetContent(user, p.ownerId, p.mountId, p.pathId)).sheets[p.sheet ?? 0],
    },

    "slides.getDeck": {
        permission: "drive:read",
        params: docScoped,
        handler: async (user, p) => (await readSlidesContent(user, p.ownerId, p.mountId, p.pathId)).deck,
    },

    // Network — no ownerId, no ACL; manifest domain allowlist is enforced inside proxyFetch.
    "net.fetch": {
        permission: "fetch",
        params: z.object({ url: z.string(), opts: z.unknown().optional() }),
        handler: (_, p) => proxyFetch(p.url, p.opts),
    },

    // Phase 2 examples — calendar uses resolveCalendar (mirrors apps/api/src/routes/calendar.ts):
    //   "calendar.listEvents": {
    //       permission: "calendar:read",
    //       params: ownerScoped.extend({ calendarId: z.string() }),
    //       handler: async (user, p) => {
    //           const cal = await resolveCalendar(user, p.ownerId);
    //           return cal.listEvents(p.calendarId);
    //       },
    //   },
};

export async function executeSDKMethod(
    method: string,
    params: Record<string, unknown>,
    permissions: string[],
    executingUser: User,
): Promise<unknown> {
    const entry = SDK_METHODS[method];
    if (!entry) {
        return errorResponse(SDK_ERROR.INVALID_PARAMS, `Unknown method: ${method}`);
    }
    if (!permissions.includes(entry.permission)) {
        return errorResponse(SDK_ERROR.SCRIPT_PERMISSION_DENIED,
            `${method} requires permission "${entry.permission}"`);
    }

    const parsed = entry.params.safeParse(params);
    if (!parsed.success) {
        return errorResponse(SDK_ERROR.INVALID_PARAMS, parsed.error.message);
    }

    try {
        return { result: await entry.handler(executingUser, parsed.data as never) };
    } catch (e) {
        if (e instanceof ApiError) {
            const code = e.status === 404 ? SDK_ERROR.NOT_FOUND
                : e.status === 403 ? SDK_ERROR.RESOURCE_PERMISSION_DENIED
                : e.status === 507 ? SDK_ERROR.QUOTA_EXCEEDED
                : SDK_ERROR.INTERNAL;
            return errorResponse(code, e.message);
        }
        return errorResponse(SDK_ERROR.INTERNAL, "Internal error");
    }
}

function errorResponse(code: string, message: string) {
    return { error: { code, message } };
}
```

**No new ACL implementation.** The SDK handler delegates to the same primitives the route layer uses today,
so a script's view of resources is identical to a hand-crafted API call from the same user:

| Domain | Resolver | Where routes use it today |
|---|---|---|
| Drive (incl. doc/sheets/slides readers) | `getSharedDrive(ownerId, user)` | `apps/api/src/routes/drive.ts`, `apps/api/src/routes/editor.ts` |
| Calendar | `resolveCalendar(user, ownerId)` | `apps/api/src/routes/calendar.ts` |
| Personal-only domains (notifications, settings, scripts itself) | `requireOwnerAccess(user.id, ownerId)` then `getHome(ownerId)` | A new helper in `apps/api/src/lib/core/access.ts` that dispatches via `parseOwnerId`: user → `requireSelf`, team → `requireTeamAccess`, org → org-membership check |

`requireOwnerAccess(userId, ownerId)` is the only **new** code, and it's a thin dispatcher over the existing
`requireSelf` / `requireTeamAccess` / `requireAdmin` helpers in `apps/api/src/lib/core/access.ts`. It's
useful both inside the SDK (for personal-only domains) and outside it (any future route that's owner-scoped
across multiple home types).

Cross-user shares work for free: a script run by user A reading a document user B has shared with A
succeeds — `getSharedDrive("user_b_id", userA)` returns a SharedDrive scoped to A's grants. The same code
path that powers the existing share UI powers the SDK.

**Adding a new SDK method** is one entry in `SDK_METHODS`. Pick the right resolver for the domain
(`getSharedDrive`, `resolveCalendar`, or `requireOwnerAccess`) — don't write new ACL logic.

### SDK Error Contract

Scripts receive structured errors with a `code` field. This contract is stable from Phase 1 — scripts can
rely on error codes for control flow.

```javascript
try {
    const doc = eigen.docs.getById({ mountId, pathId });
    const text = await doc.getText();
} catch (e) {
    if (e.code === "NOT_FOUND") console.log("Document not found");
    else if (e.code === "RESOURCE_PERMISSION_DENIED") console.log("No access to this document for the current user");
    else if (e.code === "SCRIPT_PERMISSION_DENIED") console.log("Script manifest lacks drive:read");
}
```

| Code | Meaning |
|---|---|
| `NOT_FOUND` | The requested resource does not exist |
| `SCRIPT_PERMISSION_DENIED` | The script's manifest does not include the required permission token |
| `RESOURCE_PERMISSION_DENIED` | The executing user has no ACL access to the requested resource (covers both "not a member of that owner" and "owner exists but no share for this resource") |
| `QUOTA_EXCEEDED` | A storage or rate limit was hit |
| `INVALID_PARAMS` | Method name unknown or params failed schema validation |
| `INTERNAL` | Unexpected server error |

New codes may be added in future SDK versions, but existing codes are never removed or renamed.

### Permission Tokens

Phase 1:

```
drive:read                  # drive.listFolder, drive.getPath, drive.readFile,
                            # docs.getText, docs.getJson,
                            # sheets.getCell, sheets.getRange, sheets.getSheetData,
                            # slides.getDeck
fetch                       # eigen.fetch() — domain allowlist enforced in net.fetch handler
```

Document read methods use the `drive:read` permission because documents are drive items — reading their
content is reading drive data. One token covers all read access.

Phase 2+:

```
drive:write                 # drive.writeFile, drive.create, docs.insertContent,
                            # sheets.setCell, sheets.setCellRange, slides.insertSlide
mail:read   | mail:send
calendar:read | calendar:write
chat:read   | chat:send
contacts:read | contacts:write
```

Enforced at three levels:
1. **Deno permissions** at process startup — coarse-grained (filesystem off, env off, etc.)
2. **SDK manifest check** — `executeSDKMethod` verifies the script's manifest grants the required token
3. **ACL via existing resolvers** — handlers call `getSharedDrive(ownerId, user)`, `resolveCalendar(user, ownerId)`,
   or `requireOwnerAccess(user.id, ownerId)` (per-domain choice). These are the same helpers route handlers
   use, so the script sees exactly what a hand-crafted API request from the same user would see — including
   cross-user shares. Failures throw `ApiError(403)`, which the SDK maps to `RESOURCE_PERMISSION_DENIED`

## Triggers

### Manual (Phase 1)

- User clicks "Run" in the Scripts app, or clicks a script action in the scripts sidebar
- Scripts export named functions: `function onRun() { ... }` is the default entry point
- Named functions like `function translateSelection() { ... }` appear as separate actions in the sidebar
- Context-aware: when triggered from a host app's sidebar, the app's current selection state is passed via
  `eigen.context`

### Cron (Phase 2)

Uses Bun's built-in `Bun.cron()` (https://bun.com/docs/runtime/cron). In-process scheduling is sufficient
since Phase 2 also extracts script management to a dedicated worker process.

**Important Bun.cron semantics to honour:**
- In-process schedules are interpreted in **UTC**. Display in the UI as UTC, document this clearly. (Local-time
  cron is only available via the OS-level form `Bun.cron(path, schedule, title)`, which we don't use.)
- Invocations **never overlap**: the next fire time is computed only after the handler's promise settles. A
  90-second handler on a `* * * * *` schedule fires at the next minute boundary *after* completion, not 60 s
  after start. This matches what we want — no per-script duplicate execution
- Schedules are lost on process restart; canonical state lives in `cron_triggers` and is re-registered on
  startup
- 5-field cron format: `minute hour day-of-month month day-of-week` — same as standard crontab. Named
  expressions (`@hourly`, `@daily`, `@weekly`) supported

**Server-level cron index**: `cron_triggers` table in `eigen.db` (alongside the share registry). Lookup table
so the scheduler doesn't scan every user's DB on startup.

**Lifecycle:**
1. **API startup**: load all enabled triggers from `cron_triggers` in `eigen.db`, register each with
   `Bun.cron(schedule, callback)`. Keep handles in a `Map<triggerId, CronJob>` for cancellation
2. **Callback fires**: `getHome(ownerId)` → `runScript()`
3. **Trigger CRUD**: update both user's `scripts.db` and server-level `cron_triggers`, then register
   `Bun.cron()` (or call `.stop()` on the existing handle for disable/delete) atomically
4. **API shutdown**: iterate the registered job map and call `.stop()` on each

```typescript
// Phase 2 sketch — runs in the script worker process
const cronJobs = new Map<string, CronJob>();

async function startCron() {
    const triggers = await loadEnabledCronTriggers();  // from eigen.db
    for (const trigger of triggers) {
        const job = Bun.cron(trigger.cron, async () => {
            const home = await getHome(trigger.ownerId);
            const script = await home.scripts.get(trigger.scriptId);
            if (script?.enabled) {
                await runScript({ ...script, ownerId: trigger.ownerId });
            }
        });
        cronJobs.set(trigger.triggerId, job);
    }
}

async function stopTrigger(triggerId: string) {
    cronJobs.get(triggerId)?.stop();
    cronJobs.delete(triggerId);
}
```

Missed runs (server down) are skipped, not queued.

### Cron Execution Identity

Personal cron triggers run **as the author**. Because no user is "active," `eigen.context.mountId/pathId`
is undefined — calls like `eigen.docs.getActive()` throw with `"No active docs document in current context"`.
Cron scripts must use `eigen.docs.getById({...})` with explicit IDs (typically stored in `eigen.config`).

Team/org cron triggers in Phase 2: pick one approach when implementing. Either run as a designated team admin
(simple, but one-user-of-record) or run as the trigger creator with team-scope ownerId access (more flexible,
needs careful permission audit).

### Event-Driven (Phase 2)

- Subscribe to existing `SSEventType` events: `drive:created`, `mail:created`, `chat:message`, etc.
- Optional filter: `{ event: "mail:created", filter: { from: "*@github.com" } }`
- Scripts service registers a listener on `Home.broadcast()` — on event, checks enabled triggers for matches
  and dispatches execution
- Asynchronous — original action is never blocked
- Deduplication: if a script is already running for the same trigger+event, the new execution is skipped

### Failure Notifications

When a cron- or event-triggered script fails, the user has no UI in front of them. The trigger callback
calls `home.notifications.persist({ type: 'scripts:failed', title, body, scriptId, executionId })` so the
user sees it in their notification center. Manual runs already surface failures via the sidebar/output panel.

## Permissions & Scoping

### Personal Scope (Phase 1)

All scripts are personal — created by the user, visible only to the author, stored in the author's
`eigen.scripts/scripts.db`. No installation required.

### Team & Org Scope (Phase 2)

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
shared script can have their own settings.

### Execution Identity

Scripts execute **as the user who triggered them**, not the author:
- Manual run → runs as the user who clicked "Run"
- Personal cron trigger → runs as author (only user who could have created it)
- Team script triggered manually by User B → runs as User B, with User B's ACL view
- Event trigger → runs as the user whose event fired

The SDK handler enforces this by passing the executing `User` into every `executeSDKMethod` call. Each
handler then resolves the resource via the same helper its corresponding routes use — `getSharedDrive`,
`resolveCalendar`, or `requireOwnerAccess` — and any ACL failure surfaces as
`RESOURCE_PERMISSION_DENIED` to the script.

### Admin Controls (Phase 2+)

- Org admins can disable scripting for the org
- Org admins can view all scripts in their org
- Org admins can kill running executions and disable scripts

## Frontend — Scripts App

New `apps/scripts/` app following standard eigen app patterns (`AppShell` + sidebar + routes).

### Script List

- Standard list view: name, last run status, enabled toggle
- "New Script" button
- Future: filter by scope (personal / team / org)

### Script Editor

- Code editor panel (CodeMirror 6, already used in `apps/drive`) with JS syntax highlighting
- Right `PropertiesPanel`: name, description, permission checkboxes, extensions editor, config key-value editor
- "Run" button with output panel below the editor (console log + result JSON)
- Future: trigger management (cron, event)

### Execution Log

- Per-script history: status, duration, timestamp
- Expandable rows: full console log, error code + message, result JSON
- "Run Now" button

## Frontend — Scripts Sidebar (`ScriptsPanel`)

A shared component in `packages/ui`, following the same `PropertiesPanel` pattern as `CommentPanel`. Each app
opts in via a toolbar toggle button.

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

Each app integrates the sidebar the same way as `CommentPanel`:

```tsx
const [scriptsPanelOpen, setScriptsPanelOpen] = useState(false);

// In toolbar
<TooltipButton
    icon={Code}
    tooltipText="Scripts"
    onClick={() => setScriptsPanelOpen(v => !v)}
    active={scriptsPanelOpen}
/>

// In layout
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
and apply results after. All document **content** reads go through the backend SDK.

```typescript
// packages/lib/src/core/scripts/context-provider.ts

type ScriptContextProvider = {
    app: string;
    getContext: () => ScriptContext;
    applyResults: (results: ScriptAction[]) => Promise<void>;
};

type ScriptContext = {
    app: string;
    mountId?: string;
    pathId?: string;
    selection?: string;                                    // Docs, Sheets, Slides, Mail, Chat
    selectedFiles?: { id: string; name: string; mimeType: string }[];  // Drive
};
```

The sidebar shows all scripts registered for the current `app` (via extensions). Scripts that need specific
context handle missing context gracefully in their code — no dynamic capability filtering.

### ScriptAction (returned by scripts)

Scripts return an **array** of actions to apply, allowing both content modification and notification in one run.

```typescript
type ScriptAction =
    | { action: "replaceSelection"; value: string }
    | { action: "insertText"; value: string; position?: "before" | "after" }
    | { action: "insertContent"; content: JSONContent }
    | { action: "setCellValue"; sheet: number; row: number; col: number; value: unknown }
    | { action: "setCellRange"; sheet: number; row: number; col: number; values: unknown[][] }
    | { action: "notify"; message: string };
```

`applyResults()` processes the array in order. Unknown actions return a structured error shown in the
scripts panel — not silently ignored.

### Phase 1 Context Providers

Phase 1 ships **Docs + Drive**. Other apps add context providers later, following the same interface.

- **Docs**: `getContext()` reads `editor.state.selection` for selected text, provides mountId/pathId.
  `applyResults()` dispatches ProseMirror transactions for `replaceSelection`, `insertText`, `insertContent`.
  Document content reads go through `eigen.docs.getActive().getText()` / `.getJson()` on the backend
- **Drive**: `getContext()` reads selected file list from DriveTable state, `applyResults()` supports `notify`
  only. Useful for file-processing scripts (analyze metadata, check naming, list contents)

### Context Per App (Eventual)

Each app eventually provides selection state and supports result actions. The Phase-1 apps are bold:

| App | Context (selection state) | Result actions |
|-----|--------------------------|----------------|
| **Docs** | `selection`, `mountId`, `pathId` | `replaceSelection`, `insertText`, `insertContent`, `notify` |
| **Drive** | `selectedFiles`, `mountId` | `notify` |
| Sheets | `selection`, `mountId`, `pathId` | `replaceSelection`, `setCellValue`, `setCellRange`, `notify` |
| Slides | `selection`, `mountId`, `pathId` | `replaceSelection`, `notify` |
| Mail | `selection` | `replaceSelection`, `notify` |
| Chat | `selection` | `replaceSelection`, `notify` |
| Calendar | — | `notify` |

## App Extensions

Scripts declare how they integrate with host apps via the `extensions` array in their manifest.

### Extension Declaration

```typescript
type ScriptExtension = {
    app: "docs" | "sheets" | "slides" | "mail" | "chat" | "calendar" | "drive" | "*";
    type: "context-action";
    label: string;
    icon: string;       // Lucide icon name
    function: string;   // Function name to call
};
```

The `"*"` app value means the script appears in all apps. This enables generic scripts like "Translate
selection" that work anywhere selection is available.

### Prompt-Based Scripts (Phase 2)

Some scripts need user input before running (e.g. target language). Scripts signal this via `input` fields:

```typescript
type ScriptExtension = {
    // ... existing fields
    input?: {
        fields: { name: string; label: string; type: "text" | "select"; options?: string[] }[];
    };
};
```

When a user clicks a script with `input`, the sidebar shows an inline form. On submit, field values merge
into `eigen.context.input`. For Phase 1, scripts that need parameters use `eigen.config` instead.

### Example: Translate Script

A script that works in any app supporting selection + replaceSelection:

```javascript
// Name: "Translate to French"
// Permissions: ["fetch"]
// Config: { apiKey: "sk-..." }
// Extensions: [
//   { app: "*", type: "context-action", label: "Translate to French", icon: "languages",
//     function: "onRun" }
// ]

async function onRun() {
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

### Example: Drive File Processing Script

```javascript
// Name: "List folder sizes"
// Permissions: ["drive:read"]

async function onRun() {
    const files = eigen.context.selectedFiles;
    if (!files?.length) return [{ action: "notify", message: "No files selected" }];

    for (const file of files) {
        const path = await eigen.drive.getPath({ mountId: eigen.context.mountId, pathId: file.id });
        console.log(`${path.name}: ${path.size} bytes`);
    }

    return [{ action: "notify", message: `Processed ${files.length} files — see log` }];
}
```

### Example: Document Analysis Script

```javascript
// Name: "Compare with template"
// Permissions: ["drive:read"]

async function onRun() {
    const doc = eigen.docs.getActive();
    const currentText = await doc.getText();

    const template = eigen.docs.getById({
        mountId: eigen.config.templateMountId,
        pathId: eigen.config.templatePathId,
    });
    const templateText = await template.getText();

    const currentWords = currentText.split(/\s+/).length;
    const templateWords = templateText.split(/\s+/).length;
    console.log(`Current: ${currentWords} words`);
    console.log(`Template: ${templateWords} words`);

    return [{ action: "notify", message: `${currentWords} words (template: ${templateWords})` }];
}
```

### Example: Sheets Read Script

```javascript
// Name: "Sum column A"
// Permissions: ["drive:read"]

async function onRun() {
    const sheet = eigen.sheets.getActive();
    const values = await sheet.getRange("A1:A100");
    const sum = values.flat().filter(v => typeof v === "number").reduce((a, b) => a + b, 0);
    console.log(`Sum of column A: ${sum}`);
    return [{ action: "notify", message: `Sum: ${sum}` }];
}
```

A1 notation parsing is non-trivial — sheet names with quotes (`'Bob''s Sheet'!A1`), absolute refs (`$A$1`),
open ranges (`A:A`, `1:1`), and `Sheet1!A1:Z` (no row number) all need handling. We use a real lexer in
`a1-notation.ts`, not a regex.

## SSE Events

```typescript
// In packages/lib/src/types/sse.ts

type ScriptSSEvent =
    | { type: "scripts:started"; script: { executionId: string } }
    | { type: "scripts:progress"; script: { executionId: string; message: string } }
    | { type: "scripts:completed"; script: { executionId: string } }
    | { type: "scripts:failed"; script: { executionId: string } };
```

Events are minimal (just `executionId` + optional `message`). The frontend invalidates execution queries on
any script SSE event. Progress events update the sidebar inline.

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
            // Sidebar listens directly via useSSE for inline progress display
            break;
    }
}
```

Progress events broadcast to all the user's open SSE connections. Multiple sidebars/tabs filter by
`executionId` — that's the receiver's job, not the broadcast layer's.

## Backend Structure

```
apps/api/src/lib/document/                  # Document Content Layer — exists as built (doc.ts / sheets.ts /
                                            # slides.ts / media.ts: *FromDoc readers + writers over a
                                            # materialized Y.Doc, called inside the document-transform
                                            # Worker). See DOCUMENT-CONTENT-LAYER.md; no changes proposed

apps/api/src/lib/scripts/
  scripts.ts            # Scripts domain class (CRUD, execution lifecycle)
  db-config.ts          # Drizzle schema + versioned migrations
  schema.ts             # Drizzle table definitions
  script-worker-pool.ts # Manages N pre-warmed Deno workers, dispatches executions, recycles slots
  runner.js             # Deno worker (Proxy SDK + console capture + script execution) — plain JS
  sdk-handler.ts        # SDK_METHODS registry — Zod schemas + delegation to getSharedDrive /
                        # resolveCalendar / requireOwnerAccess + ApiError → SDK error code mapping
  sdk-readers.ts        # readDocContent / readSheetContent / readSlidesContent + cell/range helpers —
                        # ACL via getSharedDrive, then captureCollabSource + a transform-Worker read
                        # over the as-built *FromDoc readers (see § Document Content Layer)
  sdk-writers.ts        # Phase 2 — live-safe SDK writes (op-push via yjs-ops + drive.getCollabDocument)
  a1-notation.ts        # parseA1Notation() — A1 → numeric row/col conversion (real lexer)
  proxy-fetch.ts        # net.fetch handler — checks manifest domain allowlist
  sse-events.ts         # SSE event builders for script domain

apps/api/src/routes/
  scripts.ts            # Elysia router (CRUD, execute, cancel, list)

packages/lib/src/types/
  script.ts             # Shared types: Script, Execution, ScriptExtension, ScriptContext, ScriptAction
  document.ts           # Shared content types: DocContent, SheetContent, SlidesContent, CellData

packages/lib/src/sheets/
  yjs-ops.ts            # Exists (opToPatchOnSheets — the shared replay step under readSheetsFromDoc);
                        # gains pushOpsToYDoc() + the op builders for Phase 2 backend writes

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

Deno must be available in the API container. The `runner.js` lives alongside the script runner and is **copied,
not bundled**, into the Docker image — Deno needs an actual file on disk to read.

```dockerfile
# In docker/api/Dockerfile
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_DIR=/tmp/deno
ENV PATH="/root/.deno/bin:${PATH}"
COPY apps/api/src/lib/scripts/runner.js /opt/eigen/runner.js
```

The script worker pool resolves the runner via an env var or fixed path; it's not part of the JS bundle.

## Home-Relay Integration (Phase 2)

The scripts system respects the sharding seam in `home-relay.ts`.

### New HomeMessage type

```typescript
| { type: 'scripts:execute'; scriptId: string; context?: ScriptContext }
```

### Event trigger routing

When a user's Home broadcasts an event, the Scripts service checks for matching triggers. If a team/org script
needs to execute in another user's Home context, it sends a `scripts:execute` message via `sendToHome()`
rather than directly accessing the target Home.

### SDK data access

SDK calls include `ownerId` explicitly. When a script accesses shared data (e.g. a team mount via
`eigen.drive.listFolder({ ownerId: "team_abc", mountId, pathId })`), the SDK handler validates the executing
user's access then calls `getHome("team_abc")` — which in a sharded deployment routes through `home-relay.ts`
automatically. No special handling needed in the scripts system.

## Limits & Safety

| Limit | Value | Enforced by |
|-------|-------|-------------|
| Script source size | 256 KB | API route validation |
| Execution timeout | 120 s | `setTimeout` in pool, `recycleSlot()` on fire |
| Heap memory (advisory) | 128 MB | Deno `--v8-flags=--max-heap-size=128`. **Aborts the process on overflow, not a catchable error** |
| Console log buffer | 64 KB per execution | Capped in runner |
| Execution history | 200 per script | `completeExecution()` pruning |
| Filesystem read | runner.js only | Deno `--allow-read=<runner-path>` |
| Filesystem write | none | Deno `--deny-write` |
| Environment variables | none | Deno `--deny-env` |
| FFI | none | Deno `--deny-ffi` |
| Subprocess spawn | none | Deno `--deny-run` |
| Network | per-script domain allowlist | SDK `net.fetch` handler checks manifest |

Phase 2 adds: per-user concurrency limit (5), execution queue in worker process, per-org scripting toggle.

### Known Soft Boundaries

- `--max-heap-size` is V8 *advisory*: the process aborts when V8 cannot stay under the limit. External memory
  (TypedArrays from Rust, V8 LOS) is not counted. For real bounding, run the script worker process under a
  cgroup memory limit. Not in Phase 1.
- `--allow-net` does not protect against DNS rebinding to internal addresses. Domain allowlist in `net.fetch`
  resolves to a DNS lookup that an attacker-controlled DNS could answer with an RFC1918 address. For
  hardening, route `eigen.fetch` through a forward proxy that re-resolves and rejects RFC1918. Not in Phase 1.
- `proc.kill()` does not reach grandchildren on Linux. We mitigate by running workers under `setsid` and
  killing the process group. `--deny-run` prevents the worker from spawning subprocesses in the first place.

## Script Imports (Future)

Phase 1 scripts are self-contained — no external imports. Deno supports URL imports but we deny them by not
granting `--allow-import` to the worker. Future options:

- **Bundling step**: pre-bundle scripts with their dependencies before execution
- **Curated standard library**: inject common utilities into the runner
- **Import maps**: Deno import maps pointing to approved package URLs

This is a Phase 2+ concern.

## Document Content Layer

Collaborative document types (eigendoc, eigensheets, eigenslides) store content as Yjs databases. Multiple
systems need structured access: the scripting SDK, export, import, preview, and future search indexing. The
Document Content Layer is a shared abstraction that serves all of them.

This is **the** path for accessing document content from any backend system. Scripts always read via the
backend SDK (which uses this layer), ensuring consistent behavior whether triggered from a sidebar, cron, or
event.

### The Problem

`drive.readFile()` returns raw file data — useless for Yjs-backed documents. A scripting SDK that can only
read binary Yjs blobs is not a real API. The consolidation this section originally proposed has since been
built by the document-transform-workers program: `apps/api/src/lib/document/` holds one per-type module
(`readEigendocFromDoc`, `readSheetsFromDoc`, `readDeckFromDoc`, plus the doc/sheets writers), and export,
preview, import round-trips and search extraction all read through it inside the document-transform Worker —
callers capture compressed blobs (`captureCollabSource`) and the Worker materializes them
([DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md)). What scripting still needs is the SDK-facing
surface on top: `(user, ownerId, mountId, pathId)` addressing with ACL, and shaping into the content types
below.

### Architecture

```
Scripting SDK
      ↓
sdk-readers.ts — readDocContent() / readSheetContent() / readSlidesContent()      (proposed)
      ↓
getSharedDrive(ownerId, user) → captureCollabSource() → document-transform Worker
      ↓
materializeYjsState → readEigendocFromDoc / readSheetsFromDoc / readDeckFromDoc   (as built —
                      also used by export, preview, import round-trips and search extraction)
```

The SDK readers take `(user, ownerId, mountId, pathId)` and route through `getSharedDrive(ownerId, user)`
internally — the same ACL path that drive and editor routes already use — then read through the transform
seam (`run-transform.ts`) the way search extraction's `extract-text` op does (scripting adds its own read
op), so scripts respect cross-user shares and the runner's admission control alike. Export, preview, import
and search already sit on the as-built layer; this proposal doesn't touch them.

### Shared Content Types

```typescript
// packages/lib/src/types/document.ts

type DocContent = {
    type: 'doc';
    json: JSONContent;                // ProseMirror JSON (canonical intermediate)
    text: string;                     // Plain text extraction
    media: Map<string, MediaRef>;
};

type SheetContent = {
    type: 'sheets';
    sheets: SheetData[];
};

type SheetData = {
    id: string;
    name: string;
    cells: CellData[];                // Sparse — only non-empty cells
    config?: SheetConfig;
};

type CellData = {
    row: number;
    col: number;
    value: unknown;                   // Computed value (sheet `v`)
    formula?: string;                 // Formula (sheet `f`)
    display?: string;                 // Formatted display (sheet `m`)
    type?: 'number' | 'string' | 'boolean' | 'date' | 'error';
};

type SlidesContent = {
    type: 'slides';
    deck: DeckData;
    media: Map<string, MediaRef>;
};

type DocumentContent = DocContent | SheetContent | SlidesContent;
```

### Document Readers

All readers take `(user, ownerId, mountId, pathId)` and resolve via `getSharedDrive(ownerId, user)` so ACL is
consistent with the route layer. They are thin compositions over the as-built content layer — capture on the
main thread, materialize + read in the document-transform Worker, shape into the content types above. The
Phase-4 deletion of the Mount-side `read*Content` loaders was deliberate (a heavy doc blocked the main thread
for hundreds of ms); these SDK readers must not reintroduce a main-thread Yjs materialization.

```typescript
// apps/api/src/lib/scripts/sdk-readers.ts
async function readDocContent(
    user: User, ownerId: string, mountId: string, pathId: string,
): Promise<DocContent> {
    // 1. getSharedDrive(ownerId, user) — Drive | SharedDrive, ACL enforced
    // 2. captureCollabSource(mount, path) — short compressed-blob copy, main thread
    // 3. Transform-Worker read: materializeYjsState → readEigendocFromDoc(ydoc) → PM JSON
    // 4. Plain text from PM JSON
    // 5. Media map via listDocumentMedia() (main thread)
}

async function readSheetContent(
    user: User, ownerId: string, mountId: string, pathId: string,
): Promise<SheetContent> {
    // 1. Same capture path; readSheetsFromDoc(ydoc) in the Worker — snapshot + ops replay
    //    and server-side recalc are already wired there (SHEETS.md § Server-side recalc)
    // 2. Map Sheet[] → SheetContent.sheets[].cells (sparse, non-empty only)
}

async function readSlidesContent(
    user: User, ownerId: string, mountId: string, pathId: string,
): Promise<SlidesContent> {
    // 1. Same capture path; readDeckFromDoc(ydoc) in the Worker → DeckData
    // 2. Media map via listDocumentMedia() (main thread)
}
```

**Cron/event triggers**: when there is no live user (a personal cron trigger runs as the script author), the
caller passes the author's `User` object, fetched via the auth layer at trigger registration time. Every
reader and writer always has a `User` in scope; there is no "headless" code path with a different ACL.

**Sheets formula recalculation**: already wired — `readSheetsFromDoc` recalcs server-side when a doc needs it
(gated on `sheetsNeedRecalc`, falling back to replayed values on failure; see [SHEETS.md](SHEETS.md)
§ Server-side recalc). Script reads inherit it for free.

**Sheets A1 notation**: parsed by `a1-notation.ts` with a real lexer (not a regex). Handles sheet names with
quotes, absolute refs (`$A$1`), open ranges (`A:A`, `1:1`), and tab-prefixed ranges (`Sheet1!A1:Z`).

### Sheets Yjs Ops Layer (shared with the frontend)

Fortune-sheet's Yjs document has two structures:
- `state.snapshot` (Y.Map entry): JSON-serialized `Sheet[]` representing the last-flushed full state
- `ops` (Y.Array): array of `Op[]` batches representing edits since the last snapshot

The frontend (`apps/sheets/src/components/sheets/hooks/use-sheet.ts`) writes ops by pushing `[ops]` onto the
Y.Array; remote clients observe the array and replay ops via `workbookRef.current.applyOp(ops)`. On
`beforeunload` the leaving client flushes a fresh snapshot and clears the ops array.

Backend writes from the script SDK must use the **same ops mechanism**, not a snapshot-replace. Otherwise:
- Concurrent live edits get clobbered (snapshot is a single Y.Map.set, last-write-wins)
- The sheet client's pending ops are wiped server-side
- Live observers don't see the script's edit as a discrete change

The read half of this module exists as built: `opToPatchOnSheets()` (`packages/lib/src/sheets/yjs-ops.ts`)
is the pure replay step, and `replaySheetsOps()` (`packages/sheet/src/engine/replay-ops.ts`) drives it for
both the FE's initial load and the backend's `readSheetsFromDoc`. Phase 2 adds the write half next to it:

```typescript
// packages/lib/src/sheets/yjs-ops.ts — additions

// Push an op batch onto the Y.Doc's ops array — same mechanism the frontend uses
export function pushOpsToYDoc(doc: Y.Doc, ops: Op[]): void {
    doc.transact(() => doc.getArray('ops').push([ops]));
}

// High-level builders for SDK writes — produce ops in sheet's native shape
export function buildSetCellValueOp(
    sheetIndex: number, row: number, col: number, value: unknown
): Op[] { /* … */ }

export function buildSetCellRangeOp(
    sheetIndex: number, row: number, col: number, values: unknown[][]
): Op[] { /* … */ }
```

The backend writer becomes:

```typescript
// apps/api/src/lib/scripts/sdk-writers.ts
import { pushOpsToYDoc, buildSetCellValueOp } from '@workspace/lib/sheets/yjs-ops';

export async function setCellValue(
    user: User, ownerId: string, mountId: string, pathId: string,
    sheetIndex: number, row: number, col: number, value: unknown,
): Promise<void> {
    const drive = await getSharedDrive(ownerId, user);
    // getCollabDocument re-checks read only — a write needs its own explicit check
    // first, same shape as the import commit (import-document.ts). It returns the
    // live document if editors are connected, loading it otherwise.
    if (!(await drive.canWrite(mountId, pathId, user))) throw new ApiError(403, 'No write permission');
    const collabDoc = await drive.getCollabDocument(mountId, pathId);
    const ops = buildSetCellValueOp(sheetIndex, row, col, value);
    pushOpsToYDoc(collabDoc.doc, ops);
    // CollabDocument's existing update listener broadcasts to connected WebSocket clients
    // and persists the update via DbProvider.
}
```

This means:
- **Live editors see the script's edit just like another user's edit** — the Y.Array observer fires, sheet
  applies the op, the cell updates in real time
- **Concurrent edits merge cleanly** — Yjs Array.push is a CRDT operation
- **No snapshot clobbering** — the script never touches `state.snapshot`. Snapshot consolidation continues to
  happen on `beforeunload` from the leaving client
- **One mental model** — the FE op handler and the BE writer both call `pushOpsToYDoc(doc, ops)`

The same shared-ops pattern applies to docs (TipTap/y-prosemirror has `prosemirrorJSONToYDoc` for full-doc
operations and `Y.applyUpdate(doc, update)` for incremental — both already used by `writeEigendocToYjs` /
`writeEigendocUpdateToYjs` in `apps/api/src/lib/document/doc.ts`) and slides (Y.Map mutations on
`slides`/`objects`/`slideOrder` — straightforward Yjs ops, no separate ops array).

### Document Writers (Phase 2)

Import-grade writers exist as built (`writeEigendocToYjs` / `writeEigendocUpdateToYjs` in
`lib/document/doc.ts`, `writeSheetsToYjs` / `writeSheetsSnapshotToYjs` in `lib/document/sheets.ts`), but they
snapshot-replace and wipe pending ops — unsafe while editors are connected
([DOCUMENT-CONTENT-LAYER.md § Writers are unsafe against live editors](DOCUMENT-CONTENT-LAYER.md#writers-are-unsafe-against-live-editors)).
The SDK writers are the live-safe layer the scripting platform adds:

```typescript
// apps/api/src/lib/scripts/sdk-writers.ts
async function writeDocContent(user: User, ownerId: string, mountId: string, pathId: string, content: DocContent) { /* … */ }

async function writeSheetContent(user: User, ownerId: string, mountId: string, pathId: string, content: SheetContent) { /* … */ }

async function setCellValue(user: User, ownerId: string, mountId: string, pathId: string,
    sheetIndex: number, row: number, col: number, value: unknown) { /* … */ }

async function setCellRange(user: User, ownerId: string, mountId: string, pathId: string,
    sheetIndex: number, row: number, col: number, values: unknown[][]) { /* … */ }

async function writeSlidesContent(user: User, ownerId: string, mountId: string, pathId: string, content: SlidesContent) { /* … */ }
```

If editors are connected, all writers route through the live `CollabDocument`. If not, the writer obtains a
Y.Doc through the same collab infrastructure (which then persists the update via `DbProvider`). There is no
separate "offline" write path.

### Scripting SDK Methods

Following Google Sheets API patterns — default to computed values, optional `render` parameter:

```javascript
// --- Docs ---
const doc = eigen.docs.getActive();
const text = await doc.getText();
const json = await doc.getJson();
const other = eigen.docs.getById({ mountId: "...", pathId: "..." });
const teamDoc = eigen.docs.getById({ ownerId: "team_abc", mountId: "...", pathId: "..." });

// --- Sheets ---
const sheet = eigen.sheets.getActive();
const val = await sheet.getCell("A1");                       // → 42
const formula = await sheet.getCell("A1", { render: "formula" });   // → "=SUM(A1:A5)"
const display = await sheet.getCell("A1", { render: "formatted" }); // → "$42.00"
const values = await sheet.getRange("A1:D10");               // → [[1, "Alice", 95], ...]
const data = await sheet.getSheetData({ sheet: 0 });

// --- Slides ---
const slides = eigen.slides.getActive();
const deck = await slides.getDeck();
```

### ScriptActions for Document Writes (Phase 2)

Write operations on the currently-open document go through `applyResults()` on the context provider. The
provider dispatches to the live editor — same mechanism that drives a user's interactive edit, no special path.

```javascript
// Docs — insert structured ProseMirror content
return [{ action: "insertContent", content: {
    type: "paragraph",
    content: [{ type: "text", text: "Generated by script" }]
}}];

// Sheets — set cells (the editor pushes the op via the Yjs ops layer above)
return [{ action: "setCellValue", sheet: 0, row: 5, col: 0, value: 42 }];

return [{ action: "setCellRange", sheet: 0, row: 0, col: 0, values: [
    ["Name", "Score", "Grade"],
    ["Alice", 95, "A"],
    ["Bob", 87, "B+"],
]}];
```

For cron/event-triggered scripts (no live editor), the SDK exposes backend write methods (Phase 2):
`docs.insertContent`, `sheets.setCell`, `sheets.setCellRange`, etc. These call the writers above, which
emit ops through the same shared module. Live editors connected at the time observe the change in real time.

### Consumers

| Consumer | Doc reader | Sheet reader | Slides reader | Writers | Today |
|----------|-----------|-------------|--------------|---------|-------|
| **Scripting SDK** | `getText`, `getJson` | `getCell`, `getRange`, `getSheetData` | `getDeck` | Phase 2 | Built in Phase 1 (read), Phase 2 (write) |
| **Export** (DOCX, PDF, HTML) | Yes | Yes | Yes | — | As built — `lib/export/<type>/transform.ts` calls the `*FromDoc` readers in the Worker |
| **Preview** (HTML rendering) | Yes | Yes | Yes | — | As built — `lib/preview/eigen<type>-render.ts` |
| **Import** (DOCX, XLSX, PPTX) | — | — | — | Yes | As built — `lib/import/import-document.ts` commits via the `lib/document/` writers |
| **Search indexing** | Yes | Yes | Yes | — | As built — the `extract-text` op (`lib/search/extract-render.ts`) |

Export, preview, import and search already consume the as-built layer; the scripting SDK row is the only
new consumer this proposal adds.

## Implementation Phases

### Phase 1 — MVP

The minimum that proves the full pipeline end-to-end, with read-only SDK and a worker pool from day one.

**Backend:**
- `Scripts` domain class (CRUD + execute + cancel + recovery-on-startup)
- `db-config.ts` with `scripts` + `executions` tables
- `ScriptWorkerPool` (N pre-warmed Deno workers, kill+respawn between executions)
- `runner.js` (Proxy SDK with document object model + flat domain proxies + console capture + utils,
  Content-Length JSON-RPC framing, frozen `eigen` global, capped log buffer)
- `sdk-handler.ts` (typed `SDK_METHODS` registry with Zod schemas, handler-side ACL via existing
  `getSharedDrive` / `resolveCalendar` / new `requireOwnerAccess` helper, split error codes)
- `requireOwnerAccess(userId, ownerId)` added to `apps/api/src/lib/core/access.ts` — thin dispatcher over
  existing `requireSelf` / `requireTeamAccess` / org-membership primitives
- `proxy-fetch.ts` (manifest domain allowlist enforcement)
- SSE events for execution lifecycle (including progress)
- Routes: CRUD, execute, cancel, list
- Personal scope only

**Document content access** (the content layer itself exists as built — see
[DOCUMENT-CONTENT-LAYER.md](DOCUMENT-CONTENT-LAYER.md)):
- `sdk-readers.ts` — `readDocContent` / `readSheetContent` / `readSlidesContent`: ACL via `getSharedDrive`,
  then `captureCollabSource` + a transform-Worker read over the as-built `*FromDoc` readers
- `a1-notation.ts` — A1 notation parser (real lexer, not regex)
- Shared types: `DocContent`, `SheetContent`, `SlidesContent`, `CellData` in `packages/lib/src/types/document.ts`

**Shared Sheets Yjs Ops Module (`packages/lib/src/sheets/yjs-ops.ts`)** (the read/replay half exists as
built — `opToPatchOnSheets` + `replaySheetsOps`):
- `pushOpsToYDoc(doc, ops)` — push an op batch, used by both FE and BE (Phase 2 BE writes)
- `buildSetCellValueOp`, `buildSetCellRangeOp` — high-level op builders (used in Phase 2 BE writes; defined
  in Phase 1 alongside the read path so the module is one cohesive piece)

**SDK (read-only):**
- `eigen.docs.getActive()` / `eigen.docs.getById({...})` — methods: `getText`, `getJson`
- `eigen.sheets.getActive()` / `eigen.sheets.getById({...})` — methods: `getCell` (A1), `getRange` (A1),
  `getSheetData`. Render options: `"value"` (default), `"formula"`, `"formatted"`
- `eigen.slides.getActive()` / `eigen.slides.getById({...})` — methods: `getDeck`
- `eigen.drive.*` — methods: `listFolder`, `getPath`, `readFile`
- `eigen.fetch()` — manifest-allowlisted domains
- `eigen.progress(message)` — real-time progress via SSE
- `eigen.utils.sleep(ms)` — pause execution (counts against timeout)
- `console.log/warn/error` — captured locally (capped 64 KB)
- `eigen.context` — selection state from frontend
- `eigen.config` — persisted per-script config
- `eigen.user` — current user
- Structured error codes: `NOT_FOUND`, `SCRIPT_PERMISSION_DENIED`, `RESOURCE_PERMISSION_DENIED`,
  `QUOTA_EXCEEDED`, `INVALID_PARAMS`, `INTERNAL`

**Frontend:**
- Scripts app: list view + CodeMirror editor + "Run" button + output panel
- `ScriptsPanel` in `packages/ui` (PropertiesPanel-based sidebar)
- `ScriptContextProvider` interface (selection state only, no document content)
- Context providers for **Docs** (`selection` + `replaceSelection`, `insertText`, `insertContent`)
  and **Drive** (`selectedFiles` + `notify`)
- Toolbar integration: `Code` icon button (alongside existing comment button)

### Phase 2 — Worker Process + Triggers + Writes + Import

- **Worker process extraction** — move pool, queue, and cron scheduler to a dedicated Bun worker process
  with IPC. Add per-user concurrency limit (5)
- **Cron triggers** — `Bun.cron(schedule, callback)` per trigger, server-level `cron_triggers` index in
  `eigen.db`. UTC schedules, no-overlap semantics, lost-on-restart re-registration
- **Event-driven triggers** — listener on `Home.broadcast()`, dispatches matching script executions
- **Failure notifications** — cron/event failures call `home.notifications.persist({ type: 'scripts:failed', ... })`
- **Write SDK operations**: `drive.writeFile`, `drive.create`, `docs.insertContent`, `sheets.setCell`,
  `sheets.setCellRange`, `slides.insertSlide` — with quota enforcement and ACL validation, all routed
  through the same Yjs ops modules used by live editors
- **DocumentWriters**: `writeDocContent()`, `writeSheetContent()`, `writeSlidesContent()`
- **File import**: DOCX and XLSX shipped as built (`lib/import/` through the transform Worker); what remains
  is PPTX → `SlidesContent` → `writeSlidesContent()`
- **User-scoped properties** — per-user config for shared scripts (like Google's `UserProperties`)
- Team/org script scope (Scripts domain in TeamHome/OrgHome)
- Installation/permission approval flow
- Prompt-based script inputs (`input` field in extensions)
- Extended SDK: `eigen.mail.*`, `eigen.calendar.*` (Proxy makes these one-line additions in `SDK_METHODS`)
- Context providers for remaining apps (Sheets, Slides, Mail, Chat, Calendar)
- Admin controls (disable scripting, view/kill executions)

### Phase 3 — Hardening + Rich Extensions

- **OS-level isolation** for hostile-code scenarios: cgroup memory enforcement, network namespace,
  forward-proxy enforcement of the fetch domain allowlist (defends against DNS rebinding), separate Linux user
- `sidebar-panel` extension type (custom HTML rendered in host apps)
- Script secrets/config store (encrypted, separate from script source)
- Execution metrics and quota enforcement
- Script versioning with rollback UI
- Script module/import mechanism (bundling or import maps)
- Custom sheet functions (batch evaluation of `=EIGEN_FUNC()` cells)
- Public marketplace / script registry — only viable after Phase 3 OS-level isolation lands

## Google Apps Script Comparison

Key design decisions mapped to Google's equivalents:

| Concept | Google Apps Script | Eigen SDK | Notes |
|---|---|---|---|
| Active document | `SpreadsheetApp.getActive()` | `eigen.sheets.getActive()` | Same pattern. GAS limitation: only works in container-bound scripts; standalone scripts must `openById`. Eigen has the same context distinction (sidebar context vs cron) |
| Open by ID | `SpreadsheetApp.openById(id)` | `eigen.sheets.getById({mountId, pathId})` | Eigen uses (mountId, pathId) instead of a single ID |
| Cell access | `sheet.getRange("A1").getValue()` | `sheet.getCell("A1")` | Simpler — no intermediate Range object. We don't need GAS's batch-cache architecture because each call is one RPC, not 100 |
| Range access | `sheet.getRange("A1:C10").getValues()` | `sheet.getRange("A1:C10")` | Returns 2D array directly |
| Display values | `range.getDisplayValues()` | `sheet.getCell("A1", { render: "formatted" })` | Param-based vs separate method. We do not split into 3 methods (value/display/formula) — one method, render parameter |
| Document text | `doc.getBody().getText()` | `doc.getText()` | Flatter — no Body intermediate |
| HTTP requests | `UrlFetchApp.fetch(url, params)` | `eigen.fetch(url, opts)` | Standard fetch API. Manifest allowlist is similar to GAS's `urlFetchAllowlist` |
| Script storage | `PropertiesService` (3 scopes) | `eigen.config` (script scope) | Phase 2 adds user scope |
| Sleep | `Utilities.sleep(ms)` | `eigen.utils.sleep(ms)` | Async (Promise-based) vs synchronous; counts against timeout in both |
| Triggers | `ScriptApp.newTrigger().timeBased().everyHours(1).create()` | Cron expressions in trigger config | Cron is more powerful, builder is more ergonomic. We may add a builder later |
| Custom functions in cells | `@customfunction` tag | Phase 3 | Hard with subprocess model — every cell evaluation pays cold-start. Likely batch-evaluation API instead of real-time |
| Runtime | V8 (sync-only despite async syntax) | Deno (real async, modern JS, native fetch) | Real difference. Trade-off: GAS doesn't need a permission model; Deno does and we have to design around its imperfections |

## What Is NOT In Scope

- Public marketplace / script registry (would require Phase 3 isolation)
- Collaborative script editing (single author edits at a time)
- TypeScript in-browser (scripts are plain JS; users can transpile externally)
- Script-to-script communication
- Billing/quota per script execution
- Encrypted secrets storage (Phase 3)
