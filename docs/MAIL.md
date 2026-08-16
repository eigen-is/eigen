# Mail

> **TLDR**: `apps/mail` is a personal email client over a per-user Maildir. The React app talks to a thin
> Elysia router (`routes/mail.ts`) that delegates to the `Mail` domain class (`mail-domain.ts`) over a
> swappable `MailStore` (today only `MaildirStore`), backed by a per-user `mail.db` (SQLite + FTS5). Mail is
> **personal-only** — every route is `requireSelf`, there is no sharing/ACL. The list is keyset-paginated and
> optimistically cached; sync runs off the request path. This doc is the app-level map; the on-disk Maildir
> format, flag encoding, sync-engine mechanics, and Dovecot coexistence live in **[IMAP.md](IMAP.md)**.

## Architecture

Four backend layers plus the React app. Requests flow down; changes flow back up as SSE.

```
apps/mail (React)                          apps/api (Elysia)
  route + hooks ──── HTTP (Eden Treaty) ──►  routes/mail.ts        thin: requireNonGuest + requireSelf
  useEmails / use-draft / useMailboxes           │                 then getMailClient(user) → home.mail
  sse-handlers.ts ◄──────── SSE ──────┐          ▼
                                      │     lib/mail/mail.ts        route-facing helpers (getMailClient,
                                      │          │                  mailboxDeliver, attachFromDrive, …)
                                      │          ▼
                              home.broadcast  mail-domain.ts        class Mail — draft/send/iMIP/SSE/notifs
                                      ▲          │
                                      │          ▼
                                      │     mail-store.ts           MailStore interface + MailStoreEvents
                                      └──────  maildir-store.ts     the only impl: Maildir FS + sync engine
                                                 │
                                                 ▼
                                     maildb.ts (MailDB, mail.db)  +  mail-parse.ts (parseEml + DOMPurify)
                                                 │
                                                 ▼
                                     Maildir on disk  ── see IMAP.md
```

`MailStore` is a deliberate seam: a second backend (JMAP/Stalwart) is proposed in
[PROPOSAL_STALWART_MAIL.md](PROPOSAL_STALWART_MAIL.md) but not built. See
[IMAP.md § Code Architecture](IMAP.md#code-architecture) for the storage side in depth.

## Data model

The `emails` table **is** the `EmailSummary` DTO — the DB row is returned to the client with no mapping
(`packages/lib/src/types/mail.ts`). Columns: `id` (Maildir unique id, TEXT PK), `filename`, `subject`,
`fromShort`/`fromAddress`, `toShort`/`toAddress`, `recipientsAll`, `textShort` (plain-text body — full text
in the DB for FTS, capped only at the list-response seam), `size`, `date`, the `isRead`/`isFlagged`/
`isDraft`/`isReplied`/`hasAttachments` booleans, `mailbox`, and `created/updatedAt`. The full parsed message
(`Email = ParsedMail & EmailSummary`) is re-parsed from the `.eml` on demand; only the summary is cached.

`mail.db` lives at `<home>/eigen.mail/mail.db`. `MAIL_DB_CONFIG` (`db-config.ts`, `currentVersion: 4`):
v1 creates `emails` + base indexes; v2 adds the address columns; v3 adds the `emails_fts` FTS5 table (porter
+ unicode61) with `emails_ai/ad/au` sync triggers; v4 adds `idx_emails_mailbox_date (mailbox, date DESC, id
DESC)` — the composite index backing keyset pagination. **`emailLabels`/`emailsToLabels` are vestigial**:
defined and migrated in v1, but nothing in the FE or BE reads or writes them.

## Mailboxes and the naming gotcha

`STANDARD_MAILBOXES = ['', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive']` (`lib/core/constants.ts`) — the
empty string is INBOX. `canonicalMailbox()` (`mail-domain.ts`) normalizes any case (`inbox`/`Trash`/`trash`)
to canonical form at every domain entry point. **Three representations of "the inbox" coexist** — the #1
source of subtle mail bugs; never compare mailbox strings without knowing the layer:

| Layer | Inbox is | Others |
|---|---|---|
| BE canonical (DB `mailbox` column, SSE payloads, `canonicalMailbox`) | `''` | canonical case (`Sent`, `Archive`) |
| FE query keys (`emailKeys.list`) | `'inbox'` | lowercased |
| URL segment | `box/inbox` | lowercased |

The mailbox list search box passes the URL `filterId` (`'inbox'`) **verbatim** to the search endpoint —
`Mail.search` re-canonicalizes it, so passing `''` would strip the filter and search every mailbox. The
optimistic list patch sidesteps all of this by matching on message `id`, not the mailbox key. See
[IMAP.md § Mailbox Structure](IMAP.md#mailbox-structure) for the on-disk `.Mailbox` layout.

## API routes

All authed routes are `requireNonGuest` + `requireSelf(ownerId, user.id)` (`routes/mail.ts`).

```
POST   /mail/deliver/:to                                  inbound delivery (requireLocalhost — Postfix)
GET    /mail/:ownerId/mailboxes                           mailboxes + unread counts
GET    /mail/:ownerId/mailbox/:mailboxPath                list messages — ?limit&beforeDate&beforeId (keyset)
POST   /mail/:ownerId/mailbox                             create mailbox
GET    /mail/:ownerId/mailbox-exists/:mailboxPath         existence check
GET    /mail/:ownerId/message/:id                         full parsed message (draft: sidecar overlay)
GET    /mail/:ownerId/message/:id/download                raw .eml
DELETE /mail/:ownerId/message/:id                         permanent delete (→ MAIL_DELETED)
PUT    /mail/:ownerId/message/move                        move to mailbox (→ MAIL_MOVED)
PUT    /mail/:ownerId/message/move-to-trash               move to Trash (→ MAIL_MOVED)
POST   /mail/:ownerId/message/copy                        copy raw bytes to mailbox
PUT    /mail/:ownerId/message/draft                       create / update draft (→ MAIL_DRAFT_UPDATED)
POST   /mail/:ownerId/message/draft/attachment            upload draft attachment → tempId
POST   /mail/:ownerId/message/draft/attachment-from-drive stage a Drive file as a draft attachment
POST   /mail/:ownerId/message/send                        send draft (→ Sent, MAIL_SENT)
PUT    /mail/:ownerId/message/:id/read                    set read/unread (→ MAIL_READ_CHANGED)
PUT    /mail/:ownerId/message/:id/flagged                 set star (→ MAIL_FLAGS_CHANGED)
POST   /mail/:ownerId/message/:id/attachments/save-to-drive   save received attachments into Drive
GET    /mail/:ownerId/message/:id/attachment/:index/:fileName download one attachment
```

## Reading and the list (FE)

`useEmails(mailboxPath)` (`packages/lib/src/core/mail/hooks/use-emails.ts`) is a `useInfiniteQuery` returning
a flat `emails` array. `useMailList` (`apps/mail/src/components/mail/hooks/use-mail-list.ts`) owns the ordered
rows (stable date-desc sort over the loaded window), selection, and the **id-tracked** keyboard cursor —
shared with the shortcuts layer so both act on identical state. `EmailList` (`email-list.tsx`) virtualizes
the rows (`@tanstack/react-virtual`) and fetches the next page as the end nears; it snaps the virtualizer to
the top when the view identity changes (mailbox switch or entering/leaving search) via a `resetKey`, so the
scroll window can't desync from a shrunken/grown list. The toolbar search box hits the server FTS endpoint
(`useSearchQuery`, scoped to the current mailbox) instead of filtering the loaded window.

## Performance design

At a real account shape (~50k Inbox + ~50k Archive) the naive list was ~34 MB per fetch and every mutation
re-fetched the whole mailbox. Four shipped changes fix it (measured on a dev Mac):

| Concern | Before | After |
|---|---|---|
| First paint of a 50k mailbox | ~34 MB, whole list | ~130 KB, one 200-row page |
| `listMessages` route latency | ~301 ms (sync on the request path) | ~5 ms (serve-stale, sync in background) |
| Cold index (first sync) | 92 s baseline @100k, per-row inserts | batched, ~1.7× faster @10k+10k |
| Archive with N pages loaded | ~8 full-list refetches | 0 |

1. **Keyset pagination.** `MailDB.listMessages` uses a composite `(date, id)` cursor (`WHERE (date,id) <
   (?,?) ORDER BY date DESC, id DESC LIMIT`) backed by the v4 index; the route caps `textShort` at 200 chars
   in the response only (the full body stays in the DB for FTS). Page size 200, max 500.
2. **Optimistic cache updates.** move/read/flag/delete patch the cached pages by id (`patchEmailInLists`)
   inside an `onMutate` snapshot → patch → rollback-on-error contract, instead of invalidating. The UI is
   instant; no mutation-path refetch.
3. **Own-echo suppression.** The server echoes every mutation back to its originator over SSE. Each mutation
   records the echo it expects (`markRecentMailMutation`) in a short-TTL per-tab registry; the SSE handler
   `consumeRecentMailMutation`s it and skips the list refetch (keeping the cheap counts/search invalidations).
   Other clients' changes are unaffected (no registry entry).
4. **Non-blocking sync + batched cold-index.** `MaildirStore.listMessages` serves the DB immediately and
   reconciles via a fire-and-forget `syncMailbox` (it blocks only on the first open of an empty mailbox); the
   cold-index loop parses in chunks of 250 and bulk-inserts each chunk in one `insertEmails` upsert
   transaction. See [IMAP.md § Sync Engine](IMAP.md#sync-engine) for the reconcile diff.

Deferred (Step 4, only for big imports): moving `parseEml` into a worker so a cold index of tens of
thousands of messages doesn't saturate the shared event loop. A one-time bulk import still causes a stretch
of slowness while the background index drains.

## Sync and real-time

The store exposes a change stream `MailStoreEvents` — `received(email, isNew)`, `flagsChanged`, `deleted` —
which `Mail.init` wires to `home.broadcast(buildMailEvent(...))` (SSE via `sse-events.ts`) and, for new mail,
`home.notifications.persist({ tag: 'mail:new', coalesce: true })` so a burst collapses to one notification.
SSE event types: `MAIL_RECEIVED`, `MAIL_MOVED`, `MAIL_DELETED`, `MAIL_READ_CHANGED`, `MAIL_FLAGS_CHANGED`,
`MAIL_DRAFT_UPDATED`, `MAIL_SENT`. The FE `sse-handlers.ts` maps each to cache invalidation. See
[SSE.md](SSE.md) and [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md); the fs-watcher and reconcile mechanics
are in [IMAP.md § File Watching](IMAP.md#file-watching).

## Compose, drafts, and send

`messageHandleDraft` (`mail-domain.ts`) runs a two-mode draft state machine:

- **Fast save** — writes only the `DraftMeta` JSON sidecar + a light DB content update; skips the EML
  rebuild. Used when no attachments changed and the last full save is recent (`FULL_SAVE_INTERVAL_MS` = 5
  min). This leaves the on-disk `.eml` stale until a full save (external IMAP clients see old content).
- **Full save** — rebuilds the RFC 5322 `.eml` (`createEmlContent`), baking Drive reference-pill HTML in.

`messageGet` overlays the sidecar onto the parsed draft so the composer shows what the user typed, not the
baked markup. `Mail.destruct` force-flushes pending sidecars so a restart never leaves a stale draft.

The composer (`apps/mail/src/components/mail/email-draft.tsx` + its `hooks/use-draft.ts`) handles To/Cc/Bcc via `ContactAutosuggest`, a `LightEditor` (Tiptap) body, drag/paste-to-attach, debounced (2.5 s) autosave keyed off a fingerprint diff, a forced full save on unmount, signature injection for new/reply drafts, and Mod+Enter to send. Reply/forward are FE-only (quoted-body composition in `use-mail-actions.ts`); reply drafts also seed the `inReplyTo`/`references` threading headers. The send flow (recipient canonicalisation, per-recipient link copies, and the access-grant dialog) is its own topic below.

## Send path

`messageSend` (`mail-domain.ts`) does a full save, maps the draft to an `OutboundMail` (`draftToOutboundMail`, `sender.ts`), then delivers. `sendMail` (`lib/core/mailer.ts`) is the sendmail transport unless `SMTP_HOST` is set, and is **skipped in dev/test** (logged, not sent). On success the message moves to `Sent`, the draft flag clears, and `MAIL_SENT` fires. A demo box has no MTA, so `messageSend` throws `403` before any delivery and the message stays in Drafts.

**Recipient canonicalisation.** `canonicalizeRecipients` (`recipients.ts`) is the one server-side recipient set, shared by delivery and the grant. It recursively flattens RFC 2822 address groups (`Team: a@x, b@x;`) into their leaf members (fixing a pre-existing drop that lost group members), requires a bare `@` rather than the stricter `validateEmailAddress` (so `@localhost` still sends), and dedupes case-insensitively across To/Cc/Bcc with **to > cc > bcc** precedence (Bcc stays Bcc). Hard caps live as constants: `MAX_SEND_RECIPIENTS` (100) and `MAX_SEND_REFERENCES` (20), both 400 beyond. Internal vs external is `isInternalAddress` (`server-config.ts`), a lowercased mail-domain compare and the same source `buildAttachmentUrl` uses.

**Per-recipient `?email=` links.** With no `driveReferences` or no external recipients it is exactly one send, so the common case is untouched. Otherwise `messageSend` splits into one bare copy for all internal recipients plus one copy per external recipient, each carrying `?email=<that address>` links in **both** the HTML body and the plain-text alternative (`appendReferenceLinks` + `appendReferenceLinksText`, links built by `mail-template.ts`). Externals then land on the guest login with their address prefilled (see [GUEST-ACCESS.md](GUEST-ACCESS.md)). Every copy keeps the composed To/Cc headers, no copy carries a Bcc header, and each is steered by an explicit SMTP envelope `{ from, to }` so a leaked personalised link cannot reach the wrong person. `from` is always set: nodemailer replaces the envelope rather than merging it, and a `{ to }`-only envelope would leave an empty reverse path. The Sent copy stays bare (baked by `draftFullSave`).

**Pinned headers.** `OutboundMail` carries a `messageId` pinned to the Sent EML's `<draftId@mailDomain>` (`buildMessageId`, `mailfile.ts`) on every copy, so replies thread against a header the recipient actually saw and match the Sent item, fixing a pre-existing Sent-vs-wire mismatch. `draftToOutboundMail` also threads the draft's `inReplyTo`/`references` end to end (previously dropped, so Eigen replies shipped with no threading headers).

**Attempt-all delivery.** `sendMail` returns `false` on failure instead of throwing, so the copy loop attempts every copy. If at least one is accepted the draft moves to Sent and `messageSend` returns a `SentMailResult` (`EmailDraft & { failedRecipients?: string[] }`), which the send hook toasts as "Delivery to X failed" (`use-draft.ts`). If every copy fails the draft stays in Drafts and the route throws `ApiError(500)`. There is no auto-retry, since a retry would re-deliver the already-accepted copies.

## Send-time access grants

Mailing a linked container document (a `driveReference`: an eigendoc, folder, chat, and so on) can grant its recipients read access as part of the send, so the `?email=` link opens instead of landing on `RequestAccessView`. The choice stays the sender's: one dialog per send, never silent.

**Access check.** With `driveReferences` and recipients present, the composer probes each reference via `POST /drive/:ownerId/:mountId/path/:pathId/access-check` (`checkAccessForEmails`, `drive.ts`), which returns `{ canShare, recipients: [{ email, hasReadAccess, needsGuestAdmission }] }`. `hasReadAccess` is the real read flag: effective members (teams expanded) plus the entry's `read` bit plus public-ancestor visibility, not mere member-map presence. `needsGuestAdmission` is true when the address has no account, `openSignup` is false, and no registry entry exists, so even a public doc then needs an admitted OTP login. `canShare` is `false` but still 200 when the sender can read but not share; an unreadable path 403s and a stale reference 404s. The route gates guests out and strips the sender's own address. Addresses that can never be an ACL id are skipped from `recipients`: the send path deliberately accepts dotless domains (`@localhost` on a LAN box) that `parseOwnerId` rejects, so offering such a grant could only fail with an unretryable 400 in `updateACLDelta` — the same skip closes both the dialog and the grant preflight, which share this method.

**Share & send dialog.** `sendWithFreshDraft` (`email-draft.tsx`) aggregates the checks into **one** `ShareAndSendDialog`, opened only when a grantable reference has recipients needing access (`!hasReadAccess || needsGuestAdmission`). References with the same needing set collapse to one sentence; differing sets get a row per document (recipient lists past five collapse to a count). Non-actionable cases show as muted notes rather than silent omissions: unshareable references, chat references ("Chat invitations aren't granted from mail"), and, whenever a shareable reference has a needing Bcc recipient, "Bcc recipients are not granted access". **Share & send** grants each document its own needing To/Cc set; **Send without access** grants nothing. The dialog uses `useDialogPending` (`@workspace/ui`), so the actions disable in-flight and the dialog stays open on error for retry.

**Granting.** The send payload carries `grantAccessRefIds: string[]`, the reference ids the sender chose to share (a deviation from the proposed `grantReadAccess: boolean`; the array lets one send grant some references and not others). `messageSend` runs the grant **after** the empty-message 400 and the demo guard and **before** the first copy, so demo boxes and rejected sends never touch ACLs while every registry entry exists before a recipient clicks. `grantAccessForReferences` (`access-grants.ts`) dedupes and caps the ids, then **preflights all**: it resolves each reference through `getSharedDrive`, re-checks `canShare`, and rejects chat references by the *resolved* path type (never the client's `ref.driveType`), so one failure aborts before any write. Per reference, recipients lacking read get an ACL delta `{ id: email, read: true }` (preserving any existing write bit) through `updateACLDelta` and `propagateSharedPathChange`, which mints registry entries for unknown emails, fans out the shared-path mirror, and persists the in-app notification; recipients already readable via a public ancestor get **no ACL**, only an `addRegistryEntry`. Grant emails come from the To/Cc set only, so **Bcc recipients are never granted**, because a durable ACL entry would leak the Bcc identity to every reader. Grants are never rolled back: a mid-loop failure aborts the send, the earlier grants persist, and a retry is idempotent.

**Suppressed share mail.** These grants pass `suppressShareEmail: 'all'`, so the normal share-notification mail is skipped even for account-less emails, because the user's own message is the invite. `'all'` extends `ACLPropagationOptions.suppressShareEmail` from `boolean`; the chat wizard's `true` (registered-users-only suppression) is unchanged. The in-app "shared with you" notification still fires. See [ACL.md](ACL.md) and [GUEST-ACCESS.md](GUEST-ACCESS.md).

## Attachments

Uploaded files stream to a draft-temp staging area (`uploadDraftAttachment` → `tempId`), passed back as
`tempAttachmentIds` on the next draft save. Drive **files** are copied through the same staging path
(`attachFromDrive`); Drive **containers** (docs, folders) are added as `driveReferences` instead and rendered
as reference-pill `<a>` links at save/send (`renderAttachmentPills`, `mail-template.ts`) — see
[MEDIA-REFERENCES.md](MEDIA-REFERENCES.md). Received attachments re-parse from the `.eml` on read and can be
copied into Drive (`saveAttachmentsToDrive`); `text/calendar` parts are additionally summarized into a typed
`Attachment.calendarInvite` for the invite widget — see [CALENDAR.md § iMIP](CALENDAR.md#imip-email-based-calendar-invitations).

## Delivery and inbound

`POST /mail/deliver/:to` is unauthenticated but `requireLocalhost` (trusts Postfix on localhost): it resolves
the user by address, appends the raw bytes to INBOX, then synchronously scans for iMIP calendar parts
(`processInboundImip`) — see [CALENDAR.md § iMIP](CALENDAR.md#imip-email-based-calendar-invitations). On a
user's first mail init a welcome message is written straight into their INBOX (`welcome.ts`, gated by the
`onboarding.welcomeMail` server setting), bypassing SMTP.

## Protocol access (IMAP/CalDAV/WebDAV)

There is **no in-repo IMAP server**. The Maildir is written in a Dovecot-compatible on-disk format; Dovecot
runs as a separate container (`docker/dovecot/`) serving real IMAP off the same files. It authenticates via
its `checkpassword` mechanism → Eigen's `POST /internal/auth/verify` → `verifyProtocolAuth`
(`lib/auth/protocol-auth.ts`), which tries an app-password (better-auth API key) first and falls back to the
primary account password (the fallback fails if 2FA is on). The same `verifyProtocolAuth` is shared by CalDAV
and WebDAV. Full Dovecot config/deployment is in [IMAP.md](IMAP.md#dovecot-configuration-reference).

## Keyboard shortcuts and settings

Opt-in Gmail-style shortcuts (`use-mail-shortcuts.ts`; cheat sheet in `mail-shortcuts-dialog.tsx`, opened
with `?`) cover navigation (`j`/`k`/`o`/`u`), actions (`e`/`#`/`s`/`r`/`a`/`f`/`[`/`]`), `g`-chord jumps, and
`*`-chord bulk selection; compose sends on ⌘/Ctrl+Enter. Mail preferences live in the **space** app, not
`apps/mail`: `apps/space/src/components/space/mail-prefs-section.tsx` (the `keyboardShortcuts` toggle +
`autoAdvance` select) and `signature-section.tsx` (a single rich-text signature), both stored under
`UserSettings.email` (`packages/lib/src/types/settings.ts`) and consumed by the mail route via
`useSpaceSettings`.

## Not yet implemented / limitations

- `emailLabels`/`emailsToLabels` tables are **vestigial** — created by migration, never used.
- **Step 4 (worker offload) is deferred** — a cold index of tens of thousands of messages saturates the
  shared event loop until it drains (only matters for one-time bulk imports). The move also covers the
  mailparser-audit residuals: `DOMPurify.sanitize` still runs uncapped synchronous CPU on untrusted HTML
  (the `htmlToText` input is truncated at 2 MB, DOMPurify's isn't), and `html-to-text`'s stack-overflow
  catch on pathologically nested HTML rejects the whole parse (that one email becomes unreadable).
- The summary/cold-index parse fully decodes + buffers attachment content it never reads (audit #12) —
  a `skipAttachmentContent` flag is deliberately unbuilt; add it only if a real large-mailbox profile
  justifies it (largely subsumed by the worker move).
- Fast-saved drafts leave the on-disk `.eml` stale until a full save — external IMAP clients see old content.
- Primary-password protocol auth fails when 2FA is enabled (use an app password).
- A second `MailStore` backend (JMAP/Stalwart) is proposed only — see
  [PROPOSAL_STALWART_MAIL.md](PROPOSAL_STALWART_MAIL.md).

## Where the code lives

- **Backend**: `apps/api/src/lib/mail/` — the whole stack in the diagram above (routes are the one exception,
  `apps/api/src/routes/mail.ts`). Shared with other protocols: `lib/auth/protocol-auth.ts`, `lib/core/mailer.ts`.
- **Shared**: `packages/lib/src/core/mail/` — hooks (`hooks/use-emails.ts`, `use-mailboxes.ts`, `use-draft.ts`),
  query keys, optimistic-patch helpers, `sse-handlers.ts`. Types in `packages/lib/src/types/mail.ts`.
- **Frontend**: `apps/mail/src/components/mail/` — list, detail, composer, plus their `hooks/` (list state,
  actions, shortcuts). The route wiring sits in `apps/mail/src/routes/`. Mail *settings* live in
  `apps/space/src/components/space/`.

Storage internals (Maildir layout, flag encoding, sync-engine diff, Dovecot): **[IMAP.md](IMAP.md)**.
