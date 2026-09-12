# Proposal: `FileSource` — one way to read a file-ish thing, one way to preview it

> **TLDR**: Eigen has four surfaces that hold files a user can act on: Drive items, mail attachments (MIME parts inside a Maildir `.eml`), chat attachments and comment-card attachments (both Drive files in a container's media folder). Every cross-surface action is a bespoke pair of route and body: mail → Drive is a route on **mail** with the target in the body; Drive → Drive folder is `/copy`, a route on the **source**, driven by four separate hooks; Drive → mail draft and Drive → document are routes on the **destination** with the source in the body. Mail part bytes have their own auth and their own lookup, so there are two doors to bytes. The preview overlay is bound to `DrivePath`, so mail attachments have no quick-look, and three surfaces hand-wire their own save-to-Drive picker. This proposal adds two seams. On the backend, a `FileSource` union (`drive` | `mail`), one resolver `readFileSources(user, sources)` that owns every per-kind access check and returns `{ file: Blob, name, mimeType, size }` per source, and the rule **the destination owns the route, the source travels in the body**. Four routes follow it and four old ones go, `/copy` included: putting items into a folder becomes one route whatever the source. On the frontend, a `PreviewSubject` of identity plus metadata (URLs derived by one helper) that the overlay consumes instead of `DrivePath`, one `SaveToDrivePicker` replacing three hand-wired ones, and one chip menu shared by chat, mail and cards. **The route consolidates; the hooks keep their names**, because they differ in failure policy and return shape, not in wording. Drive and chat quick-look content stays byte-identical. Mail attachments gain quick-look and a context menu. The coming contacts vCard import gets one reference route that works from every surface on day one.

**Review status (2026-09-12): six cold reviews applied over three rounds (backend seams, frontend/UX, consistency and unification, claim verification, over-correction, revised-ruling verification). Rulings in [Decisions](#decisions-2026-09-12); rulings that reverse or narrow an earlier one are marked.**

## Goals

1. **One rule for cross-surface writes.** Any "write X from a file-ish thing" is a route on X taking `FileSource`s in the body. Four routes follow it: items into a folder, bytes into a document, an attachment onto a draft, cards into contacts.
2. **One resolver, per-kind access checks in one place.** Every path that turns a reference into *bytes* goes through it, both mail byte routes included.
3. **Stream when the source can, and never stream what should be copied.** A Drive source that must be read hands back the `StorageFile` untouched. A Drive-to-Drive copy never touches the resolver: it keeps the same-storage fast path and works for folders and containers, which have no bytes to resolve. Mime and size come from the path row or the parsed part, never from the blob.
4. **One preview overlay for four surfaces.** The Drive-only pieces (Open in app, server text preview, the exiftool image transcode, thumbnails, eigendoc handling) gate on `subject.drive`.
5. **Same click, same actions, one picker.** Clicking an attachment chip opens quick-look in Drive, chat, mail and cards. One `SaveToDrivePicker` serves every footer and menu. One chip menu carries the rows chat, mail and cards share.
6. **No hook loses its meaning.** Consolidation stops at the route. A caller reading `useDuplicatePath(...)` still sees what happens without tracing an option.

## Non-goals

- **Moving mail attachments out of the `.eml`**, **streaming mail parts** (D9), **server text preview or thumbnails for mail attachments** (no version key, no cache).
- **Sharing a contact in chat.** Moves to the vCard plan as a client-side flow over the room's existing upload-then-post path.
- **The chat composer's attach button**, and **`kind: 'upload'`**: bytes cannot ride in a JSON body, and multipart-with-a-JSON-part is worse than the raw upload routes, which stay.
- **A single mail route with `?inline`.** Drive has a download/embed pair; mail gets the same pair.
- **Re-spelling the `?attach=` mail deep link** and **forwarding a mail attachment into a compose draft.** Dropped (D17 reversed): the composer's state is `DrivePath[]`, so a mail-sourced chip is a second composer path with no caller today.
- **Batch quota summing.** Quota stays per item, as `/copy` and save-to-drive do today.

## Current state (recap)

**Five route shapes for one idea.**

| Write | Route today | Owner | Body |
|---|---|---|---|
| Mail attachments → Drive folder | `POST /mail/:ownerId/message/:id/attachments/save-to-drive` | source | `{ indexes[], targetOwnerId, targetMountId, targetParentId }` |
| Drive item → Drive folder | `POST /drive/:ownerId/:mountId/path/:pathId/copy` (`routes/drive.ts:148`) | source | target owner, mount, parent, optional `name` |
| Drive file → mail draft | `POST /mail/:ownerId/message/draft/attachment-from-drive` (`routes/mail.ts:214`) | destination | three `source*` fields |
| Drive file → document | `POST /drive/:ownerId/:mountId/file/:pathId/import-from-drive` (`routes/drive.ts:260`) | destination | three `source*` fields; `server?.timeout(request, 0)` and an explicit `canWrite` check on top of `resolveFile` |
| Mail part bytes | `GET /mail/:ownerId/message/:id/attachment/:index/:fileName` (`routes/mail.ts:295`) | source | hard-coded `application/octet-stream`, disposition from the user-controlled `:fileName` segment, `setCacheHeaders(set, 86400)` → `private, max-age=86400` |

**`/copy` has four hooks with four policies** (`packages/lib/src/core/drive/hooks/writes.ts`):

| Hook | Target | Failure policy | Returns | Toast |
|---|---|---|---|---|
| `useCopyFiles:140` (chat save, preview footer) | one folder | a **sequential** `for` loop, throws on the first error | — | "File saved to Drive" / "N files saved to Drive" + "Open folder" action |
| `useCopyToMediaFolder:189` (docs, sheets, slides, vector, cards, chat rooms — six callers) | one media folder | `allSettled` + `partitionCopyResults`, **concurrent**, keeps partials, throws only on total failure (two callers rely on that via `.catch()`) | `DrivePath[]` of successes, read positionally | silent, warns on partial |
| `useCopyPath:222` (Copy to…) | one folder | `allSettled` + `partitionCopyResults`, **concurrent**, invalidates the successes then throws on any failure, count-phrased | `DrivePath[]` | silent |
| `useDuplicatePath:262` (Duplicate) | **per item** (`item.parentId`), invalidates per parent | `allSettled` + `partitionCopyResults`, **concurrent**, throws on any failure | `DrivePath[]` | silent |

The route (`routes/drive.ts:148-192`) checks quota per item, dedups the name with `getUniqueFileName` against the target siblings **re-read per request**, then dispatches to `Drive.copyPath` (same mount) or `copyPathAcross`, both recursive over files, folders and eigendoc containers. `SharedDrive.copyPath` (`sharedDrive.ts:147-162`) does both the read and the write check. `useDuplicatePath` sends `name: 'Copy of …'`; without it dedup yields `Foo (2).pdf`.

**The byte writers.** `createFileFromData` accepts `Buffer | StorageFile | ReadableStream` (`drive.ts:449`); downstream branches only on `Uint8Array`/`ReadableStream` (`streaming.ts:108,114`), so a plain `Blob` is safe. `finalizeUpload` (`lib/drive/upload.ts:27-35`) sanitizes and dedups the name. `stageDriveAttachment` (`mail-domain.ts:494-521`) calls only `.stream()`. No `instanceof` check on either path.

**Mail attachment bytes.** `messageGetAttachments` (`mail-domain.ts:192`) → `MaildirStore.getAttachments` (`maildir-store.ts:161`) re-parses the `.eml`; the parser is Eigen's own (`lib/mail/mail-parser/`) and decodes every part on parse, so `part.size` is decoded length. Indexes are stable between the detail payload and the raw list (`mail-domain.ts:153-158` blanks `content` in place, no filter, no reorder). Storage is always local; messages are capped at 25 MiB. `messageGetAttachment` has exactly one caller, the download route. **`filename === undefined` is load-bearing**: `lib/mail/sender.ts:40-44` drops filename-less parts from outbound SMTP and `mail-domain.ts:373,438` drop them on draft re-save, which is how inline cid images stay out of the attachment list. `saveAttachmentsToDrive` validates and materialises **every** part before the first write, with the reason in the code: a late oversized part must not leave earlier files persisted, because a retry would duplicate them.

**Production is same-origin** (`scripts/generate-env.sh:55` sets `VITE_API_HOST=/eigen`), so an anchor's `download` attribute **overrides** the server's `Content-Disposition`. In dev the API is a cross-origin port and the attribute is ignored, which is why a route-side disposition looks decisive when it is not. `file-preview.tsx:84` already has the correct pattern for letting the server name a download: `a.download = ''`.

**The fallback filename is spelled five times in two formats, and the inconsistency users see is label-versus-file, not writer-versus-writer.** `attachment-${index}` (0-based) at `lib/mail/mail.ts:107` and `read-attachments.tsx:38`; `Attachment ${index + 1}` (1-based) at `read-attachments.tsx:54` and `use-draft.ts:131,228`. Every path that actually produces a file already agrees on `attachment-N`: a chip click calls `e.preventDefault()` and opens the save picker (`read-attachments.tsx:60-63`), the toolbar save and the picker's Download-instead both go through `:38` or the server, and the `href`/`download` pair on the chip fires only on "Save link as…" or a middle-click. What a user sees instead is **one attachment under two names on one screen**: the chip reads `Attachment 3` and the file lands in Drive as `attachment-2`. Phase 5 would make it three, because the quick-look header renders its own name two pixels from the chip. The two `use-draft.ts` spellings are compose-chip labels over the calendar-**filtered** list, so their index is not the raw index.

**Drive's inline policy.** `serveFile` (`lib/drive/serve-file.ts`) sets Content-Type, disposition from `details.originalName || name`, `private, no-cache`, an ETag, nosniff, `Accept-Ranges`, and spreads `scriptableInlineHeaders(mime)` (`lib/core/http.ts:116`) when inline — the documented single home of the "which types are scriptable" fact.

**The overlay.** `openPreview(path: DrivePath, siblings?, { downloadMode? })` and `updatePreview(path)` (`preview-context.ts:16-17`). One `useMemo` (`preview-provider.tsx:71-106`) derives `previewUrl` (the server `/preview` transcode, which is why `getPreviewMode`'s exiftool branch makes HEIC and raw render), `embedUrl`, `downloadUrl` (undefined for folders), `thumbnailUrl`, `aspectRatio` from `details.width/height`; siblings match by `s.id === path.id`. `file-preview.tsx` reads `path.type` in three required positions (`isDocumentType` hides Download for eigendocs at `:78`, `isFolderType` filters siblings at `:79`, `getFileIcon(mimeType, type)` at `:182`), `path.updatedAt` as the text-preview query key at `:267`, and `getDriveItemUrl(path)` for Open. The batch action **"Download all (n)"** (`:218`) is gated on `canDownload && downloadableSiblings.length >= 2 && downloadMode === 'save-to-drive'`, over a sibling list that filters out folders and eigendocs. `downloadMode` has one passer, `attachment-chip.tsx:48`, with two consumers: chat and the stickies card dialog. Seven `openPreview` call sites, two of them command-palette providers, all behind one `app-shell.tsx` provider.

**Chips and pickers.** `SimpleAttachmentChip` is used by mail reader, mail compose, chat and cards; with a `downloadUrl` it renders an `<a>`, and chat's context menu bails out on `e.target.closest('a')` (`chat-message-list.tsx:274`). `ReferenceAttachmentChip` exists for eigendoc and folder references, opens the item in its app, and is also used by mail compose. Mail compose re-implements `AttachmentDraftChips` over two parallel arrays. Three hand-wired `DriveLocationPicker` flows (`file-preview.tsx:231`, `chat-message-list.tsx:498`, `read-attachments.tsx:75`) with two toast texts. `AttachmentChip` displays `details.originalName || name` while the overlay header displays `path.name`.

## Alternatives considered

- **Client fetches bytes and re-posts them.** Rejected: both ends are on the server.
- **Route on the source (the `/copy` and save-to-drive shape).** Rejected: the second path segment is the Home being written to (AGENTS.md sharding rule).
- **Keep `/copy` beside the new route.** Rejected: two routes for one write.
- **Route Drive-to-Drive copies through the resolver.** Rejected: containers have no bytes, and it would turn a server-side copy into a stream through the API.
- **One hook for every save-to-Drive write.** Rejected (D2b narrowed): the four hooks differ in failure policy, invalidation target and return shape. One hook plus an options object is the `DEFAULT_OPTIONS` shape CODE-STANDARDS.md rejects by name, and it would force six editor and card call sites to filter a result union they read positionally today. Same route, different hooks is already the house pattern.
- **Per-item `{ path } | { error }` results.** Rejected (D2 narrowed): no route in the repo returns per-item errors, a 200-with-error destroys the `AppError` → `onMutationError` channel that carries the quota text, and it would reverse mail's deliberate validate-everything-first property. The batch throws; the one caller that wants partial tolerance keeps its client-side loop.
- **Storing URLs on the subject.** Rejected: derived data built at nine call sites. One helper derives them, with two consumers.
- **A shared menu block including Drive.** Rejected: Drive's two shared rows are not contiguous.
- **Filling the attachment filename in the parser.** Rejected (D12 reversed): a missing filename is the "not a real attachment" signal for outbound mail and draft rebuilds.

## Design

### Backend

**Type** (`packages/lib/src/types/file-source.ts`):

```ts
export type FileSource =
    | { kind: 'drive'; ownerId: string; mountId: string; pathId: string }
    | { kind: 'mail'; ownerId: string; messageId: string; index: number };
```

Plus `fileSourceKey(source): string` beside it, colon-separated to match the ad-hoc `ownerId:mountId:pathId` spellings already in the search and doc-search keys. Its one consumer is the overlay's sibling matching, which compares `s.id === path.id` today and cannot compare objects a re-render rebuilds.

**Schema.** `packages/lib` is typebox-free, so the Elysia schema lives once in the API beside the resolver (`apps/api/src/lib/file-source/schema.ts`): `index` is `t.Integer({ minimum: 0 })`, ids are bounded strings, the item array carries `maxItems: 100`, which bounds a mail or chat batch and is never met by a Drive selection, because the Drive hooks post one item at a time. All four routes import it; array routes reject an empty array and duplicate sources, the guards `saveAttachmentsToDrive` has today.

**Resolver** (`apps/api/src/lib/file-source/read.ts`; a sibling directory like `lib/import/`, because `lib/core/` imports no domain and the resolver imports two):

```ts
export type ResolvedFile = { file: Blob; name: string; mimeType: string; size: number };
export async function readFileSources(user: User, sources: FileSource[]): Promise<ResolvedFile[]>
```

- `drive`: `getSharedDrive(source.ownerId, user)` → `resolveFile` (read-checked, throws for a non-file type) → `mount.readFile(path)` as `file`, `details.originalName || name`, `path.mimeType`, `path.size`. Streams.
- `mail`: `requireSelf(source.ownerId, user.id)`; sources are grouped by `messageId` so each message is parsed once, then each index is taken from that list (404 past the end): `new Blob([part.content], { type: part.contentType })`, `part.filename` or `attachment-${index}`, the content type **with parameters stripped**, `part.size`.

The array signature is the parse-once invariant; single-source callers pass `[source]`. Results come back in input order. Five consumers: `items-from`'s byte branch, `import-from`, `attachment-from`, and both mail byte routes (`contacts/import-from` is the sixth, in phase 2).

**Consumers widen to `Blob`.** `createFileFromData(..., data: Buffer | Blob | ReadableStream, ...)` and `stageDriveAttachment(source: Blob, ...)`. Verified safe at runtime.

**Routes.** Each keeps the gate its surface has today: mail and contacts are `requireNonGuest` + `requireSelf` (restated in the handler, because the resolver only does `requireSelf`); the drive routes are ACL-checked and stay guest-callable, and `import-from` keeps `server?.timeout(request, 0)` and its explicit `canWrite` check. Because a mail source can now arrive at a drive route, **`items-from` and `import-from` restate `requireNonGuest` when any item is a `mail` source**, so the mail surface's gate travels with the source rather than with the route. Impact today is nil, since a guest home has no Maildir and the read would 404, which is exactly why it needs writing down.

| Write | Route | Body | Consumer |
|---|---|---|---|
| Items into a folder | `POST /drive/:ownerId/:mountId/folder/:pathId/items-from` | `{ items: { source: FileSource; name?: string }[] }` | Inline handler, below; returns `DrivePath[]`, throws on any failure. Replaces `save-to-drive` and `/copy` |
| Bytes into a document | `POST /drive/:ownerId/:mountId/file/:pathId/import-from` | `{ source: FileSource }` | `importIntoDocument` after `arrayBuffer()`; replaces `import-from-drive` |
| Attachment onto a draft | `POST /mail/:ownerId/message/draft/attachment-from` | `{ source: FileSource }` | `stageDriveAttachment(file, name, mimeType, maxSize)` streams; replaces `attachment-from-drive` |
| Cards into contacts | `POST /contacts/:ownerId/import-from` | `{ source: FileSource }` | `importCards(text)` after `arrayBuffer()`. **Phase 2**, with the vCard plan that adds `importCards` |

**The handler** stays inline in `routes/drive.ts` beside its neighbours, with no extracted helper, because what it calls is already domain work and every neighbouring route body is written the same way. Per item, in order:

- **Validate everything before the first write** (mail's property, now shared): resolve every non-`drive` source, check each against the per-item upload limit, and 404 any missing part, before writing anything. The non-`drive` subset is resolved as a batch and mapped back to item positions by index.
- a **`drive`** source never touches the resolver: `SharedDrive.copyPath` (same mount) or `copyPathAcross`, which already do both ACL checks and already handle files, folders and eigendoc containers recursively, with SSE, file history and versioning as today. Quota and size come from the path row. The target siblings are re-read per item, as `/copy` does today, so two items named `a.txt` do not collide. `name` overrides the source name, which is how Duplicate keeps "Copy of …".
- any **other** source is written with `createFileFromData`, whose `finalizeUpload` already sanitizes and dedups. No second dedup on that branch.

`Drive.copyPath` stays available for its non-route callers.

**`import-from` and `attachment-from` accept the whole union** although only Drive sources reach them from the UI today. That is not a placeholder: the resolver already handles both kinds, so accepting one schema is less code than narrowing two bodies to `kind: 'drive'`, and a reviewer can see at the resolver that nothing is unimplemented.

**No rollback.** A throw on item *k+1* leaves the first *k* written, exactly as today's N separate `/copy` requests do, and the folder's SSE event re-syncs the list. The pre-write validation pass exists so the common causes of a late failure (a missing part, an oversized one) are caught before anything is written.

**Both mail byte routes go through the resolver.** `GET .../attachment/:index/:fileName` (download) and a new `GET .../attachment/:index/embed/:fileName` call `readFileSources(user, [source])` and hand the result to one `serveMailPart(resolved, disposition)`: the part's content type with parameters stripped, set explicitly rather than inferred from the blob; `Content-Disposition` from `contentDisposition` over the **resolved** name, not the URL segment; `X-Content-Type-Options: nosniff` always; `scriptableInlineHeaders(mimeType)` spread in (the same helper `serveFile` uses, which stays untouched — D5 reversed: no second extraction); `private, max-age=86400` as today; and, like `serveFile`, `Accept-Ranges` with a 206 on a range request and an ETag. Ranges are two lines here because D9 already holds the whole part in memory, so a range is a `blob.slice()` — and they are not optional: a mail `video/mp4` or `audio/mpeg` part reaches a media element whose seeking needs them, and Safari refuses a source that advertises none. `messageGetAttachment` is deleted. Two observable changes, both deliberate: the download route stops sending `application/octet-stream` for everything, and the saved filename stops coming from a user-controlled URL segment.

**One name per attachment, shared by the label and the file.** `mailAttachmentName(att, index)` in `packages/lib/src/types/mail.ts` (a BE-safe subpath that already holds `isEmailDraft`) returns `att.filename || \`Attachment ${index + 1}\``. Two consumers, which is what earns it: the resolver's mail branch, and the reader chip's label. `serveMailPart` takes its `Content-Disposition` from the resolved name rather than the `:fileName` URL segment; `items-from` names its writes from the resolver; `subject.name` for a mail part is the same string, so the chip, the quick-look header and the saved file all read alike. Because production is same-origin, the client must also stop overriding the server, so **every mail attachment anchor sets `download=""`** (the pattern `file-preview.tsx:84` uses) rather than a filename — that closes the "Save link as…" and middle-click paths, which are the only ones where the attribute is reachable today. `lib/mail/mail.ts:107` goes with `saveAttachmentsToDrive`, and the two `use-draft.ts` spellings stay untouched: they are compose labels over the calendar-filtered list, a different index basis. `Attachment.filename` stays optional (D12 reversed). The saved name for a filename-less part changes from `attachment-2` to `Attachment 3`, one-based like the label: a deliberate user-visible change for the screenshot round. Neither form carries an extension today and this does not add one; mapping a content type to an extension is a separate decision with no helper in the repo.

### Frontend

**Subject** (`packages/lib/src/types/preview.ts`) — identity and metadata only:

```ts
export type PreviewSubject = {
    source: FileSource;      // identity, via fileSourceKey(source)
    name: string;            // display name; for a Drive subject, path.name, so the header is unchanged
    mimeType: string;
    size: number;            // read by the vCard preview's too-large guard (phase 2)
    drive?: DrivePath;       // present → Open, text preview, exiftool transcode, thumbnail, eigendoc handling
};
```

The three required `type` reads resolve as `subject.drive?.type ?? 'file'`: a mail part is always a file. `updatedAt` is read only through `subject.drive`, which is what the text preview needs.

`previewUrlsFor(subject)` beside the existing URL builders in `packages/lib/src/core/api.ts` returns `{ previewUrl, embedUrl, downloadUrl?, thumbnailUrl? }` — four URLs and nothing else. For a Drive subject they are exactly what the provider's memo builds today, cache-busted by `updatedAt`, with the thumbnail coming from the existing `getDriveItemThumbnail`; for a mail subject, the embed URL for both preview and embed, the download URL, and no thumbnail. The aspect ratio is not a URL and stays in the provider, derived from `subject.drive?.details` as today. Two consumers, which is what earns it: the provider, and `SaveToDrivePicker`'s "Download instead" fallback. One `source.kind` branch, in one helper. `subjectFromPath(path)` and `subjectFromMailAttachment(ownerId, messageId, index, att)` live beside it and carry no URL code.

**Overlay.** `openPreview(subject, siblings?)`, `updatePreview(subject)`; `downloadMode` is deleted. `getPreviewMode(subject)` gates **every server-rendered mode** on `subject.drive`: the exiftool image branch, so a HEIC mail part falls back rather than rendering a blank image, and the whole text branch, because `CODE_MIMES` opens with the bare prefix `text/` (`constants/preview.ts:9`) and `TextPreviewContent` needs a mount, a path and an `updatedAt`. Without that second gate every `text/plain`, `text/csv`, `.md`, `.json` and `.log` mail part would render an empty panel or query `/drive/undefined/…`. A mail part of those types gets the honest fallback card, its icon and its name. Footer on every surface: Open (when `subject.drive`), Download (when `downloadUrl`), Save to Drive…, and the batch action, which keeps **both** of today's gates: at least two downloadable siblings, folders and eigendocs filtered out. It is relabelled "Save all (n)" and now appears on Drive previews too, which never had it — a new affordance, so it goes to the screenshot round. The five UI call sites wrap with `subjectFromPath`; the two palette providers keep the `DrivePath` contract, which app-shell wraps once.

**One picker.** `SaveToDrivePicker({ subjects, open, onClose })` in `packages/ui/src/components/drive/`: `DriveLocationPicker` + `useSaveToDrive` + the "Download instead" fallback, one toast. It takes subjects rather than sources because the default location comes from `subject.drive` and the fallback needs the download URLs. Replaces the three hand-wired flows; hosts keep the `open` state outside their menus, as chat does today.

**Hooks: the route consolidates, the names stay.** The three surviving copy hooks keep the request shape, concurrency and failure path they have today, so nothing about their scale behaviour changes; only their endpoint moves. `useSaveToDrive` is the one new hook, and it batches because the mail route it absorbs already does:

| Hook | Change |
|---|---|
| `useSaveToDrive` | **New, replaces two**: `useCopyFiles` and `useSaveMailAttachmentsToDrive`. Same contract — one target, throws so the picker stays open, success toast with an "Open folder" action — and neither caller of `useCopyFiles` depends on its sequential loop: both only await the mutation inside a picker's confirm. Takes `FileSource[]` and posts in **chunks of 100**, sequentially, stopping at the first chunk that throws, because the preview footer's batch action can span a whole folder. One toast wording for both surfaces: "Saved to Drive" / "N files saved to Drive", so mail's "attachments" phrasing changes |
| `useCopyToMediaFolder` | Unchanged: silent, partial-tolerant, returns the `DrivePath[]` its six callers read positionally, keeps its concurrent `allSettled` + `partitionCopyResults` over one-item posts, so `partitionCopyResults` and its test survive |
| `useCopyPath` | Unchanged: concurrent one-item posts, successes invalidated then throw-on-any with its "N of M" phrasing intact |
| `useDuplicatePath` | Unchanged: concurrent one-item posts, so a per-item target parent needs no grouping, with `name: 'Copy of …'` per item |

The three Drive hooks keep posting one item at a time, so a select-all Copy to… over a 300-file folder is 300 posts, exactly as it is now, and never meets the request bound. Batching those is a separate performance question with its own measurement, not a side effect of this seam.

`useImportFrom`, `useAttachFrom` and `useImportContactsFrom` replace the three `*-from-drive` hooks; the raw-fetch `useImportFromDrive` and `getDriveImportFromDriveUrl` go, the route moving to Eden like its siblings.

**One chip menu.** `AttachmentChipMenuItems({ subject, onQuickLook, onSaveToDrive })` in `packages/ui/src/components/attachment/`, two callers on day one (chat, mail) and a third with the vCard plan (cards). Drive's `DriveItemMenuItems` is untouched (D15). Chat's `closest('a')` bail-out exempts a new `data-attachment-chip` attribute that `SimpleAttachmentChip` sets.

**Chips.** A mail reader chip click opens quick-look; the toolbar Save all uses the picker. `ReferenceAttachmentChip` keeps its open-in-app click, because that is what an eigendoc row does in Drive, and gains the context menu (D14). Mail compose's chips are left alone (D13 narrowed): its state is `AttachmentMeta[]`, which is none of the four variants `CardAttachmentDraft` accepts, and collapsing it to a filename string would collide two same-named attachments on the shared component's key and discard the `key` identity that keeps a chip from remounting mid-save.

**Broken window fixed in passing**, with a test: `use-draft.ts:221-235`, which re-indexes over the calendar-filtered list while `mail-domain.ts:370-374` consumes raw indexes — a latent off-by-N in `keepAttachmentIndexes` on any message with a calendar part.

## Performance invariants

- A Drive-to-Drive write is a server-side copy on the same-storage fast path or the cross-mount bridge, never a stream through the API, and never a byte read for a folder or container.
- `items-from` and `attachment-from` never buffer a Drive-sourced file in the API process. `import-from` does buffer, because the transform worker needs the bytes, exactly as today.
- A mail-sourced read parses the `.eml` once per request whatever the number of parts, by construction of `readFileSources`.
- Size is checked per item from the path row or the parsed part before any bytes move, and every non-`drive` source in a batch is validated before the first write. Quota stays per item.
- The overlay makes the same requests for Drive subjects as today; a mail subject makes one embed request.

## Phased rollout

Five branches, each independently reviewable, merged in order to an integration branch.

1. **Resolver, additive.** `FileSource` + `fileSourceKey` + schema, `readFileSources`, `serveMailPart` over both mail byte routes, the mail embed route, `mailAttachmentName`, delete `messageGetAttachment`. Nothing is removed from the Eden surface. Tests: a `mail` source on another user's message → 403, a `drive` source on an unshared file → 403, parse-once, the changed download observables (content type, name, a 206 range).
2. **`items-from`,** with the old routes still alive. The copy suite moves here and must pass unchanged: folders, containers, cross-mount, quota, per-item dedup, "Copy of". Plus the save-to-drive guards (validate-before-write, 413, 404 past the end) and a same-storage batch that stays on the fast path. **This is the gate on D2.**
3. **Hook switch and route removal.** The four copy hooks and `useSaveToDrive` move onto `items-from`; `/copy`, `save-to-drive`, `import-from-drive` and `attachment-from-drive` go, with `useImportFrom` and `useAttachFrom`. The Eden-surface change; must follow 2. A reviewer checks each of the six `useCopyToMediaFolder` call sites behaves as before.
4. **`PreviewSubject`.** Type, `fileSourceKey`, `previewUrlsFor`'s Drive branch, `subjectFromPath`, the provider and overlay switch, the five UI call sites, the palette wrap. The mail adapter and the mail URL branch wait for phase 5, where their caller is. **The pixel gate lives here**: Drive and chat quick-look content area byte-identical; the footer is a deliberate design change, one screenshot round.
5. **Chips and menus.** `subjectFromMailAttachment` and `previewUrlsFor`'s mail branch, the `download=""` change on mail anchors with a test that the saved name comes from the server, `SaveToDrivePicker`, `AttachmentChipMenuItems`, the mail chip click and menu, the reference-chip menu, the compose-chips deletion, the `use-draft.ts` index fix. Needs 3 and 4. Browser probe: a mail image, a PDF, **a video part seeked past its first chunk** and **a `text/csv` part showing the fallback card** in quick-look; save from every menu and footer on local and MinIO mounts; Drive Copy to…, Duplicate and an editor image paste unchanged.

Then the vCard plan (`docs/superpowers/plans/2026-09-11-vcard-import-export.md`) adds `isVCardFile`, `importCards`, `contacts/import-from`, the vCard preview mode, and the Import to Contacts row in both Drive's menu and the chip menu. Every surface gets it at once.

## Risks and caveats

- **Inline serving of mail parts is a new exposure.** Handled by reusing `scriptableInlineHeaders`, setting nosniff unconditionally, stripping content-type parameters and taking the filename from the resolver rather than the URL. `text/calendar` parts stay filtered out of the chip list.
- **The new handler inherits `/copy`'s whole contract**: quota, per-item dedup, the optional name, recursive folder and container copies, SSE, file history, versioning. The `/copy` tests move and must pass unchanged.
- **Two failure channels would be a smell.** There is one: the batch throws, and the thrown `ApiError` keeps carrying the quota and size text to `onMutationError`.
- **Removing routes changes the Eden surface.** No external client uses them (none are DAV). Docs to change: `MAIL.md`, `EXPORT.md`, `PREVIEWS.md`, `STORAGE.md § Copy / Move`, `FILE-HISTORY.md`, `ROADMAP.md`, `PROPOSAL_MAIL_ATTACHMENT_ACCESS.md`, and `SHARED-PRIMITIVES.md` via `bun run primitives`.
- **Sharding.** A `mail` source is always the caller's own Home; a `drive` source may be another Home, read through `getSharedDrive` as today.

## Open questions

1. **History fan-out granularity for a batch.** `finalizeUpload` records per file and the watcher fan-out is per call today. A ten-item batch either sends ten notifications or one; the proposal does not rule. Cheapest honest answer: keep per-item, matching today's N requests.
2. **`subject.name` for a Drive file with an `originalName`.** The chip shows `details.originalName || name`, the overlay header shows `name`. The proposal keeps `name` so the pixel gate holds; the divergence is pre-existing and unifying it is a separate one-line decision.

## Decisions (2026-09-12)

| # | Ruling | Why |
|---|---|---|
| D1 | Resolver returns `{ file, name, mimeType, size }` from the row or the part; consumers widen to `Blob`. | `Blob.type` is wrong for `local-key`, `S3File.size` is a network call. Runtime safety verified. |
| D2 | `/copy` is removed; `items-from` is the one "items into a folder" route and a strict superset: optional `name`, folders and containers, per-item dedup. It returns `DrivePath[]` and **throws**. | One route per write. A 200-with-per-item-error would destroy the `AppError` channel that carries the quota text and reverse mail's validate-first property. |
| D2a | A `drive` source never passes through the byte resolver; it goes to `copyPath`/`copyPathAcross`. Dedup on that branch only, per item, since `finalizeUpload` dedups the byte branch. | Containers have no bytes; a copy keeps the fast path; one dedup per path; per-item re-read avoids in-batch collisions. |
| D2b | **Narrowed twice.** Consolidation stops at the route. `useSaveToDrive` replaces the two hooks with an identical contract; the other three keep their names, policies, return shapes **and request shapes** — a loop of one-item posts, as today. | The four differ in failure policy, invalidation target and return shape. One hook plus options is the pattern CODE-STANDARDS.md rejects, and six call sites read the return positionally. Keeping their shapes also means a select-all Copy to… behaves exactly as now. Same route, different hooks is the house pattern. `useSaveToDrive` chunks at the request bound because its footer caller can span a whole folder. |
| D3 | Resolver lives in `apps/api/src/lib/file-source/`; the `items-from` handler stays inline in the route file with no extracted helper. | `core/` imports no domain; route bodies of this shape live in `routes/` here. |
| D4 | `readFileSources` takes an array and groups mail sources by message. | Parse-once enforced by the signature, not a cache. |
| D5 | **Reversed.** No header helper extraction. Both mail byte routes go through the resolver into one `serveMailPart` reusing `scriptableInlineHeaders`; `serveFile` untouched. | The security fact already has one home, and this closes the second door to mail bytes that goal 2 requires. |
| D6 | Drive routes keep their guest-callable gates; the mail and contacts routes restate `requireNonGuest`, and a drive route restates it for any `mail` item. | The resolver only does `requireSelf`, and gating the drive routes wholesale is an unasked behaviour change. A gate belongs to the surface the bytes come from, so it travels with the source. |
| D7 | **Narrowed.** Subject is `{ source, name, mimeType, size, drive? }`; URLs come from `previewUrlsFor`, which has two consumers; identity is `fileSourceKey(source)`; the three required `type` reads use `drive?.type ?? 'file'`. | URLs are derived data. An object cannot be an identity across renders. |
| D7a | **Widened.** Every server-rendered preview mode gates on `subject.drive`: the exiftool image branch **and** the text branch. | HEIC and raw render only through the server transcode, and the text renderer needs a mount, a path and a version key. `CODE_MIMES` starts with the bare `text/` prefix, so without the second gate most text mail parts would render an empty panel. |
| D8 | **Narrowed.** `downloadMode` is deleted and the footer is the same everywhere; the batch action keeps both of today's gates and is relabelled "Save all (n)". | One footer, without turning a two-item threshold into "Save all (1)" or offering a batch on an eigendoc. Its appearance on Drive previews is new, so it goes to the screenshot round. |
| D9 | Mail parts stay in memory. | Messages are capped at 25 MiB and the parser already decodes every part; decoding, not locating, is the cost. |
| D10 | Own-mount reads (`inline-edit.ts`, raw `/import`) stay on `resolveFile`. | The resolver is for references arriving in a body. |
| D11 | Contact sharing in chat leaves this proposal. | Not a `FileSource` write. |
| D12 | **Final.** `Attachment.filename` stays optional. One `mailAttachmentName(att, index)` in `types/mail.ts` serves the resolver and the reader chip's label, so a filename-less part reads the same on the chip, in the quick-look header and as the saved file. The saved name changes from `attachment-2` to `Attachment 3`. The two compose labels keep their own basis. | A missing filename is how outbound mail recognises inline cid parts, so the field stays optional. The defect is not two writers disagreeing — every file-producing path already writes `attachment-N` — it is a label disagreeing with a file, which only one shared name fixes. Two consumers earn the helper; the compose labels index a calendar-filtered list and are a different fact. |
| D13 | **Narrowed.** Comment cards are named as the fourth surface. Mail compose's chips stay as they are. | `AttachmentMeta` is not one of `CardAttachmentDraft`'s four variants, and the shared component's key would collide for two same-named attachments while discarding the identity that prevents a remount mid-save. Adding a fifth variant buys nothing. |
| D14 | `ReferenceAttachmentChip` keeps its open-in-app click and gains the menu. | An eigendoc row opens its app in Drive. |
| D15 | Drive's `DriveItemMenuItems` is untouched; the shared block is `AttachmentChipMenuItems`. | Drive's two shared rows are not contiguous. |
| D16 | `contacts/import-from` ships in phase 2, with `importCards`. | Phase 1 would otherwise land a route with no implementation. |
| D18 | Every mail attachment anchor sets `download=""` so the server names the file. | Production is same-origin (`generate-env.sh` sets `VITE_API_HOST=/eigen`), where the attribute overrides `Content-Disposition`. It is reachable only through "Save link as…" and middle-click, since a chip click calls `preventDefault()` — a narrow fix, stated as narrow. |
| D19 | One toast wording for `useSaveToDrive`; mail's "attachments" phrasing changes. | Two hooks with one contract cannot keep two wordings. |
| D17 | **Reversed.** The `?attach=` deep link is left alone; forwarding a mail attachment into a draft is a non-goal. | No caller today, and the composer's state is `DrivePath[]`, so it is a second composer path, not a free win. |
