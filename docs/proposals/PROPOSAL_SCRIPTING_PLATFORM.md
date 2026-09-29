# Proposal: Scripting platform

> **Status — Proposal, not started.** Seams verified against main `e7cf8739b` on 2026-09-29. Tracked in [ROADMAP-POST-1.md](../ROADMAP-POST-1.md).
>
> **TLDR**: Server-side JavaScript automation in the spirit of Google Apps Script. A user writes a script in a new Scripts app, runs it by hand or from a side panel in Docs and Drive, and reaches Eigen through a typed `eigen` SDK that reads and writes Drive, Docs, Sheets, Slides, Mail, Calendar and Contacts. Every run is a fresh Deno subprocess with no filesystem, network, environment or Eigen credentials of its own; everything it does goes back over a framed stdin/stdout protocol to the API, which checks each call against the script's approved manifest **and** the user's ordinary ACLs, then runs it through the existing domain code. Document edits commit through the live collab document, guarded by a revision, so connected editors see them and a concurrent edit becomes a conflict instead of an overwrite. The first release is personal, manual and full read/write; team distribution, cron and event triggers come later on the same execution record and runtime. It is automation for trusted users on an operator-controlled instance, not a sandbox for hostile code.

## Goals

1. A user automates their own work across every core app from one script: read a sheet, write a doc, file mail, create events, without leaving Eigen.
2. **Full read/write from day one.** A read-only first release would dodge the hard part (live document writes) and ship something nobody needs.
3. **No new authority.** A script can do exactly what its user can do in the UI, narrowed by what its manifest declares and the user approved. Every call is rechecked against today's ACL seams.
4. **Edits land like a collaborator's.** A script's document write reaches every open editor through collab, persists through the normal path, and never silently overwrites a concurrent edit.
5. **Bounded everything.** Queue, time, memory, calls, bytes, logs, history: each has one limit, enforced by the API, and a run that hits one ends with a clear outcome.
6. **Unattended-ready.** A script that names its targets explicitly runs unchanged when triggers arrive; the execution record already carries principal, owner, initiator and version separately.

## Non-goals

- **Hostile-code containment.** A Deno process isolates crashes and heaps, not machine-wide CPU, RSS, disk or runtime vulnerabilities. Public marketplaces, untrusted authors and tenant isolation need a separately reviewed OS/container boundary first.
- **Apps Script compatibility.** Same idea, Eigen's own API.
- **Imports.** No npm, no URL or local modules, no TypeScript compilation, no DOM. A script is one self-contained JavaScript source. Dependency bundling and reusable libraries are later work.
- **Embedded web UIs.** A script's only UI is a bounded input form and a bounded set of result actions.
- **Transactions across calls.** Each mutating SDK call commits on its own; a failed or cancelled run does not roll back what already committed, and external side effects are never exactly-once.
- **A workflow engine.** No branching visual flows, no retries of user logic, no automatic replay after a restart.

## What exists today (verified against source)

| Piece | Where | State |
|---|---|---|
| Home lifecycle | `apps/api/src/lib/home/home.ts`, `get-home.ts` | Homes idle out; `touchHomeIfLoaded()` keeps one alive while work runs against it |
| Per-home databases | `Home.getLocalDatabase()`, `ManagedDatabase` | The pattern `scripts.db` follows: `schema.ts` + versioned `db-config.ts` |
| Drive access | `getSharedDrive(ownerId, user)`, `lib/drive/get-drive.ts` | The ACL-checked wrapper every Drive operation goes through |
| Calendar access | `resolveCalendar`, `checkCalendarAccess`, `lib/calendar/get-calendar.ts` | Collection and event access, write checks for mutations |
| Personal-only domains | `requireSelf`, `requireNonGuest`, `lib/core/access.ts` | How Mail and Contacts stay personal |
| Cross-home calls | `lib/home/home-relay.ts` | The only way to touch another Home; never `getHome(otherOwnerId)` |
| Document readers | `readEigendocFromDoc` (`lib/document/doc.ts`), `readSheetsFromDoc` / `replaySheetsOps` (`lib/document/sheets.ts`), `readVectorFromDoc` | Current content decoders for Docs, Sheets and the shared canvas model ([DOCUMENT-CONTENT-LAYER.md](../DOCUMENT-CONTENT-LAYER.md)) |
| Sheet ops | `opToPatchOnSheets`, `packages/lib/src/sheets/yjs-ops.ts` | Op semantics shared by the editor and the server replay |
| Off-thread transforms | `DocumentTransformRunner`, `lib/document/transform/runner.ts` | Closed protocol, bounded admission ([DOCUMENT-TRANSFORMS.md](../DOCUMENT-TRANSFORMS.md)) |
| Live documents | `CollabDocument`, `lib/collab/collabDocument.ts` | Owns the live Y.Doc, persistence and broadcast. Has no revision a writer can check against |
| Scheduler | `scheduleInterval`, `lib/scheduler/scheduler.ts` | Interval wake-ups only; no cron |
| Code editor | CodeMirror, `apps/drive/src/components/editor/code-editor.tsx` | Reusable for the script editor |
| Shutdown | `apps/api/src/index.ts` | Bounded, ordered shutdown the runner slots into |

What is missing: the scripts domain and app, the runner, the SDK registry, a live revision on `CollabDocument`, React-free live writers for Docs, Sheets and Slides, and constrained egress.

## Architecture

```
 Scripts app / ScriptsPanel ──HTTP──▶ routes/scripts.ts ──▶ Scripts (scripts.db per Home)
                                                              │ admitted execution
                                                              ▼
                                        runner: admission queue, one Deno child per run
                                                              │ framed stdin/stdout
                                                              ▼
                                    Deno child: runner.js + script source, no permissions
                                                              │ call { method, params }
                                                              ▼
            sdk-handler: registry → grant → ACL seam → domain code / live writers / egress
```

The API owns everything that matters: authorization, execution records, budgets and every SDK operation. The child only runs user JavaScript and asks.

### Trust model

Scripts are trusted by their authors, not trusted with the server's authority. Scripting is off by default behind a server setting; turning it off stops admission and cancels active runs. Guests and non-user principals are rejected. Demo deployments keep it off.

Every SDK call passes four checks, in the API, on every call:

1. The execution is still authorized and within its budgets.
2. The method is registered and its parameters pass the method's schema.
3. The grant frozen at admission includes the method's required permissions.
4. The principal still has the ordinary domain permission on the target resource.

Identity comes from the API's own execution record and subprocess handle. Anything the child sends (user IDs, grants, execution IDs, "success") is data, not authority. Freezing the `eigen` object in the child is an ergonomic guard, not a boundary: script code shares the runner's realm.

### Identity and approval

| Field | Meaning |
|---|---|
| `scriptOwnerId` | Home that stores the script and its history |
| `principalUserId` | Real user whose current ACLs govern the run |
| `resource.ownerId` | Home owning a particular target |
| `initiator` | Manual now; a trigger or installation later |

For a personal run, `scriptOwnerId === principalUserId`. Resources can still belong to other Homes: a shared file or a team calendar works through its ACL wrapper, and knowing an `ownerId` grants nothing.

The manifest declares permissions, exact network origins, entrypoints and extensions. Permissions are explicit read and write tokens for `drive`, `docs`, `sheets`, `slides`, `mail`, `calendar` and `contacts`, plus `fetch`; a write token does not imply read, and a method may require several. The token list, the manifest schema, the method requirements and the editor's SDK typings derive from one definition.

The server validates the manifest, rejects unknown tokens, and records approval of a normalized manifest digest; a client-side confirm is not approval. The first run requires approval, and any permission or origin change invalidates it and stops affected queued and running work. `fetch` is approved as disclosure: the dialog says that source, configuration and anything the script can read may go to the approved origins.

Saves use optimistic version checks. Saving source creates a new version; an admitted run keeps its snapshot. Disabling or deleting a script revokes outstanding runs. A configuration change invalidates queued and running work under the old configuration revision, so a replaced credential is not used afterwards.

### Persistence

`{home}/eigen.scripts/scripts.db` through `Home.getLocalDatabase()`, with the usual `schema.ts` and `db-config.ts`.

**`scripts`**

| Column | Purpose |
|---|---|
| `id`, `name`, `description` | Identity and bounded display metadata |
| `source` | JavaScript, bounded in UTF-8 bytes |
| `manifest` | Permissions, origins, entrypoints, extensions |
| `config`, `configRevision` | Per-script configuration and its revision |
| `version` | Monotonic save version for optimistic updates |
| `approvedManifestDigest`, `authorizationRevision` | Approval and revocation generation |
| `enabled`, `createdAt`, `updatedAt` | State and epoch-ms timestamps |

**`executions`**

| Column | Purpose |
|---|---|
| `id`, `scriptId` | Identity |
| `principalUserId`, `initiator` | Who authorized it and why |
| `scriptVersion`, `sourceSnapshot`, `manifestSnapshot` | The code and capabilities that actually ran |
| `grantedPermissions`, `authorizationRevision`, `configRevision` | Approval context at admission |
| `entrypoint`, `context`, `input` | Validated, bounded invocation |
| `runtimeId` | The API process generation that admitted it |
| `requestKey`, `requestDigest` | Optional retry key and payload fingerprint |
| `status` | `pending`, `running`, `stopping`, `completed`, `failed`, `timeout`, `cancelled` |
| `createdAt`, `startedAt`, `finishedAt`, `deadlineAt`, `durationMs` | Timing |
| `progress`, `log`, `result`, `error` | Capped latest progress, log tail, result, structured public error |
| `effects` | Count of mutating calls, and whether side effects may have committed despite a failure |

Indexes cover `(scriptId, createdAt, id)` pagination, active-status lookup and retry-key lookup.

**Configuration holds credentials.** It stays in the private Home database, plaintext at rest like the rest of the Home, protected by filesystem permissions and backups. It never appears in listings, extension discovery, SSE or history; secret fields have a separate replace-only input, so a masked value can never overwrite the real one. An admitted run gets an in-memory snapshot; history records the revision, not a copy. Logs and results are private user data, not a redaction boundary: a script can print its own secrets.

**Retention** prunes terminal rows only, by count per script and by bytes per owner (source, context, result and log bytes, not rows). It runs on each terminal transition and on database init, and admission fails if the bound cannot hold. A retry key deduplicates for as long as its row is retained; a reused key with a different digest is a conflict, and the UI never retries on its own.

**Recovery.** A Home reopening is not an API restart. On init, nonterminal rows from a different `runtimeId` become `failed` with `EXECUTION_INTERRUPTED`, stating that earlier mutations may have committed; rows owned by the current runtime are left alone. Nothing replays.

**Home lifetime.** `Scripts` joins `UserHome`'s init, failure-cleanup and destruct lists; Home variants without scripting get an explicit capability guard. The runner keeps an admitted Home alive with `touchHomeIfLoaded()` until its run is finalized.

### Execution lifecycle

Personal routes live under `/scripts/:ownerId` behind `requireSelf` and the eligibility check: CRUD, approval, configuration, extension discovery, run, cancel and history. Discovery returns enabled, approved extensions for the current app, never source or configuration.

A run request names the saved `scriptId`, expected `scriptVersion`, entrypoint, optional retry key, input and editor context. It cannot carry source, permissions or a principal. The route caps body bytes while reading, before JSON parsing; the API's global body limit is far too large for this.

1. **Validate.** Eligibility and request shape. A retry key is looked up first: an identical retry returns its execution even if the queue is full or the script has since changed; a different digest is a conflict. A new run then checks version, approval, entrypoint, context and resource access.
2. **Reserve** admission capacity before any expensive work: `429` for a per-principal limit, `503` for disabled, unavailable or globally saturated.
3. **Insert** the `pending` row in one transaction that rechecks version and authorization revision. Concurrent requests with one retry key converge on the unique row; the loser releases its reservation.
4. **Hand off** to the in-memory dispatcher with no unowned async gap, and answer `202 { executionId, status: 'pending' }`.
5. **Dispatch** fairly across principals, FIFO within one. Recheck enablement, approval and queue expiry, then spawn and mark `running`; the deadline includes startup.
6. **Serve** SDK calls, logs and progress until the child finishes, errors, is cancelled, times out, breaks protocol or exits.
7. **Finalize** once: refuse new calls, reject queued ones, abort cancellable I/O, kill and reap the child, persist one terminal status, then broadcast.

Every ending (completion, cancel, timeout, exit, a duplicate message) races through one compare-and-set, so a late `done` cannot overwrite a timeout. Cancel is idempotent: a pending run is dropped before spawn, a running one goes `stopping` while the child is killed. If the final write fails, the execution stays in a bounded finalization set, the failure surfaces operationally, and the write retries within the shutdown budget; restart recovery is the last resort.

**Side effects.** Neither runs nor mutating calls are retried. A timeout or cancel stops further calls; it does not undo written files, sent mail, changed events or HTTP requests, and an operation past its commit point may still finish. The host keeps such operations tracked and bounded until they settle, and `effects` reports ambiguity instead of implying nothing happened.

**Shutdown.** Stop admission, cancel queued runs, terminate and drain running ones, then close transform workers and Homes. Runs use both, so they go first, inside the existing bounded shutdown in `apps/api/src/index.ts`.

### The runner

One process-wide dispatcher in the API, one fresh Deno process per run, never reused. `Scripts` owns durable records; the dispatcher owns admission, child handles, deadlines and finalization, and neither calls the other's completion path. No separate Bun supervisor: the Deno child already takes script CPU off the API. A supervisor stays a possible later deployment seam.

The child runs `runner.js`, a trusted, dependency-free entry shipped with Eigen; the script source arrives over stdin, never as a path, argument or shell string. It launches from an argument vector with:

- `--no-prompt`, `--deny-read`, `--deny-write`, `--deny-net`, `--deny-env`, `--deny-run`, `--deny-ffi`, `--deny-sys`, `--deny-import`
- `--no-config`, `--no-npm`, `--no-remote`, no lockfile discovery

The trusted entry must load without granting script code read access. That combination is verified against the pinned Deno binary; a failing flag is a blocker, never a reason to widen permissions. Deno treats module loading separately from read and net permissions and allows some import hosts by default, so no single flag is the import policy; the combination is.

The child gets an explicit minimal environment, not the API's: no permission-broker, loader, proxy, inspector or telemetry variables, update checks off. Each run gets private temp and cache directories outside Eigen data, removed after reap; no Deno KV or cache is shared between users. Disk and memory limits are both provisioned and documented. The V8 heap flag is a heap target, not an RSS limit.

The API holds an absolute monotonic deadline until the child is reaped, not merely until init is written. Spawn failure, startup timeout, unexpected exit, truncated stdout and protocol errors are explicit outcomes. stderr drains continuously into a capped buffer. The child is killed and reaped through Bun's process API, with no reliance on `setsid` or process-group tricks; deployment hardening that adds a group or cgroup tracks it explicitly. The child exits on stdin EOF and carries its own deadline, which bounds an orphan after an abrupt API death; beyond that, containment is the deployment's process lifecycle.

### Wire protocol

Content-Length-framed UTF-8 JSON over stdin/stdout, a closed and versioned envelope. A small custom RPC, not JSON-RPC 2.0.

| Direction | Messages |
|---|---|
| API → child | one `init` (protocol version, invocation snapshots); `result { callId, value }`; `error { callId, code, message }`; `cancel` |
| child → API | `ready`; `call { callId, method, params }`; `log`; `progress`; `done`; `error` |

Messages bind to the child handle; one cannot name another execution. `callId`s are numeric and unique per run, with limits on duplicates and outstanding calls. Unknown methods, unsolicited replies, duplicate terminal messages and invalid shapes fail closed.

The framer handles split and coalesced frames, partial writes, backpressure and EOF. It bounds the header and the announced body before allocating, requires exactly one valid Content-Length, decodes UTF-8 fatally and schema-checks the body. One bounded writer serializes output so frames never interleave.

Values are JSON-safe. An absent return becomes `null`; cycles, BigInt, functions, non-finite numbers and oversized or deeply nested values are a serialization error. Results, logs, progress, errors and host replies each have their own cap, enforced by the API regardless of what the runner does. Console formatting tolerates cycles.

Document handles are thin proxies, but only registered methods dispatch: symbols, `then`, `toJSON` and introspection do not, so a handle is never a thenable. Target fields baked into a handle cannot be overridden by call parameters. Entrypoints are validated identifiers from the admitted manifest, never interpolated into generated code.

### SDK

`SDK_METHODS` in the API is the one registry: method name, input and output schema, required tokens, mutating or not, and resource bounds. Shared types live in `packages/lib/src/types/script.ts`; the typed declarations the editor completes against derive from the registry. No generic `method: string` reflector onto backend classes, no internal or admin methods.

Document domains hand out handles: `eigen.docs.getActive()` where an app supplies an active document, `eigen.docs.getById({ ownerId, mountId, pathId })` everywhere; same for `sheets` and `slides`. A handle carries the document's real owner, never `eigen.user.id`. Flat domains are calls, `eigen.drive.listFolder(params)`, `eigen.mail.send(params)`, and so on; `ownerId` defaults to the principal's Home.

| Domain | Reads | Writes |
|---|---|---|
| Drive | `listFolder`, `getPath`, bounded `readFile` | `create`, `writeFile`, rename, in-mount move, copy, trash, all through `SharedDrive` with its history and SSE |
| Docs | `getText`, `getJson`, `readWithRevision` | `insertContent`, replace text or structured content (live writer) |
| Sheets | metadata, `getCell`, `getRange`, `getSheetData`, `readWithRevision` | `setCell`, `setCellRange`, formatting, supported structure changes (live writer) |
| Slides | `getDeck` and elements over `VectorScene` | `insertSlide`, add, update and remove frames and elements (live writer) |
| Mail | bounded mailbox and message queries, message content | send, supported message and folder mutations through Mail's validation |
| Calendar | calendars, event lists, event details | create, update, delete through invitation, recurrence and cross-owner semantics |
| Contacts | contacts, labels | create, update, delete, label changes through the vCard-backed domain |

Access goes through the seams that exist: `getSharedDrive` for Drive and documents, `resolveCalendar` and `checkCalendarAccess` for Calendar (write checks for mutations), `requireNonGuest` plus `requireSelf` for Mail and Contacts. Mail's localhost delivery endpoint is not exposed. Cross-home work goes through the relay ([SCALABILITY.md](../SCALABILITY.md)); a new relay verb gets a serializable, checked contract. Access is rechecked on every call; only schemas and metadata are cached across a run.

Drive's byte methods never reach managed document databases, container internals or storage keys; a raw `data.db` read is not a way around the document tokens. File bytes cross as declared, bounded text or base64; dates use one wire representation.

Collections paginate with bounded cursors. Sizes, cell counts, range dimensions, nesting and operation counts are checked before anything materializes. Identity is by stable ID, never array index. Errors use stable public codes (`INVALID_ARGUMENT`, `PERMISSION_DENIED`, `NOT_FOUND`, `CONFLICT`, `LIMIT_EXCEEDED`, `UNAVAILABLE`, `CANCELLED`, `INTERNAL`) with a bounded message mapped from the domain's `ApiError`; no stack traces or paths cross to the script.

### Document reads

Reads add explicit, bounded operations to the transform runner's closed protocol, with typed JSON-safe results and admission costs; no callbacks, Homes, Mounts, databases or live Y.Docs go into a worker, and nothing falls back to materializing on the main thread. Scripts share transform capacity with previews and exports under their own admission class, which rejects on saturation rather than queueing without bound.

A read captures from the live document, including acknowledged but unflushed changes, so a read after a write in the same run sees the write. Sheets reads follow the existing replay and recalc policy: no full-workbook recalc per `getCell()`, and stale computed values are reported as such. A1 addresses go through the existing spreadsheet address helpers and name a stable sheet.

### Document writes

An import-time writer that edits a detached Y.Doc or replaces a snapshot does not reach connected editors, so every script write goes through the ACL-checked live `CollabDocument` and its normal update, persist and broadcast path.

**Revisions.** `CollabDocument` gains one opaque live revision: its generation plus a sequence bumped by every Yjs update, delete-only updates included. A reopen starts a new generation, so an old token never matches. A sheet op count, a bare state vector or the persistence counter (which resets at snapshot) is not enough. `readWithRevision(...)` returns `{ revision, content }` from one captured state and retries within a small bound if the revision moves during capture. Simple reads like `getText()` keep plain return shapes and cannot authorize a write.

**Commit.** A write takes `expectedRevision` and returns the new one, so writes chain deliberately. Planning runs in a transform worker; then, with no `await` in between, the API rechecks write permission, cancellation, grant generation and revision, and commits one synchronous Yjs transaction. A mismatch is `CONFLICT`: the script decides what to do, nothing reruns user logic or overwrites a collaborator. Operations that merge by stable ID say so explicitly.

| Type | Writer |
|---|---|
| Docs | The editor's Tiptap schema and Yjs XML mapping, applied to the live fragment; unrelated content and supported marks survive; structured input is validated at the boundary |
| Sheets | The editor's op-building and Yjs op-push, extracted into the React-free sheet layer; stable sheet IDs, ordered op IDs, snapshot compatibility and formulas preserved; never a snapshot overwrite while editors are connected |
| Slides | Pure canvas mutations and registry validation for `elements`, `frames` and `meta`, extracted from the canvas engine; scalar encoding, frame order, element IDs, media and bindings preserved |

These extractions are new work; package direction stays `sheet → lib`, `ui → lib`, and backend-shared primitives import no React. Each mutating call is its own unit; batches across documents or domains are not atomic. Server edits do not join a browser's undo stack; file history and versions are the way back.

### Network access

`eigen.fetch()` is an SDK call, not Deno's `fetch`. The API allows the intersection of the script's approved exact origins (scheme, host, port) and operator policy, and adds no cookies, tokens, server headers or proxy settings.

The handler rejects URL credentials, other schemes, unapproved origins and non-public destinations: it resolves every address, rejects loopback, private, link-local, multicast, unspecified and IPv4-mapped equivalents, and connects to the validated address while keeping hostname and TLS verification, on every new connection. Redirects are followed by hand, each hop validated, at most three, no credentials across origins. Request bytes, decompressed response bytes, headers, time and concurrency are bounded and cancel with the run; transport headers (`Host`, `Content-Length`, connection, proxy, cookies) from the script are ignored.

A self-hosted service on a private network needs an operator-approved exact destination, still intersected with the user's approval; there is no user-grantable "private networks" permission. The reply is `{ status, headers, body }`, wrapped by the runner with `ok`, `text()` and `json()`; a non-2xx is a normal response, a policy or transport failure an SDK error. If Bun's HTTP client cannot pin the validated address and control redirects, `fetch` goes through a constrained egress proxy or ships disabled; hostname-only checks do not ship.

### Scripts app and editor integration

**Scripts app** (`apps/scripts/`): the usual bootstrap, auth guard, `ColumnLayout`/`Column` with toolbar, shared loading, error and empty states, CodeMirror. It lists scripts and edits source, manifest, permissions and configuration; save, run and cancel; paginated history with logs, results, duration, version and side-effect warnings. A failed save keeps the edits. Running unsaved source saves first, so history always shows what ran. Hooks live in `packages/lib/src/core/scripts/hooks/` with owner-scoped query keys and `onMutationError`.

**Extensions.** The manifest declares `context-action` records: stable ID, app, label, optional allowlisted icon, required context and entrypoint, and an optional form of bounded `text` and `select` fields rendered with existing controls. The server validates them at save and at run; the list an app shows is a filter, not a check. `ScriptsPanel` in `packages/ui` is one shared side panel. The first release ships Docs and Drive context providers; Sheets and Slides scripts work by explicit target until their providers land.

A provider sends the server serializable context (app, resource identity, selected text or IDs, input, action) and keeps a private local snapshot (tab, account, editor, document, selection anchors, revision, expected selected text). No selection objects, editors or callbacks go into a request; the server revalidates resource IDs itself.

**Results.** A run returns `{ value, actions }`. `value` is data; `actions` is a bounded discriminated union from one shared registry that maps each action to apps, schema and required token: `replaceSelection`, `insertText` and `insertContent` for a captured Docs location, and `notify`, plain text shown in the panel. Unknown actions are a visible error. Actions target the admitted document only; there is no raw HTML, executable string or URL action.

Only the initiating tab applies actions, at most once: consumption is recorded before the local transaction, so a repeated SSE event or refetch cannot reapply, and a reload never replays from history. All actions are validated before the first one applies, and compatible document actions apply in one editor transaction. If the target moved, its content changed, the account or editor changed, or write access is gone, the result shows as stale with copy and review instead of landing on whatever is selected now. Content-changing actions also need the write token and current editor write access, and are refused for any run that made a mutating SDK call, even an ambiguous one, so one edit is never delivered twice.

The rule of thumb: the SDK for durable server writes and unattended work, actions for selection edits that belong on the local undo stack.

**SSE.** `scripts:updated` for metadata, approval and configuration; `scripts:execution-updated` for every status transition, one event so cancel and timeout cannot slip through; `scripts:progress`, throttled. Payloads carry IDs and status, never source, secrets, logs, selections or results, and are sent after the row is written. They join the shared SSE union and domain dispatcher; reconnect invalidates active executions, and polling while `pending`, `running` or `stopping` covers a lost terminal event. Foreground errors use the hook error path; background failures later use `home.notifications.persist` with a typed detail and a coalescing tag, never a toast plus a panel error for the same run.

## Limits

Starting values, not measurements. They live in one limits table, the UI reads the ones it shows, and they change with load evidence. The API enforces every one; runner checks only improve error messages.

| Budget | Initial value | Enforced by |
|---|---|---|
| Source | 256 KiB UTF-8 per script | save and admission |
| Manifest, configuration | 16 KiB each | save |
| Context + input | 64 KiB | route and `init` |
| Run request body | 1 MiB | streaming read before parse |
| Scripts | 100 per owner | create |
| Active runs | 4 global, 1 per principal | dispatcher |
| Queued runs | 16 global, 2 per principal | reservation, fair dispatch |
| Queue wait | 60 s | queue expiry |
| Wall clock | 120 s including startup | API watchdog |
| Startup handshake | 5 s | lifecycle |
| V8 heap | 128 MiB target | runtime flag (not an RSS limit) |
| Frame header / body | 8 KiB / 1 MiB | framer, before allocation |
| SDK calls | 200 per run, 8 outstanding, 4 host operations active; mutating calls serialized | dispatcher |
| Result | 256 KiB | host validation |
| Log, stderr | 64 KiB each | capped buffers |
| Progress | 1 KiB, 2 per second | throttle, latest kept |
| `fetch` request / response | 256 KiB / 512 KiB decompressed | egress handler |
| `fetch` deadline | 30 s or the run's remaining time | abortable call |
| Redirects | 3 | redirect loop |
| History | 200 terminal runs per script, 64 MiB per owner | retention |

Domain methods add their own size and count limits, checked before expensive work; there is no unbounded `getAll()`.

Operational logs carry execution ID, script version, principal and owner, queue, startup and active durations, terminal reason, exit status, call counts and bytes, effect counts and queue depth; never source, bodies, configuration or content. Finalization failures and orphaned host operations are tracked on their own.

## Module layout and deployment

```text
apps/api/src/lib/scripts/
  scripts.ts        CRUD, approval, durable transitions
  schema.ts         scripts and executions tables
  db-config.ts      migrations
  runner.ts         admission and the one-shot process lifecycle
  runner.js         trusted Deno entry: framing and the SDK facade
  protocol.ts       wire schemas and validation
  sdk-handler.ts    method registry and domain delegation
  sdk-readers.ts    transform-backed document reads
  sdk-writers.ts    live document commits
  proxy-fetch.ts    constrained egress
  sse-events.ts     event builders
apps/api/src/routes/scripts.ts
packages/lib/src/types/script.ts
packages/lib/src/core/scripts/        hooks, query keys, SSE handler
packages/ui/src/components/scripts/   ScriptsPanel
apps/scripts/
```

Mutation planning lives beside the existing document, canvas and sheet primitives, exported through their barrels. The app is registered in routing, navigation, app metadata, API static serving, workspace scripts and the production build.

The API image runs source from `/app/apps/api` ([Dockerfile](../../docker/api/Dockerfile)), so `runner.js` resolves the same way in development and production. Deno is pinned by version and digest for each supported architecture, with an update policy; never `curl | sh` of latest. Run temp lives on a writable path apart from the read-only runner and Eigen data. Enabling scripting checks the runtime and protocol version; a missing Deno fails script admission clearly and nothing else, with no fallback to Bun, `node:vm` or unrestricted execution.

## Phases

| | Phase | Delivers | Size |
|---|---|---|---|
| **1** | Execution foundation: schema, identity and approval, admission, runner, framing, deadlines, cancel, recovery, operator switch | Scripts that run and log, with no SDK beyond `log` and `progress` | M |
| **2** | Domain SDK: registry, ACL and relay seams, bounded reads and writes for the flat domains, document reads, constrained `fetch` | Drive, Mail, Calendar, Contacts automation; document reads | M–L |
| **3** | Live document writes: `CollabDocument` revision, extracted Docs, Sheets and Slides writers, transform planning, conflicts | Full read/write | L, the hard part |
| **4** | Authoring and integration: Scripts app, `ScriptsPanel`, Docs and Drive providers, history, at-most-once actions | The first release | M |

The first release is phases 1–4 together; it is not cut down to read-only. The Sheets writer builds on whatever [PROPOSAL_SHEETS_YJS_WORKBOOK.md](PROPOSAL_SHEETS_YJS_WORKBOOK.md) has shipped by then rather than extracting from a model about to change.

## Later: sharing and triggers

None of these change the runtime or the execution record.

**Team and org installations.** A shared script is a versioned program, not a grant to run as its author. Each installer approves an immutable source and manifest digest; a publisher edit is a new version, never a silent swap. An installation stores its principal, approved version and grants, its own configuration (never the author's) and revocation state. Every run, manual or triggered, runs as the real user who installed or enabled it, never a synthetic team user, an event's actor or the last editor; membership and ACLs are rechecked at dispatch and per call. Source management and run history have separate ACLs: an author never sees an installer's mail, credentials or logs.

**Scheduled triggers.** The scheduler stays a bounded wake-up over durable trigger records, with a maintained cron parser added then: five-field UTC, a minimum interval, explicit next-fire semantics. A trigger records owner, script, pinned version, principal, state, schedule and next fire. An occurrence `(triggerId, scheduledFor)` gets a receipt before dispatch, separate from prunable history. No overlapping runs per trigger, missed occurrences skipped, and only delivery (never a run that may have committed) is retried. Storage needs a decision proven before code: canonical triggers in `scripts.db` with an eventually consistent server-level index (journal, idempotent updates, tombstones, boot reconcile without opening every Home), or one authoritative scheduler database with owner-scoped access. There is no transaction across the two.

**Event triggers.** Events come from domain mutation seams after commit, never from browser SSE or `Home.broadcast()`. They carry a stable event ID, resource, actor, originating run or trigger and causal depth. Rules match in bounded batches, access is rechecked as the trigger's principal, and inputs are read through that principal's SDK rather than copied from another user's event. `(triggerId, eventId)` dedupe, per-trigger budgets, and loop suppression (a script's own causal chain excluded by default, cross-script cascades bounded); high-frequency document edits debounce. Reliable delivery needs a durable outbox at the mutation seam ([PROPOSAL_HOME_RELAY_OUTBOX.md](PROPOSAL_HOME_RELAY_OUTBOX.md)); no exactly-once promise.

## Testing

Contracts, not runner mocks.

| Area | Cases |
|---|---|
| Lifecycle | infinite loop, unresolved promise, startup failure, unexpected exit, timeout mid-call, cancel pending and running, cancel/done race, shutdown, abrupt restart |
| Protocol and budgets | split and coalesced frames, partial writes, malformed and oversized headers and JSON, duplicate call IDs, non-JSON results, cyclic logs, stdout and stderr floods, overload, fair dispatch |
| Authority | spoofed principal and grants, cross-owner IDs, shared read-only resources, guest rejection, permission revocation, manifest edit while queued, stale source version |
| Runtime and network | native net and remote, npm and local imports denied; clean environment; no cross-user cache; origin bypasses, redirects, DNS rebinding, IPv6, compressed response limits |
| Persistence | retry-key conflict and dedupe, hand-off failure, Home reopen vs API restart, failed finalization write, delete during a run, active-row retention |
| Writes | domain validation, SSE and history preserved; failure after commit; no retries; no managed-DB bypass; oversized batch rejected before commit |
| Collaboration | two connected editors; a concurrent edit gives `CONFLICT` or the documented merge; delete-only updates move the revision; formulas and frame bindings survive; reload proves persistence |
| UI | selection, document or account switch while running; panel close and reopen; permission loss; duplicate and lost SSE; reconnect and polling; reload without replay; no double application |

Real Deno permission and protocol probes run against the pinned release on the supported dev and production platforms. Load measurements cover startup latency, API responsiveness, total RSS and disk; a heap test proves nothing about the machine. Plus `bun run check` and browser verification of authoring, live edits and stale results ([VERIFICATION.md](../VERIFICATION.md)).

## Open questions

1. Does the flag set above hold on the pinned Deno release: the trusted entry loads, script code reads nothing, and no import path (including default-allowed hosts) resolves? Phase 1 starts with that probe.
2. What does a cold Deno spawn cost on the production host? If it dominates short runs, prewarming comes back, measured, not assumed.
3. Can Bun's `fetch` connect to a pre-validated address with correct TLS SNI and manual redirects, or does egress need a small proxy? Until one works, `fetch` ships disabled.
4. How much does Deno add to the API image per architecture, and is a separate runtime image the better seam for deployments that keep scripting off?
5. For triggers: the server-level index over `scripts.db` or one scheduler database? Decide with the trigger work, not before.
