# Eigen Scripting Platform

> **Status: proposal, not implemented.** Audited against `6a4a56947` on 2026-09-06. The first release includes full read/write scripting. Scheduled/event triggers and team/org distribution follow later, without changing the execution or permission model.

Server-side JavaScript automation, inspired by Google Apps Script: users author scripts in a Scripts app, run them manually or from an app sidebar, and access Eigen through a typed, permission-checked SDK. Each execution runs in a fresh Deno subprocess. The API owns authorization, execution records, resource budgets, and all SDK operations.

## Audit Decisions

This revision replaces the previous implementation sketches with contracts that must be satisfied before shipping.

| Previous problem | Revised design |
|---|---|
| A prewarmed pool killed every worker after one execution, justified by unrelated cold-start figures | Start with bounded spawn-per-execution, as agreed during review. Measure local startup latency before adding prewarming |
| The timeout was cleared after sending initialization, rather than after execution finished; completion and recycling called into each other | One parent-owned execution lifecycle, one terminal transition, and a watchdog that remains armed through worker termination |
| Broad `--allow-net` let native `fetch` bypass the SDK; omission of `--allow-import` was described as an import ban | Deny worker network access and external module resolution explicitly. All permitted HTTP traffic goes through the host |
| SDK examples used nonexistent ACL helpers and confused resource ownership with the executing user | Reuse the actual domain authorization seams and carry script owner, principal, and resource owner separately |
| A “read-only MVP” also promised editing actions | Full backend read/write and guarded editor actions are first-release requirements. They use distinct execution paths, never both for the same edit |
| Document plans mixed current readers with obsolete slides roots and speculative content types | Reuse the existing document/transform layer, sheet types, and shared canvas model; add live-safe writers rather than treating import writers as live editing APIs |
| Delayed results replaced whatever selection was current when SSE arrived | Bind results to the initiating tab, document, selection snapshot, and execution; stale results remain inspectable but never silently edit a new target |
| Cron registration promised an atomic transaction across separate Home and server databases | Future scheduling needs a recoverable index, explicit principal, deduplication, and restart policy; no cross-database atomicity claim |

The source anchors for these decisions are [Home lifecycle](../../apps/api/src/lib/home/home.ts), [Home resolution](../../apps/api/src/lib/home/get-home.ts), [API shutdown](../../apps/api/src/index.ts), [access helpers](../../apps/api/src/lib/core/access.ts), [document content](../DOCUMENT-CONTENT-LAYER.md), [transform workers](../DOCUMENT-TRANSFORMS.md), [canvas architecture](../CANVAS.md), and the [scheduler](../../apps/api/src/lib/scheduler/scheduler.ts).

## Scope and Core Decisions

| Area | First release | Follow-on |
|---|---|---|
| Authoring | Personal JavaScript source, manifest, persistent configuration, named entrypoints, editor diagnostics and SDK completion | Dependency bundling, reusable libraries |
| Execution | Manual asynchronous runs, bounded queue, progress/logs/results, cancellation and restart recovery | Cron and domain-event triggers |
| SDK | Read/write operations for Drive, Docs, Sheets, Slides, Mail, Calendar and Contacts | Additional methods through the same checked registry |
| Editor integration | Shared Scripts panel, Docs and Drive context providers, explicit-target SDK access to the other domains | More app context providers and richer extension surfaces |
| Distribution | Only the author can manage or execute a personal script | Versioned team/org installations approved by each executing user |
| Runtime | One fresh Deno process per execution, no ambient network or Eigen credentials | Prewarming or a separate supervisor only if measurements justify them |
| Operations | Server enable/disable control, bounded resources, operator-visible failures, pinned runtime | Per-org policy, dedicated runtime isolation for broader trust models |

“Full read/write” means useful supported operations in every listed domain, including live-safe document writes; it does not mean exposing every backend method or arbitrary storage access. The public method registry is an explicit capability surface. A method is not ready until its authorization, input/output bounds, concurrency behavior, and failure semantics are implemented.

`getActive()` is available only where an app supplies the corresponding active-document context. Scripts elsewhere use `getById({ ownerId, mountId, pathId })`. A scheduler has no selection or active editor; explicit-target scripts should need no changes to run unattended later.

## Trust and Permissions

### What the boundary guarantees

Scripts are trusted by their authors, not trusted with the server's authority. Enable scripting only for trusted regular users on an operator-controlled instance; reject guests and non-user principals in the first release. The server setting defaults to disabled and turning it off stops admission and requests cancellation of active runs. This control is necessary in the first release, not only after sharing exists. Demo deployments keep it disabled.

Every SDK operation must satisfy all of these checks:

1. The execution is still authorized and within its budgets.
2. The method is registered and the parameters pass its runtime schema.
3. The immutable grant approved for this execution includes the method's required permissions.
4. The authenticated principal still has the ordinary domain permission on the requested resource.

The parent binds these facts to its own execution record and subprocess handle. Worker-supplied user IDs, grants, execution IDs, and success messages are not authority. Freezing `eigen` is an ergonomic guard, not a security boundary: script code shares the runner's JavaScript realm and can write to stdout.

Separate processes isolate ordinary crashes and JavaScript heaps, not machine-wide CPU, RSS, disk use, or runtime vulnerabilities. A V8 heap limit is not an RSS limit; it may abort the process and does not bound every native allocation. Deno also has runtime-managed caches/storage that are not equivalent to ordinary filesystem permissions. Do not claim hostile-code containment. Public marketplaces, untrusted shared authors, and tenant isolation require a separately reviewed OS/container boundary before they are supported.

Use the [Deno security model](https://docs.deno.com/runtime/fundamentals/security/) and [permission reference](https://docs.deno.com/runtime/reference/permissions/) for the pinned release, rather than an undated CVE list or an unmeasured sandbox claim.

### Identity and approval

Keep these identities distinct in all shared types and execution records:

| Field | Meaning |
|---|---|
| `scriptOwnerId` | Home storing the script and execution history |
| `principalUserId` | Real user whose current ACLs govern the run |
| `resource.ownerId` | Home owning a particular document, file, calendar, or other target |
| `initiator` | Manual invocation now; later a particular trigger or installation |

For personal runs, `scriptOwnerId === principalUserId === authenticatedUser.id`. This does **not** force all resources to belong to that user: ordinary Drive shares and team/calendar access still work through the existing ACL wrappers. Conversely, knowing an `ownerId` never grants access to its Home.

The manifest declares permissions, network origins, and extensions. The server validates all of it, rejects unknown tokens/actions, and records approval of a normalized manifest digest. A client-side confirmation alone is insufficient. The first run requires approval; a permission or network-policy change invalidates the grant and stops affected queued/running work. The actual grant and source revision are captured at admission, not read from an editable manifest at each worker call.

Source/configuration saves use optimistic version checks to avoid overwriting another editor's changes. Saving source creates a new version; an already admitted run keeps its source snapshot. Disabling or deleting a script revokes outstanding execution authority. Configuration changes invalidate queued/running snapshots using the previous configuration revision so replacing a credential does not leave queued work using the old value.

Use explicit read/write tokens for `drive`, `docs`, `sheets`, `slides`, `mail`, `calendar`, and `contacts`, plus `fetch`. A write token does not implicitly grant reads. Registry entries can require multiple tokens when an operation genuinely reads and writes. The manifest permission schema, method requirements, and editor SDK declarations must have one canonical definition, not independent lists.

Frontend actions that edit content require the matching write grant as well as current editor write permission. `fetch` is a disclosure permission: the approval UI explains that source, configuration, and any data the script can read may be sent to the approved origins.

## Persistence

Use `Home.getLocalDatabase()` and `ManagedDatabase` at `{home}/eigen.scripts/scripts.db`, with the normal `schema.ts` and versioned `db-config.ts` layout. Do not add scripting tables to the share registry merely because it uses a server-level SQLite database.

### Scripts

| Column | Purpose |
|---|---|
| `id` | Server-generated identifier |
| `name`, `description` | Bounded display metadata |
| `source` | JavaScript source, bounded by UTF-8 bytes |
| `manifest` | Schema-validated permissions, exact network origins, extensions and entrypoints |
| `config`, `configRevision` | Persistent per-script configuration and its revision |
| `version` | Monotonic save version used for optimistic updates |
| `approvedManifestDigest`, `authorizationRevision` | Server-recorded approval and revocation generation |
| `enabled` | Whether new execution is allowed |
| `createdAt`, `updatedAt` | Epoch milliseconds |

Configuration can contain credentials. Personal configuration remains in the private Home database for this release, with an explicit plaintext-at-rest limitation; filesystem protection and backups protect it just like the database. It is not returned in script listings, extension discovery, SSE, or execution history. Secret-valued fields use a separate write/replace UI; a masked value must never overwrite a real value on save. Do not log configuration or SDK request bodies.

An admitted run receives a private in-memory configuration snapshot. History records the configuration revision, not a second credential copy. There is no automatic replay after restart, so a durable secret snapshot is unnecessary. An authorized script can intentionally print or return its own secrets: logs/results are private user data, not a reliably redacted secrets boundary. Shared installations must have installer-owned configuration, not access to the author's personal configuration.

### Executions

| Column/group | Purpose |
|---|---|
| `id`, `scriptId` | Execution identity and owning script |
| `principalUserId`, `initiator` | Who authorized the work and why |
| `scriptVersion`, `sourceSnapshot`, `manifestSnapshot` | Immutable admitted code and capability declaration |
| `grantedPermissions`, `authorizationRevision`, `configRevision` | Admitted approval context |
| `entrypoint`, `context`, `input` | Validated, bounded invocation snapshot; no client-authored principal |
| `runtimeId` | Unique API/supervisor generation that admitted the execution |
| `requestKey`, `requestDigest` | Optional caller retry key and payload fingerprint, unique within the principal's script scope |
| `status` | `pending`, `running`, `stopping`, `completed`, `failed`, `timeout`, `cancelled` |
| `createdAt`, `startedAt`, `finishedAt` | Queue, start, and terminal timestamps; start/finish nullable until reached |
| `deadlineAt`, `durationMs` | Persisted deadline for display/recovery and measured active duration |
| `progress`, `log` | Capped latest progress and log tail |
| `result`, `error` | Validated result or structured public error |
| `effects` | Mutating-call count and whether side effects may have committed despite failure/cancellation |

Use indexes for `(scriptId, createdAt, id)` pagination, active status lookup, and request-key deduplication. Records belong to the script owner, but future shared runs must be readable only by their principal unless separate history-sharing consent is introduced. Script authors must not automatically gain access to another user's result, input, or logs.

Retention prunes **terminal** rows only, with per-script count and aggregate per-owner byte limits. Account for source/context/result/log bytes, not just row count. Keep active rows and their input snapshots until finalization. Run pruning on terminal transitions and database initialization, and reject admission if storage cannot remain within its bound. Cancellation/termination precedes script deletion and removal of associated history; never delete a row underneath a live worker.

Retry-key deduplication lasts while the execution record is retained. Reusing a key with a different request returns a conflict. The UI must not retry execution automatically after a missing/expired record. Durable trigger deduplication later uses separate scheduler receipts, not prunable UI history.

### Recovery and Home lifetime

Home cold-start is not API restart. On opening a scripts database, mark nonterminal rows from a **different** `runtimeId` as failed with `EXECUTION_INTERRUPTED`; do not fail work owned by the current runner simply because its Home reopened. These failures state that earlier mutations may already have committed. Do not replay scripts automatically.

For the personal release, constructing `Scripts` in `UserHome` is only one part of integration: add its initialization, failure cleanup, and destruction to the corresponding Home lifecycle lists. Unsupported Home variants need an explicit capability guard, not a definite-assignment getter that returns `undefined`. The runner pins admitted Homes through the existing `touchHomeIfLoaded()` mechanism until queued/running work is finalized, and stops touching them on release.

On shutdown, stop admission and scheduled dispatch, cancel queued work, terminate/drain script executions, then close transform workers and Homes. A script may be awaiting a document transform or using a Home database, so shutting those down first is incorrect. Follow the existing bounded shutdown discipline in `apps/api/src/index.ts`.

## HTTP and Execution Lifecycle

All personal routes use `/scripts/:ownerId` and require `requireSelf(ownerId, user.id)` plus scripting eligibility. CRUD, approval/configuration writes, extension discovery, run, cancel, and history endpoints are owner-scoped. Discovery returns only enabled, approved extensions applicable to the current app; it never includes source or configuration.

An execution request identifies the saved `scriptId`, expected `scriptVersion`, declared entrypoint, optional retry key, input, and editor context. It cannot submit replacement source, elevated permissions, or a principal. Enforce a route-specific body-byte cap while reading the body, before allocating/parsing unbounded JSON; field schemas then enforce source and nested-input limits. The API's global body limit is much larger and is not sufficient.

1. Authenticate and validate eligibility and the static request shape. Look up a retry key in the authorized script/principal scope before reserving capacity or checking the script's current mutable version: an identical retry returns the existing execution even if the queue is now full or the script has since been edited. A different request digest is a conflict. For a new run, validate source version, approval, entrypoint, context and resource access.
2. Reserve bounded admission capacity **before** expensive preparation or spawn. Return `429` for a principal's limit, `503` for disabled/unavailable runtime or global saturation.
3. In one scripts-DB transaction, recheck the saved version/authorization revision and insert the immutable `pending` execution. Concurrent requests for one retry key converge on the unique row; return that execution for the same digest and release the redundant reservation. Release the reservation on failure too.
4. Hand the admitted record to the in-memory dispatcher without an intervening unowned asynchronous gap. Return `202 { executionId, status: 'pending' }`; the response describes acceptance, not an assertion that a process has already started.
5. Dispatch fairly across principals, FIFO within a principal. Recheck enablement, account/approval validity, and queue expiry before spawn. Transition to `running` when the child is launched; the deadline includes startup.
6. Service bounded SDK requests and progress/log messages. On finish, error, cancellation, timeout, invalid protocol, or process exit, enter the one finalization path.
7. Stop new SDK calls, reject queued calls, abort cancellable in-flight I/O, kill/reap the child, and persist exactly one terminal outcome. Broadcast only after the durable row update.

`POST` cancellation is owner/principal checked and idempotent. A pending run is removed before it can spawn; a running run becomes `stopping` while the parent terminates it. Completion, cancellation, timeout, process exit, and duplicate worker messages race through one compare-and-set transition. A late `done` cannot overwrite a timeout or another execution.

No automatic retry of script executions or mutating SDK calls. A timeout/cancel stops further dispatch; it does not roll back completed file writes, sent mail, calendar changes, or external HTTP requests. Operations already past their commit point may still finish. Keep such host operations tracked and bounded until settlement, even if their worker is gone, and report ambiguous side effects instead of implying “nothing happened.” A final worker result is not a distributed transaction.

If final persistence fails, do not emit a success-shaped event or silently forget the execution. Keep it in the runner's bounded finalization set, surface an operational error, and retry the database transition within the shutdown/resource budget; restart recovery remains the last-resort interruption marker.

## Execution Environment

### One-shot Deno runner

Use a process-wide dispatcher in the API process, with one fresh Deno subprocess for each dispatched execution. The child accepts one initialization message and is never reused. The scripts domain owns durable records; the dispatcher owns admission, subprocess handles, deadlines, and finalization. Neither recursively calls the other's completion routine.

There is no need to extract a separate Bun supervisor merely to “move script CPU off the API”: Deno subprocesses already do that. The API still needs bounded RPC parsing, network work, and off-thread document transforms. A supervisor remains a possible later deployment seam, not a second implementation of domain operations or Home state.

The worker starts a trusted, dependency-free `runner.js` shipped with Eigen; script source arrives over stdin, not through a filesystem path, shell interpolation, or command-line argument. Launch via an argument vector, not a shell.

For the pinned Deno release, require `--no-prompt`, `--deny-read`, `--deny-write`, `--deny-net`, `--deny-env`, `--deny-run`, `--deny-ffi`, `--deny-sys`, and `--deny-import`, together with `--no-config`, `--no-npm`, `--no-remote`, and disabled lockfile discovery. The trusted entry module loads without granting script code general filesystem read access. Verify that combination against the pinned binary; do not fall back to broad permissions if a flag or dependency fails.

Only the trusted runner is in the initial static module graph. Deno distinguishes module loading from ordinary network/read permissions, and some import hosts are allowed by default. Thus neither “omit allow-import” nor “deny-net” alone is an import policy. The authoring contract is self-contained JavaScript: no external modules, npm, runtime package installation, TypeScript compilation, or DOM. Evaluating source text does not make arbitrary same-privilege JavaScript execution impossible; that is not the promise.

Launch with an explicit minimal environment, not the API's environment. Do not inherit permission-broker, loader, proxy, inspector, telemetry, or runtime-option variables. Set only the runtime/cache/temp variables needed for the pinned runner, including disabling runtime update checks. Give each execution private temporary/cache state outside Eigen data and remove it after reap; do not share mutable Deno KV/cache storage between users. Document and provision disk limits as well as memory limits.

The parent owns the absolute monotonic deadline until the child has been terminated, not merely until the initialization frame is written. Treat spawn failure, startup timeout, unexpected exit, truncated stdout, and protocol failure as explicit outcomes. Continuously drain capped stderr to avoid a blocked pipe. All detached async operations have observed rejection paths.

Deno denies subprocess creation. Do not assume a `setsid` executable exists on macOS or that negating an arbitrary child PID kills a valid process group. Kill/reap the exact child through the supported process API; if deployment hardening adds a process group or cgroup, create and track it explicitly. Runner EOF/control-channel loss exits the child; an independent child-side deadline bounds an orphan after an abrupt API death. This is not a defense against a hostile busy loop after supervisor loss: production containment needs the deployment's process/container lifecycle.

### Framed protocol

Use Content-Length-framed UTF-8 JSON over stdin/stdout, with a closed, versioned envelope. Do not call the old mixed control-message format JSON-RPC 2.0 unless it actually implements that protocol. A small custom RPC protocol is sufficient.

| Direction | Message |
|---|---|
| Parent to child | One `init` carrying invocation snapshots and protocol version |
| Child to parent | `ready`, `call { callId, method, params }`, `log`, `progress`, `done`, `error` |
| Parent to child | `result { callId, value }`, `error { callId, code, message }`, cancellation/control |

The parent associates every message with the child handle and admitted execution. Numeric `callId`s are unique within that execution, with duplicate and outstanding-call limits. Messages cannot choose another execution. Unknown methods, unsolicited responses, duplicate terminal messages, and invalid shapes fail closed.

The framing implementation must handle split/coalesced frames, partial writes, backpressure, and EOF. Bound the header and announced body **before** allocation; require one valid nonnegative Content-Length, fatal UTF-8 decoding, and a schema-valid JSON body. Do not grow an unbounded concatenation buffer or queue arbitrary outstanding writes. Serialize writes through one bounded writer so headers/bodies cannot interleave.

Supported values are JSON-safe data. Normalize an absent script return to `null`; reject cycles, BigInt, functions, nonfinite numbers, and oversized/deeply nested values with a structured serialization error. Host responses, logs, progress, errors, and results have independent limits. The host enforces them even if the runner bypasses its own helpers. Console formatting must tolerate cyclic values and must not crash the execution merely while trying to log an object.

The SDK may use thin proxies for document handles, but only registered methods are callable. Symbols, `then`, `toJSON`, and introspection must not accidentally dispatch RPC; a document handle is not a thenable. Identity/target fields baked into a handle cannot be overridden by spreading call parameters afterward. Entrypoint names are validated identifiers from the admitted manifest, never arbitrary expressions interpolated into generated code.

## SDK and Domain Access

The server's `SDK_METHODS` registry is the one authority for method names, input/output schemas, required permissions, mutating/read-only classification, and resource bounds. Typed SDK declarations and editor completion derive from it. Runtime schemas validate the worker boundary; shared types live in `packages/lib/src/types/script.ts`. Keep the backend and Deno contract React-free.

Document domains use `eigen.docs/sheets/slides.getActive()` or `getById({ ownerId, mountId, pathId })`. These are local handles; data operations return promises. Flat domains use `eigen.drive/mail/calendar/contacts.method(params)`. Flat calls may default `ownerId` to the principal's personal Home; document handles use the captured document's actual owner, never `eigen.user.id`.

Do not invent a blanket `validateOwnerAccess()` or `requireOwnerAccess()` and then hand scripts an unrestricted Home. Reuse `getSharedDrive(ownerId, user)` for Drive/document access. Calendar collection access uses `resolveCalendar(user, ownerId)`; event operations use `checkCalendarAccess(user, ownerId, calId)` and require write permission for mutations. Mail and Contacts remain personal-only through `requireNonGuest` and `requireSelf`; scripting does not expose Mail's localhost delivery endpoint. Follow [ACL](../ACL.md) and [Home relay](../SCALABILITY.md); direct `getHome(otherOwnerId)` is not a shard-aware permission check. Cross-home reads/writes stay inside the established domain/relay seams. A new relay verb needs a serializable checked contract, not an escape hatch around a wrapper.

### First-release capabilities

| Domain | Reads | Writes and constraints |
|---|---|---|
| Drive | List folder, path metadata, bounded ordinary-file reads | Create folder/file, write ordinary-file contents, rename, in-mount move, copy, trash; delegate to existing Drive/SharedDrive methods and their history/SSE behavior |
| Docs | Text and existing `JSONContent`, with revision-bearing reads for edits | Insert/replace text and structured content through a live Yjs/Tiptap-safe transaction |
| Sheets | Sheet metadata, cells, bounded ranges and sheet data | Set/clear cells, range values/formulas/formatting and supported sheet structure changes through the same operation semantics as the editor |
| Slides | Frames and elements from the shared `VectorScene` model | Add/update/remove frames and elements, text and supported properties through shared canvas operations |
| Mail | Bounded mailbox/message queries and message content | Send and supported message/folder mutations through Mail's existing validation and side-effect paths |
| Calendar | Calendars, event lists and event details | Create/update/delete events through existing invitation, recurrence and cross-owner semantics |
| Contacts | Contact and label queries | Create/update/delete contacts and label changes through the canonical vCard-backed Contacts domain |

Method-specific request/result shapes come from the existing domain contracts, not a generic `method: string` reflector. Exclude internal maintenance/admin methods. SDK entrypoints recheck current access for every operation; cache schema/metadata, not an authorization verdict across the entire run.

Retain the intended convenience methods: `docs.getText/getJson/insertContent`, `sheets.getCell/getRange/getSheetData/setCell/setCellRange`, and `drive.listFolder/getPath/readFile/writeFile/create`. Slides can offer `getDeck/insertSlide` as vocabulary over frames in `VectorScene`, not as another stored deck format. Add explicit named methods for the remaining capabilities above. File bytes cross RPC only through a declared bounded text/base64 encoding; dates use one documented wire representation.

Drive byte APIs must not expose direct writes to managed document databases, hidden container internals, or storage keys. Typed document operations use the document writers below. Enforce domain-token semantics consistently for document-content reads too; a raw `data.db` read must not become a bypass around the typed content policy.

Paginate collections with bounded cursors. Validate file sizes, cell counts, range dimensions, nesting and operation counts before materialization; an output-byte guard after loading an entire mailbox or workbook is too late. Use stable IDs, not array indexes as identity. Preserve existing errors rather than replacing every failure with “SDK call failed.”

SDK errors use stable public codes such as `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `NOT_FOUND`, `CONFLICT`, `LIMIT_EXCEEDED`, `UNAVAILABLE`, `CANCELLED`, and `INTERNAL`, plus a bounded message. Map domain `ApiError`s consistently; neither raw stack traces nor filesystem paths cross to a script. A script may catch an operation error, but a successful later return does not erase the history of already committed mutations.

### Document content and transforms

The document layer already exists. Reuse [DOCUMENT-CONTENT-LAYER.md](../DOCUMENT-CONTENT-LAYER.md) and [DOCUMENT-TRANSFORMS.md](../DOCUMENT-TRANSFORMS.md), rather than introducing parallel `DocContent`, `SheetContent`, or legacy deck schemas.

| Existing primitive | Use |
|---|---|
| `readEigendocFromDoc` | Docs `JSONContent` |
| `readSheetsFromDoc`, `replaySheetsOps`, `opToPatchOnSheets` | Current sheet snapshot decoding and op replay, with canonical `Sheet`/`Cell` types |
| `readVectorFromDoc`, `VectorScene` | Shared Slides/Vector `elements`, `frames`, `meta` model |
| Document media helpers | Resolve media references separately; never send server paths or storage handles |
| Transform runner and its closed protocol | Off-thread bounded reconstruction, extraction, rendering and mutation planning |

SDK document reads add explicit bounded operations to the transform protocol, with typed JSON-safe results and admission costs; do not pass callbacks, Homes, Mounts, databases, or live Y.Docs into a worker. Use the established capture path, with a documented consistency point that includes acknowledged live changes. Never add a main-thread materialization/recalc fallback.

Sheets reads follow existing replay/recalculation policy; do not silently introduce full-workbook recalc on every `getCell()`. Expose stale/computed-value semantics and relevant warnings. A1 parsing should reuse the existing spreadsheet address helpers where possible, validate bounds, and identify a stable sheet explicitly rather than introducing another incompatible parser.

### Live-safe writes are a first-release prerequisite

Import-time whole-document writers are not automatically safe for scripts. A detached Y.Doc mutation or replacement of a database snapshot will not reliably update connected editors. Every document write obtains the ACL-checked **live** CollabDocument and commits through its normal update/persistence/broadcast path.

Each document handle offers an explicit bounded `readWithRevision(...)` operation returning `{ revision, content }`, with content typed for the requested document/range. Convenience reads such as `getText()` keep their simple return shapes; they are not enough to authorize a later optimistic replacement. Planned edit methods require `expectedRevision`, and return the post-commit revision so consecutive writes can deliberately chain.

The opaque token identifies a live-document generation and a change sequence covering **every** update, including delete-only updates; a sheet op count or bare Yjs state vector alone is not a sufficient revision. Reopening a document invalidates an old generation instead of allowing a stale write. No suitable live revision exists today: add it once on `CollabDocument`, driven by its Yjs update events, not independently in every SDK domain or using the persistence counter that resets at snapshot time.

Bind a read's revision to the exact captured state: capture from the same live generation, include its unflushed acknowledged changes, and reject/retry within a small fixed bound if the generation/revision changes across asynchronous preparation. Never attach a current revision to an older database snapshot. Read-after-write within an execution must see the preceding acknowledged write.

For a planned edit: capture content/revision, perform expensive planning in a transform worker, obtain/recheck current write permission, then check cancellation, grant generation and the live revision immediately before one synchronous Yjs transaction. No intervening `await` may separate the final guards from commit. A mismatch returns `CONFLICT`; do not automatically rerun user logic against a new document or overwrite a collaborator's edit. Operation forms that intentionally merge by stable ID must specify that behavior separately.

| Type | Required write path |
|---|---|
| Docs | Reuse the editor's Tiptap schema and Yjs XML representation; apply a planned transaction/update to the current live fragment, retaining unrelated content and supported marks. Validate structured content at the boundary |
| Sheets | Extract/reuse the frontend's op-building and Yjs op-push semantics in the React-free shared sheet layer. Preserve stable sheet IDs, ordered op IDs, snapshot compatibility and formula behavior; never patch an unrelated cell schema or overwrite the snapshot while editors are connected |
| Slides | Reuse/extract pure canvas mutation logic and registry validation for `elements`, `frames`, and `meta`. Preserve scalar field encoding, frame membership/order, element IDs, media references and bindings; do not recreate obsolete `slides/objects/slideOrder` roots |

These extractions are proposed work, not existing `pushOpsToYDoc()` or `buildSetCellValueOp()` APIs. Keep package direction `sheet -> lib`, `ui -> lib`; backend-shared mutation primitives cannot import a React hook. Shared utilities/types must be publicly exported and catalogued.

One mutating SDK call is the unit of validation/commit where the underlying domain supports it. Cross-document and cross-domain batches are explicitly non-atomic. Server-origin edits do not automatically belong to an initiating browser's undo manager; document that distinction and use existing file history/versioning rather than promising one-click undo of an entire script.

Do not deliver a second frontend content edit for a mutation already committed by the SDK. Connected editors receive server document writes through collab updates; ordinary domain changes use their existing SSE paths. The host rejects content-changing result actions for any execution that issued a mutating SDK call, even if that call failed ambiguously. This avoids guessing whether two differently shaped edits represent the same operation.

### Network access

`eigen.fetch()` is an RPC, not native Deno fetch. The parent grants only the intersection of the script's approved exact origins and operator policy. It receives no ambient session cookies, Eigen API tokens, server authorization headers, or proxy configuration. An origin is normalized scheme/host/port, not a substring or suffix match.

The network handler must reject URL credentials, unsupported schemes, unapproved origins, and prohibited addresses. For public origins, resolve all address candidates, reject loopback/private/link-local/multicast/unspecified and other non-public destinations (including IPv4-mapped IPv6), and bind the actual connection to a validated address while preserving hostname/TLS verification. Recheck on every new connection. “Resolve, then call ordinary fetch(url)” is not sufficient if fetch resolves again.

Process redirects manually: validate every hop, bound the chain, and do not forward credentials across origins. Bound request bytes, decompressed response bytes, headers, time, and concurrent requests; propagate execution cancellation. Ignore caller attempts to set transport headers such as `Host`, `Content-Length`, connection/proxy headers, or cookies.

Self-hosted/private services require an explicit operator-approved exact destination/network exception, still intersected with user approval; users cannot grant themselves access to internal services. There is no broad “allow private networks” script permission. If the selected HTTP client cannot enforce connection binding and redirect policy, use a constrained egress proxy or keep fetch unavailable until it can; never silently ship hostname-only checks.

RPC returns a bounded serializable response `{ status, headers, body }`. The runner may wrap it with familiar `ok`, `text()` and `json()` helpers; a native `Response`, stream, or function is not serializable over JSON. HTTP non-2xx is an inspectable response; transport, policy, limit and cancellation failures are SDK errors.

## Frontend and App Extensions

### Scripts app

Use the existing app bootstrap, authenticated route guards, `ColumnLayout`/`Column` toolbar pattern, shared loading/error/empty treatments, and CodeMirror editor infrastructure. Do not introduce another app shell or error-handling convention.

The app provides a script list, source editor, manifest and permission editor, private configuration editor, save/run/cancel controls, and paginated execution history with logs, results, duration, revision and side-effect warnings. Save errors/conflicts do not discard edits. Running unsaved source requires saving a revision first; the displayed execution always identifies what actually ran.

Data hooks belong in `packages/lib/src/core/scripts/hooks/`, use owner-scoped query keys with enabled/stale-time guards, and handle mutations through `onMutationError`. Shared contract types belong in `packages/lib/src/types/script.ts`, not an app component or React-dependent barrel.

### Extension declaration

The manifest declares bounded extension records: stable action ID, `type: 'context-action'`, app, label, optional allowlisted icon, supported context requirements, and named entrypoint. An optional input form has bounded named `text`/`select` fields and select options, rendered with existing controls; it is not executable UI. An all-apps selector means all apps that actually mount a provider, not a fabricated document context. The server validates entrypoints, form input and supported app/action combinations at save and invocation. The list shown in an app is a convenience filter, not an authorization check.

`ScriptsPanel` is shared UI, composed like existing side panels rather than forcing each app to invent a layout. The first release supplies Docs and Drive providers. Sheets/Slides scripts remain fully usable by explicit target from the Scripts app; `getActive()` there becomes available when a matching provider is added.

A provider separates serializable server context from a private local application snapshot:

| Side | Data/responsibility |
|---|---|
| Server context | App, actual resource identity, selected text/IDs, validated input and declared action |
| Local snapshot | Initiating tab/session, account, editor instance, document identity, selection anchors/revision and expected selected content |
| Result application | Validate all actions, current principal/write access, context match and conflicts before changing editor state |

Do not serialize a ProseMirror selection, editor instance, callback, or other live object into an execution request. The backend revalidates resource IDs and context access; the frontend cannot establish the principal by including a user object.

### Result and action contract

Execution output uses an explicit envelope `{ value, actions }`, not “interpret every returned array as UI commands.” Value is JSON-safe data; actions are a bounded discriminated union. The shared action registry maps each action to supported apps, schema and required permission. Unknown or unsupported actions are a visible error, not ignored.

Content actions retain `replaceSelection`, `insertText` and `insertContent` for captured Docs locations. `setCellValue`/`setCellRange` actions require a future Sheets provider; first-release sheet mutations use the SDK. Actions refer to the admitted target, never an arbitrary new document chosen by a result. Destructive actions require both the execution's write grant and current editor write access. A bounded `notify` action displays plain text in the result panel, not an unrestricted toast/HTML capability. Raw HTML, executable strings and browser URLs are not generic action capabilities.

Only the initiating tab/session may apply an execution's actions, at most once. Record consumption before dispatching the local transaction; repeated SSE events or query refetches must not repeat it. A lost tab/reload never replays edits automatically from history. All returned actions are validated before the first local mutation; compatible document actions apply in one editor transaction.

While a script runs, the user may move the selection, switch documents/accounts, close the panel, or receive collaborator edits. Retain the original anchors and expected content. If the target no longer resolves, content changed, the account/editor changed, or write permission disappeared, show the result as stale and offer copy/explicit review instead of substituting the current selection. A cursor-only move is not permission to retarget an operation.

SDK writes and editor actions are separate choices: use the SDK for unattended/durable server mutations, and editor actions for selection-based edits with normal local undo. The initiating app must be loaded/synced before capturing context, and selection-derived server edits must have a server-verifiable revision; unsynced local state is not interchangeable with backend content.

### SSE and reconnection

Use `scripts:updated` for script metadata/approval/configuration changes, `scripts:execution-updated` for every execution transition, and `scripts:progress` for capped/throttled progress. One status-change event replaces separate started/completed/failed events so pending cancellation and timeout cannot fall through the refresh path. Payloads carry identifiers and status, not source, secrets, logs, selected text or full results. Persist state before broadcasting; status events are invalidation hints, not the durable result transport.

Register script events in the existing shared SSE type union and domain dispatcher. Invalidate script lists/detail, extension discovery and execution lists/detail using `ownerId` and resource IDs. Reconnect invalidates active execution queries; bounded polling while pending/running/stopping provides a fallback if a terminal SSE event is lost. All tabs can observe status, but only the initiating one holds an actionable local snapshot.

Foreground request errors use the normal hook error path. Background-run failures later use `home.notifications.persist(...)` with a typed script-execution detail and a stable tag/coalescing policy. Avoid duplicate global failure toasts plus panel errors for the same manual run.

## Follow-on Triggers and Sharing

These features may ship later; the first-release execution request already records principal, script owner/version, authorization revision, initiator and input separately so they do not require a new runtime.

### Team/org installations

A shared script is a versioned program, not a grant to run as its author. Every installer approves an immutable source/manifest digest; a publisher edit creates a new version and cannot silently replace approved executable code, even if the permission list is unchanged. An installation stores principal, approved version/grants, installation-owned configuration, and revocation state.

Manual runs execute as the installer. Scheduled/event runs execute as the real user who enabled the trigger, never a synthetic `team_`/`org_` user, the resource event's actor, or whichever user most recently edited the script. Recheck account existence, installation approval and current membership/ACLs at dispatch and before operations. Revocation disables affected triggers and stops outstanding work.

Keep source management ACLs separate from execution-result ACLs. A shared author must not see another installer's mail, credentials or execution logs. Cross-home lookup/execution remains behind explicit domain/relay operations; `getHome("team_...")` does not become remote routing merely because its ID has a prefix.

### Scheduled triggers

Use the existing scheduler as a bounded wake-up mechanism over durable trigger records; it currently provides `scheduleInterval`, not a `Bun.cron` implementation. Add a maintained cron parser only when implementing this feature, with validated five-field UTC expressions, a minimum interval and explicit next-fire semantics.

Trigger records need `scriptOwnerId`, `scriptId`, pinned installation/version, `principalUserId`, enabled state, schedule, next fire time, and dispatch identity. An occurrence is identified by `(triggerId, scheduledFor)`; persist its receipt before dispatch, and pass that identity into execution admission. UI-history pruning must not remove scheduler deduplication state prematurely.

Default policy: no overlapping executions for one trigger; skip missed occurrences rather than enqueueing an unbounded catch-up burst. Restart reconciliation records skipped/interrupted work. Automatic retry of arbitrary mutating scripts is not safe; retry only scheduling delivery with deduplication, not a possibly committed execution.

If canonical triggers live in `scripts.db`, the server discovery table is an eventually consistent projection, not a second authority. Use a same-Home transactional journal for trigger changes and idempotent index updates with revision/tombstone handling. Register a discoverable inactive owner/index entry before the first canonical create, so a crash cannot strand a new Home's journal; repair interrupted registration and reconcile on boot without eagerly opening every Home. Deletes retain a tombstone until the projection acknowledges it.

There is no atomic transaction spanning independent ManagedDatabase WAL connections. The alternative is one authoritative scheduler database with explicit owner-scoped access and backup semantics; choose and prove the storage protocol before implementing triggers, rather than claiming both designs at once. The trigger/index protocol is follow-on work, not required for manual scripting.

### Domain-event triggers

Do not use browser SSE as a durable automation bus or let a separate process “subscribe to `Home.broadcast()`” by reference. The API owns domain mutation hooks; an external supervisor receives explicit serialized dispatch requests.

Trigger events originate only after the relevant domain mutation commits and carry a stable event ID, resource identity, actor, origin execution/trigger, and causal depth. Match rules in bounded batches, recheck the trigger principal's access to the resource, and derive sensitive input through that principal's ordinary SDK permissions rather than copying another user's event payload wholesale.

Use `(triggerId, eventId)` deduplication, per-trigger/principal budgets, and loop suppression for script-originated mutations. Default to excluding the triggering script's own causal chain; bound cross-script cascades too. Debounce high-frequency document edits and coalesce where semantics allow.

Reliable event delivery requires a durable domain outbox or journal at the mutation seam. `Home.broadcast()` and today's relay are not such a journal; see the separate [home-relay outbox proposal](PROPOSAL_HOME_RELAY_OUTBOX.md). Define the accepted commit-to-enqueue gap for each domain if it cannot share a transaction. Do not promise exactly-once side effects or reliable triggers from an in-memory listener.

## Limits and Operational Behavior

These are proposed starting defaults, not performance measurements. Define them once in the implementation's script limits table, expose relevant values to the UI, and revise them only with load evidence. Enforce every bound in the parent; runner-side checks improve errors but do not replace host checks.

| Budget | Initial value | Enforcement |
|---|---|---|
| Source | 256 KiB UTF-8 per script | Save/admission validation |
| Manifest/configuration | 16 KiB each | Save validation and bounded fields |
| Context/input | 64 KiB combined | Route/worker initialization validation |
| HTTP JSON body | 1 MiB | Streaming body read before JSON parsing |
| Scripts | 100 per personal owner | CRUD admission |
| Active executions | 4 global, 1 per principal | Process-wide dispatcher |
| Queued executions | 16 global, 2 per principal | Reserved admission, fair dispatch |
| Queue residence | 60 seconds | Queue expiry, never an unbounded wait |
| Active wall clock | 120 seconds including startup | Parent monotonic watchdog |
| Startup handshake | 5 seconds, within active deadline | Parent lifecycle |
| V8 heap | 128 MiB target | Pinned-runtime flag; not a total-memory guarantee |
| Frame header/body | 8 KiB / 1 MiB | Incremental parser before allocation |
| Calls | 200 per execution; 8 outstanding; 4 host operations active per execution | Parent dispatcher; serialize mutating calls within an execution |
| Result | 256 KiB | Serialization and host validation |
| Logs/stderr | 64 KiB each | Host-side capped buffers and continuous draining |
| Progress | 1 KiB per message, at most 2 updates/second | Host throttle; latest state retained |
| Network request/response | 256 KiB / 512 KiB decompressed | Streaming egress handler |
| Network deadline | 30 seconds or remaining execution time, whichever is smaller | Abortable host operation |
| Redirects | 3 | Explicit validated redirect loop |
| History | 200 terminal records per script, 64 MiB aggregate per owner | Byte-aware terminal retention |

Document, collection and file methods also impose domain-specific input-size/operation-count budgets **before** expensive work. Large reads use pagination/ranges; no unbounded `getAll()` convenience API. Scripting shares the existing document-transform capacity and must not starve interactive preview/export work; SDK transform admission needs an explicit class/budget and must reject saturation, not create a hidden second unbounded queue.

Log operational metadata: execution ID, script version, principal/owner IDs, queue/startup/active duration, terminal reason, process exit, RPC counts/bytes, effect counts, and queue depth. Do not log source, request/response bodies, configuration or document content. Track finalization failures and orphaned host operations separately.

## Implementation Layout and Deployment

Follow existing domain conventions; the following files are proposed unless already identified above.

```text
apps/api/src/lib/scripts/
  scripts.ts             CRUD, approval, durable execution transitions
  schema.ts              scripts and execution tables
  db-config.ts           versioned migrations
  runner.ts              bounded admission and one-shot process lifecycle
  runner.js              trusted Deno entry, framed I/O and SDK facade
  protocol.ts            closed wire schemas and message validation
  sdk-handler.ts         method registry and checked domain delegation
  sdk-readers.ts          bounded transform-backed document reads
  sdk-writers.ts          live document commit coordination
  proxy-fetch.ts          constrained egress
  sse-events.ts          typed script event builders

apps/api/src/routes/scripts.ts
packages/lib/src/types/script.ts
packages/lib/src/core/scripts/     hooks, query keys, invalidators, SSE handler
packages/ui/src/components/scripts/
apps/scripts/
```

Pure document mutation planning belongs beside the existing document/canvas/sheet primitives, not duplicated inside the runtime. Shared types and public hooks/helpers are exported through their proper barrels. Register the app in routing/navigation, shared app/permission metadata, API static serving, workspace scripts and production deployment; creating `apps/scripts/` alone does not wire it into Eigen.

The current [API Dockerfile](../../docker/api/Dockerfile) runs source under `/app/apps/api`, so a bundled-path assumption is wrong. Resolve a known shipped runner file consistently in development and production, and include it explicitly if packaging changes. Pin a supported Deno version and binary/image digest for supported CPU architectures; do not install “latest” through `curl | sh`. Pinning is paired with a runtime update policy, not indefinite use of an old binary.

Use a writable execution-temp location that is separate from read-only application/runner files and Eigen data. Runtime availability and protocol compatibility are checked when scripting is enabled; unavailable Deno makes script admission fail explicitly without breaking unrelated apps. No per-request download/install or automatic fallback to Bun, Node `vm`, or unrestricted execution.

## Delivery and Acceptance

Implement in small units, but do not redefine the first release as read-only to avoid the difficult write path.

| Unit | Required outcome |
|---|---|
| Execution foundation | Schema/migrations, identity/approval, admission, one-shot Deno, framing, deadlines, cancellation, recovery and operator switch |
| Domain SDK | Finite typed registry; existing ACL/relay/domain seams; bounded read/write operations and constrained fetch |
| Live document mutations | Shared pure mutation primitives, bounded transform planning, revision conflicts, live Yjs commits, persistence and connected-editor convergence |
| Authoring and integration | Scripts app, Docs/Drive panels, saved revisions/configuration, logs/results, guarded at-most-once local action application |
| Release gate | All above supported end-to-end, including side-effect failure behavior and resource isolation limitations |
| Follow-on | Additional context providers, approved sharing/installation model, durable cron/events, imports and richer extensions |

The regression suite must exercise contracts rather than just mocks of the runner:

| Area | Required cases |
|---|---|
| Process lifecycle | Infinite loop, unresolved promise, startup failure, unexpected exit, timeout during RPC, pending/running cancellation, cancel/done race, shutdown and abrupt restart |
| Protocol/budgets | Partial/coalesced frames, partial writes, malformed/oversized headers and JSON, duplicate IDs, non-JSON results, cyclic logs, stdout/stderr floods, overload and fair dispatch |
| Authority | Spoofed worker principal/grants, cross-owner IDs, shared read-only resources, guest rejection, account/permission revocation, manifest edit while queued, stale source version |
| Runtime/network | Native network and remote/npm/local imports denied, clean environment, no cross-user cache state; origin bypasses, redirects, DNS rebinding, IPv6 and compressed response limits |
| Persistence | Retry-key conflict/deduplication, queue handoff failure, Home reopen versus API restart, finalization DB failure, deletion during run, active-row retention |
| Writes | Normal domain validation/SSE/history preserved, partial script failure after commit, no mutation retries, no raw managed-DB bypass, bounded batch rejection before commit |
| Collaboration | Two connected editors; concurrent edit produces conflict or documented merge; delete-only updates invalidate revisions; formulas/frame bindings survive; reload proves persistence |
| UI | Switch selection/document/account while running, close/reopen panel, permission loss, duplicated/lost SSE, reconnect/polling, reload without action replay, SDK write not applied twice |

Run real Deno protocol/permission probes against the pinned release, on supported development and production platforms. Include load measurements for startup latency, API responsiveness, total RSS and disk usage; a heap-only test does not establish machine safety. Use the repo's existing test layouts and `bun run check`, plus real browser verification for authoring, live edits and stale-result behavior.

## Non-goals

No Apps Script source compatibility, public marketplace, arbitrary npm/URL imports, browser DOM execution, embedded arbitrary web UIs, distributed transactions across SDK calls, or exactly-once external side effects. User-supplied TypeScript, dependency bundles, prompt-only programs and sandbox hardening are separate follow-ons with their own contracts.

The first release is a complete personal read/write automation surface, not a workflow engine or a promise to contain hostile code.
