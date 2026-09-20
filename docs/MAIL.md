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
[PROPOSAL_STALWART_MAIL.md](proposals/PROPOSAL_STALWART_MAIL.md) but not built. See
[IMAP.md § Code Architecture](IMAP.md#code-architecture) for the storage side in depth.

## Data model

The `emails` table **is** the `EmailSummary` DTO — the DB row is returned to the client with no mapping
(`packages/lib/src/types/mail.ts`). Columns: `id` (Maildir unique id, TEXT PK), `filename`, `subject`,
`fromShort`/`fromAddress`, `toShort`/`toAddress`, `recipientsAll`, `textShort` (plain-text body — full text
in the DB for FTS, capped only at the list-response seam), `size`, `date`, the `isRead`/`isFlagged`/
`isDraft`/`isReplied`/`hasAttachments` booleans, `mailbox`, and `created/updatedAt`. The full parsed message
(`Email = ParsedMail & EmailSummary`) is re-parsed from the `.eml` on demand; only the summary is cached.

`mail.db` lives at `<home>/eigen.mail/mail.db`. `MAIL_DB_CONFIG` (`db-config.ts`, `currentVersion: 5`):
v1 creates `emails` + base indexes; v2 adds the address columns; v3 adds the `emails_fts` FTS5 table (porter
+ unicode61) with `emails_ai/ad/au` sync triggers; v4 adds `idx_emails_mailbox_date (mailbox, date DESC, id
DESC)` — the composite index backing keyset pagination; v5 drops the `email_labels`/`emails_to_labels` tables
v1 created and nothing ever read. `emails` is the only table the mail code touches.

## Files and index

This section describes `MaildirStore`, the only `MailStore` today; under a remote backend ([PROPOSAL_EXTERNAL_MAIL_PROVIDER.md](proposals/PROPOSAL_EXTERNAL_MAIL_PROVIDER.md)) the provider holds the truth and `mail.db` is a cache of it. Mail follows the contract contacts and calendar follow: standard files are the truth and SQLite is an index that rebuilds from them ([CONTACTS.md](CONTACTS.md) states the same for `cards/*.vcf`). What differs is the writer count. Contacts and calendar files are written by the API process alone; the Maildir is also written by Dovecot, out of process, which is why this store has `fs.watch` handles and a full readdir diff where contacts has a pending-write journal and a stat-only reconcile. The three share the primitives (`LocalFilesystem.writeAtomic`, `Semaphore(1)`, `ManagedDatabase`) and not a store class.

| | Lives in | Rebuilds from the files |
|---|---|---|
| Messages, flags, mailbox membership | the `.eml` files and their Maildir names | yes |
| `emails` rows, `emails_fts` | `mail.db` | yes, by `syncMailbox` |
| A fast-saved draft's subject, preview and recipients | the `draft-meta/` sidecar | yes, by `syncMailbox`: a Drafts row rebuilt from the stale `.eml` gets the sidecar projected back over it |
| Staged draft attachments | `draft-attachments/`, swept after 24 h | not indexed, but charged to the mail quota by a walk of that directory ([QUOTA.md](QUOTA.md)) |

The sidecar is written through `writeAtomic`, and a sidecar that does not parse reads as absent — the same as a missing one — so bytes a crash tore fall back to the `.eml` instead of failing the read. `applyDraftMeta` (`MaildirStore`) is the one projection of a sidecar onto its index row: the fast save applies it beside the sidecar write, and the Drafts sync re-applies it over each row it has just rebuilt.

**A client-chosen id is a path segment.** A draft id names a Maildir file, its `draft-meta/` sidecar and, for a staged part, its `draft-attachments/` entry, so `messageHandleDraft` rejects an id `isSafePathSegment` (`lib/core/path-utils.ts`) refuses with a 400 — in the domain, not only in the store, because an id Eigen did not mint is wrong under any `MailStore`. `MaildirStore` asks the same predicate where it builds those filenames, for the staged temp ids too: a refusal, never a character mapping, since two mapped ids would collide on one file. The predicate is the one CardDAV resource names and calendar ids take ([CONTACTS.md](CONTACTS.md)); every id the server mints — `createUniqueMessageId`, `crypto.randomUUID` — passes it.

Open against the standard contacts set, in [ROADMAP.md](ROADMAP.md): Maildir writes do not fsync.

## Parsing

`parseMail(bytes): ParsedMail` (`apps/api/src/lib/mail/mail-parser/`) turns a raw `.eml` into the parsed message. It is synchronous and non-streaming — the sole caller already holds the whole file in memory — across six files: `parse.ts` (entry + attachment/body/message-meta assembly), `split.ts` (non-streaming MIME tree with byte-exact bodies), `headers.ts` (unfolds continuation lines and decodes each header by name into a typed field), `decode.ts` (transfer, charset, and `format=flowed` decoding), `html.ts` (`htmlToText`, `textAsHtml` rendering, and `cid:` → data-URI inlining), and `linkify.ts` (one regex pass that links `http(s)://` and `mailto:` URLs, bare e-mail addresses, `www.` hosts and Bluesky `@handle`s, trimming trailing punctuation and unbalanced brackets; a bare `example.com` is deliberately not guessed, since that needs a TLD list and is the most false-positive-prone case). There is no header `Map`: headers are decoded into their exact types at the seam, so the output is the shared `ParsedMail` from `packages/lib/src/types/mail.ts`, which carries only the fields Eigen consumes.

Charset decoding uses iconv-lite for the general case and `TextDecoder` for `iso-2022-jp`, the one charset iconv-lite lacks; Bun's `TextDecoder` lacks the `windows-125x`/`iso-8859-x`/`koi8-r` single-byte legacy sets, so iconv-lite stays for those.

The behavior contract is the golden corpus: every `.eml` under `apps/api/src/test/fixtures/mail-corpus/` has a committed `.golden.json`, checked by `mail-parser-golden.test.ts` (regenerate with `UPDATE_GOLDEN=1`).

## Mailboxes and the naming gotcha

**`packages/lib/src/constants/mailboxes.ts` is the single source of the special mailbox names** — `STANDARD_MAILBOXES = ['', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive']` (the empty string is INBOX) together with each one's IMAP special-use flag and the label the UI shows for it (`Junk` reads as "Spam"); FE and BE both import it and neither spells a mailbox by hand. It stays React-free so the API can import it, so the lucide icon per mailbox sits beside it in `packages/lib/src/core/mailbox-icons.ts` (`@workspace/lib/mailbox-icons`), the way `eigendoc-icons.ts` sits beside the doc-type registry. `canonicalMailbox()` (`mail-domain.ts`) normalizes any case of those six (`inbox`/`Trash`/`trash`) to canonical form at every domain entry point. **Three representations of "the inbox" coexist** — the #1 source of subtle mail bugs; never compare mailbox strings without knowing the layer:

| Layer | Inbox is | Others |
|---|---|---|
| BE canonical (DB `mailbox` column, SSE payloads, `canonicalMailbox`) | `''` | canonical case (`Sent`, `Archive`); a custom folder verbatim |
| FE query keys (`emailKeys.list`) | `'inbox'` | standard lowercased; a custom folder verbatim |
| URL segment | `box/inbox` | standard lowercased; a custom folder verbatim |

The mailbox list search box passes the URL `filterId` (`'inbox'`) **verbatim** to the search endpoint —
`Mail.search` re-canonicalizes it, so passing `''` would strip the filter and search every mailbox. The
optimistic list patch sidesteps all of this by matching on message `id`, not the mailbox key. See
[IMAP.md § Mailbox Structure](IMAP.md#mailbox-structure) for the on-disk `.Mailbox` layout.

**A mailbox name is a folder name, not an id.** `isValidMailboxPath` (`maildir-store.ts`) splits a path on either delimiter, `.` or `/`, and holds every segment to `A-Za-z0-9_- ` with no leading or trailing space and nothing empty — interior spaces because the name is user-visible, no `.` inside a segment because that is the Maildir++ delimiter, and no traversal because a segment holds no separator at all. `mailboxDir` turns a passing name into a directory and answers anything else with a 400. The segments are joined with `.`, so `Clients/Acme/2026` and `Clients.Acme.2026` are the one directory `.Clients.Acme.2026`, which is also the dotted form `mailboxesList` reports as `MaildirMailbox.path`. `''` stays the inbox and is the Maildir root itself.

**Every folder on disk is listed.** `mailboxesList` reports the standard six first, in their canonical order, then every other Maildir++ folder the Maildir holds, by path — a folder an IMAP client created through Dovecot appears in Eigen without anything in Eigen creating it. One private enumeration (`listMailboxPaths`) answers both that and `watch()`, so the list and the watchers can't drift, and it skips a `.Folder` whose name fails the rule above rather than erroring: Dovecot accepts names this store cannot address. A folder Eigen has never indexed has no rows to count, so its first listing indexes it — the rule `listMessages` applies on a first open. Enumeration stays behind the `MailStore` seam (no directory name reaches the domain or the routes), where an IMAP-backed store answers it with `LIST`. A folder created while the process runs is caught by a watcher on the Maildir root, which gives each new `.Folder` its own `cur/`+`new/` watchers as it appears.

**A custom folder's name is taken literally.** `canonicalMailbox` case-folds the six standard names and passes everything else through unchanged, so `Projects` and `projects` are two different folders. The frontend matches that: `mailboxRouteSegment` lowercases a standard mailbox (`/box/sent`) but spells a custom one verbatim (`/box/Clients.Acme`), which is what the URL segment, the `emailKeys.list` key and the search `mailbox` filter all carry. The sidebar and the "Move to folder" menu label it with `mailboxDisplayName` — the full hierarchy with `/` for the Maildir++ `.` — under a **Folders** section below the standard six, using the same row component, so drag-to-move works there too. There is no create, rename or delete UI for folders, and the `g`-chords jump only to Inbox, Sent and Drafts.

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
GET    /mail/:ownerId/message/:id/attachment/:index/:fileName       download one attachment
GET    /mail/:ownerId/message/:id/attachment/:index/embed/:fileName serve the same part inline
GET    /mail/:ownerId/message/:id/attachment/:index/preview/:kind   preview one part (text | vcard | eml)
POST   /mail/:ownerId/import                              import a saved .eml (raw body) into the inbox
POST   /mail/:ownerId/import-from-drive                   import an .eml that sits in Drive
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
  rebuild. Used when the kept set is exactly the set of parts the sidecar lists and the last full save is
  recent (`FULL_SAVE_INTERVAL_MS` = 5 min). This leaves the on-disk `.eml` stale until a full save
  (external IMAP clients see old content), so the sidecar is what the index and the composer read those
  fields from.
- **Full save** — rebuilds the RFC 5322 `.eml` (`createEmlContent`), baking Drive reference-pill HTML in.

`messageGet` overlays the sidecar onto the parsed draft so the composer shows what the user typed, not the
baked markup. `Mail.destruct` force-flushes pending sidecars so a restart never leaves a stale draft.

The composer (`apps/mail/src/components/mail/email-draft.tsx` + its `hooks/use-draft.ts`) handles To/Cc/Bcc via `ContactAutosuggest`, a `LightEditor` (Tiptap) body, drag/paste-to-attach, debounced (2.5 s) autosave keyed off a fingerprint diff, a forced full save on unmount, signature injection for new/reply drafts, and Mod+Enter to send. Reply/forward are FE-only (quoted-body composition in `use-mail-actions.ts`); reply drafts also seed the `inReplyTo`/`references` threading headers. The send flow (recipient canonicalization, per-recipient link copies, and the access-grant dialog) is its own topic below.

**Every part carries its index.** `Attachment.index` is the part's raw position in the parsed message, and the server sets it wherever it describes a part: the parser numbers the parts it collects, the sidecar stores each listed part's index, and both draft-save answers carry one per attachment even when they leave parts out. A keep list (`keepAttachmentIndexes`) therefore always names raw parts, and nothing downstream re-numbers — the composer's chips, the reader's chips and the part routes all address the number the server gave.

**Calendar parts are never compose chips.** `isCalendarPart` (`@workspace/lib/types/mail`) is the one test the composer, the reader's chip row and `messageHandleDraft` all ask, so a draft an IMAP client left carrying an invite shows only its real attachments, each under its own index. That is what the fast-save gate compares: the kept set against the set of indexes the sidecar lists, equal meaning nothing was added or removed. The sidecar is unvalidated JSON on disk, so an entry whose index is not a number — one written before entries carried an index, or one a hand edit broke — can't answer that and takes the full save, which rewrites the sidecar with indexes. An upload settles against every part the server has, invites included, so a `.ics` a user attaches — which the EML embeds as a hidden calendar part — never leaves its chip holding a tempId the server already consumed. The chip does disappear when the save lands, but the part stays: the full save and the send carry every calendar part through whatever the keep list says, because a keep list names chips and an invite never has one, so an absent index can't mean the user removed it. That invite therefore rides along unseen and can only go by discarding the draft — compose has no representation for a calendar part today ([ROADMAP.md](ROADMAP.md)).

## Send path

`messageSend` (`mail-domain.ts`) does a full save, maps the draft to an `OutboundMail` (`draftToOutboundMail`, `sender.ts`), then delivers. `sendMail` (`lib/core/mailer.ts`) is the sendmail transport unless `SMTP_HOST` is set, and is **skipped in dev/test** (logged, not sent). The SMTP hop authenticates and verifies the relay's certificate when `SMTP_USER` is set, so an instance without the bundled postfix can relay through Brevo and friends — the full env list is in [SERVER-SETTINGS.md § Mail environment](SERVER-SETTINGS.md#mail-environment). On success the message moves to `Sent`, the draft flag clears, and `MAIL_SENT` fires. A demo box has no MTA, so `messageSend` throws `403` before any delivery and the message stays in Drafts.

**Two ways out, two rule sets.** The app path sends over `postfix:25` without authenticating (`mynetworks`), so nothing below applies to it. External clients come in on the submission ports 587 and 465 with SASL, and there a login may only use its own address as the envelope sender: `smtpd_sender_login_maps` plus `reject_authenticated_sender_login_mismatch`, over the identity map in `docker/postfix/sender_login.regexp`. One address per user, no aliases and no send-as, so login and sender are the same string. A forged sender gets `553 5.7.1`. That was the hole the 2026-08-31 spam run used; the rest of that hardening (anvil AUTH caps, queue alerting, opt-in fail2ban) is in [../docker/SETUP-GUIDE.md § Mail abuse hardening](../docker/SETUP-GUIDE.md#mail-abuse-hardening).

**Recipient canonicalization.** `canonicalizeRecipients` (`recipients.ts`) is the one server-side recipient set, shared by delivery and the grant. It recursively flattens RFC 2822 address groups (`Team: a@x, b@x;`) into their leaf members (fixing a pre-existing drop that lost group members), requires a bare `@` rather than the stricter `validateEmailAddress` (so `@localhost` still sends), and dedupes case-insensitively across To/Cc/Bcc with **to > cc > bcc** precedence (Bcc stays Bcc). Hard caps live as shared FE/BE constants (`packages/lib/src/constants/mail.ts`): `MAX_SEND_RECIPIENTS` (100, a 400 beyond) and `MAX_SEND_REFERENCES` (20), which bounds `driveReferences` and `grantAccessRefIds` at the route schema (`maxItems`, a 422 beyond) so an oversized list is rejected before *any* save renders a pill per reference; `messageSend` re-checks it at runtime, since `refs` can also come from the draft sidecar, and the composer refuses the overflow at its one attach seam (`handleDriveAttach`, `email-draft.tsx`) so a 21st linked document never 422s every auto-save into a lost draft. Internal vs external is `isInternalAddress` (`server-config.ts`), a lowercased mail-domain compare and the same source `buildAttachmentUrl` uses.

**Per-recipient `?email=` links.** With no `driveReferences` or no external recipients it is exactly one send, so the common case is untouched. Otherwise `messageSend` splits into one bare copy for all internal recipients plus one copy per external recipient, each carrying `?email=<that address>` links in **both** the HTML body and the plain-text alternative (`appendReferenceLinks` + `renderAttachmentLinksText`, links built by `mail-template.ts`). Externals then land on the guest login with their address prefilled (see [GUEST-ACCESS.md](GUEST-ACCESS.md)). Every copy keeps the composed To/Cc headers, no copy carries a Bcc header, and each is steered by an explicit SMTP envelope `{ from, to }` so a leaked personalized link cannot reach the wrong person. `from` is always set: nodemailer replaces the envelope rather than merging it, and a `{ to }`-only envelope would leave an empty reverse path. The Sent copy stays bare (baked by `draftFullSave`).

**Personalization byte budget.** Every personalized copy carries the mail's file attachments again, so the split costs `externals × attachment bytes` through the MTA while the request is still open — 40 externals and a 15 MB deck would be 600 MB, long past the point where the browser gives up. `messageSend` splits only while that product stays within `MAX_PERSONALISED_SEND_BYTES` (`recipients.ts`, 20 MB); beyond it the send takes the same single bare-link copy the no-refs/no-externals case takes, so every recipient still gets working links and lands on the normal login. A mail with links but no file attachments has a product of zero, so it always splits.

**Pinned headers.** `OutboundMail` carries a `messageId` pinned to the Sent EML's `<draftId@mailDomain>` (`buildMessageId`, `mailfile.ts`) on every copy, so replies thread against a header the recipient actually saw and match the Sent item, fixing a pre-existing Sent-vs-wire mismatch. `draftToOutboundMail` also threads the draft's `inReplyTo`/`references` end to end (previously dropped, so Eigen replies shipped with no threading headers).

**Attempt-all delivery.** `sendMail` returns `false` on failure instead of throwing, so the copy loop attempts every copy. If at least one is accepted the draft moves to Sent and `messageSend` returns a `SentMailResult` (`EmailDraft & { failedRecipients?: string[] }`), which the send hook toasts as "Delivery to X failed" (`use-draft.ts`). If every copy fails the draft stays in Drafts and the route throws `ApiError(500)`. There is no auto-retry, since a retry would re-deliver the already-accepted copies.

## Send-time access grants

Mailing a linked container document (a `driveReference`: an eigendoc, folder, chat, and so on) can grant its recipients read access as part of the send, so the `?email=` link opens instead of landing on `RequestAccessView`. The choice stays the sender's: one dialog per send, never silent.

**Access check.** With `driveReferences` and recipients present, the composer probes each reference via `POST /drive/:ownerId/:mountId/path/:pathId/access-check` (`checkAccessForEmails`, `drive.ts`), which returns `{ canShare, recipients: [{ email, hasReadAccess, needsGuestAdmission }] }`. `hasReadAccess` is the real read flag: effective members (teams expanded) plus the entry's `read` bit plus public-ancestor visibility, not mere member-map presence. `needsGuestAdmission` is true when the address has no account, `openSignup` is false, and no registry entry exists, so even a public doc then needs an admitted OTP login. `canShare` is `false` but still 200 when the sender can read but not share; an unreadable path 403s and a stale reference 404s. The route gates guests out and strips the sender's own address. Addresses `parseOwnerId` can't turn into an ACL id are skipped from `recipients`: the send path accepts dotless domains (`@localhost` on a LAN box), and a grant offered for one could only fail with an unretryable 400 in `updateACLDelta`. The dialog and the grant preflight share this method, so one skip covers both.

**Share & send dialog.** `sendWithFreshDraft` (`email-draft.tsx`) aggregates the checks into **one** `ShareAndSendDialog`, opened whenever the send has something to say: a grantable reference with recipients needing access (`!hasReadAccess || needsGuestAdmission`), a note, or both. References with the same needing set collapse to one sentence; differing sets get a row per document (recipient lists past five collapse to a count). Non-actionable cases show as muted notes rather than silent omissions: unshareable references, chat references ("Chat invitations aren't granted from mail"), and, whenever a shareable reference has a needing Bcc recipient, "Bcc recipients are not granted access". With nothing grantable the dialog is notes-only — "Send without sharing?" over the notes, with a plain **Send** as its primary — so the sender hears about a link that lands on `RequestAccessView` before sending, not after. **Share & send** grants each document its own needing To/Cc set; **Send without access** grants nothing. The dialog uses `useDialogPending` (`@workspace/ui`), so the actions disable in-flight and the dialog stays open on error for retry. `Mod+Enter` is inert while it is open, being document-wide and so the one send entry point the modal doesn't block, and a rejected send re-enables the composer's auto-save, since that draft never left.

**Granting.** The send payload carries `grantAccessRefIds: string[]`, the reference ids the sender chose to share (a deviation from the proposed `grantReadAccess: boolean`; the array lets one send grant some references and not others). `messageSend` runs the grant **after** the empty-message 400 and the demo guard and **before** the first copy, so demo boxes and rejected sends never touch ACLs while every registry entry exists before a recipient clicks. `grantAccessForReferences` (`access-grants.ts`) dedupes and caps the ids, then **preflights all**: it resolves each reference through `getSharedDrive`, re-checks `canShare`, and rejects chat references by the *resolved* path type (never the client's `ref.driveType`), so one failure aborts before any write. Per reference, recipients lacking read get an ACL delta `{ id: email, read: true }` (preserving any existing write bit) through `updateACLDelta` and `propagateSharedPathChange`, which mints registry entries for unknown emails, fans out the shared-path mirror, and persists the in-app notification; recipients already readable via a public ancestor get **no ACL**, only an `addRegistryEntry`, sourced from the *path owner* and not the sender (a team-owned doc registers `team_*`), matching what the ACL branch writes. Grant emails come from the To/Cc set only, so **Bcc recipients are never granted**, because a durable ACL entry would leak the Bcc identity to every reader. Grants are never rolled back: a mid-loop failure aborts the send, the earlier grants persist, and a retry is idempotent.

**Suppressed share mail.** These grants pass `suppressShareEmail: 'all'`, so the normal share-notification mail is skipped even for account-less emails, because the user's own message is the invite. `'all'` extends `ACLPropagationOptions.suppressShareEmail` from `boolean`; the chat wizard's `true` (registered-users-only suppression) is unchanged. The in-app "shared with you" notification still fires. See [ACL.md](ACL.md) and [GUEST-ACCESS.md](GUEST-ACCESS.md).

## Attachments

Uploaded files stream to a draft-temp staging area (`uploadDraftAttachment` → `tempId`), passed back as
`tempAttachmentIds` on the next draft save. Drive **files** are copied through the same staging path
(`attachFromDrive`); Drive **containers** (docs, folders) are added as `driveReferences` instead and rendered
as reference-pill `<a>` links at save/send (`renderAttachmentPills`, `mail-template.ts`) — see
[MEDIA-REFERENCES.md](MEDIA-REFERENCES.md). Received attachments re-parse from the `.eml` on read and can be
copied into Drive (`saveAttachmentsToDrive`); `text/calendar` parts are additionally summarized into a typed
`Attachment.calendarInvite` for the invite widget — see [CALENDAR.md § iMIP](CALENDAR.md#imip-email-based-calendar-invitations).

**The reader's chips.** `ReadAttachments` (`apps/mail/src/components/mail/read-attachments.tsx`) turns every non-calendar part into a `FileSubject` through `subjectFromMailAttachment`, keeping the raw part index so hiding the `text/calendar` parts never shifts the ones around them. A click on a chip opens the quick look with the rest of the chips as its siblings, so ← → pages through the message's attachments and never lands on a hidden invite. A right-click — a long-press on touch, through the chip-menu wiring shared with chat and the cards — opens the singleton context menu with that part's `FILE_ACTIONS` rows: Quick preview, Download, Save to Drive…, a convert for an `.xlsx` or `.docx`, Import to Contacts for a `.vcf`. The down-arrow button beside the chips saves every visible part at once. Every save, one part or all of them, goes through the shared `SaveToDrivePicker` ([PREVIEWS.md](PREVIEWS.md)), which calls `useSaveMailAttachmentsToDrive` with the message id and the chosen indexes and keeps "Download instead" as the escape hatch. A convert saves the part to the picked folder first and converts what it saved, because a mail part has no Drive path to convert in place.

**Serving one part.** All four part routes read the part through `readMailPart` (`lib/mail/serve-mail-part.ts`), which answers `If-None-Match` with a 304 off the summary row before `messageGetAttachment` parses the message and sets `Cache-Control` and `ETag`; the two byte routes then hand the part to `serveMailPart` with the disposition and the `Range` header: `Content-Type` from the part — plus `; charset=<x>` for a `text/*` part that declared one, or the browser reads a latin-1 body as UTF-8 — `Content-Disposition` from `mailAttachmentName(att, index)`, `X-Content-Type-Options: nosniff` always, `scriptableInlineHeaders` spread in on the `/embed/` route so a scriptable part renders under the sandbox CSP, `private, no-cache` (the URL carries no version stamp, so a `max-age` would serve a rewritten draft's old bytes from disk cache and skip the ownership check; the ETag makes revalidation a cheap 304), and `Accept-Ranges: bytes` with a 206 over `att.content.slice` through the shared `rangeResponse` (`lib/core/http.ts`), the one 416/206/200 shape drive's `serveFile` and the WebDAV GET answer with too (a mail `video/mp4` or `audio/mpeg` part reaches a media element whose seeking needs ranges, and Safari refuses a source that advertises none). The ETag is the message id, the part index and the summary row's date and size; a draft rewrite updates both, so two full saves within one second that keep the byte count identical would share it. The `:fileName` segment is decoration: the served name comes from the part. `mailAttachmentName` (`packages/lib/src/types/mail.ts`) is the one sanitized name — shared by the reader chip label, the disposition and the file `saveAttachmentsToDrive` writes — and the sender controls what goes in: it takes the basename, drops control characters, and falls back to `attachment-<n>`, 1-based, when the part carries no usable filename. A part with no `Content-Type` header parses to an empty type and is served as `application/octet-stream`.

**Previewing one part.** Beside the byte routes, `GET /mail/:ownerId/message/:id/attachment/:index/preview/text`, `.../preview/vcard` and `.../preview/eml` answer with exactly the shapes the Drive preview routes answer with — `TextPreviewResult`, the `VCardPreview` cards and the `EmlPreview` message (`packages/lib/src/types/preview.ts`) — so the overlay renders a mail part with the components a Drive file gets ([PREVIEWS.md](PREVIEWS.md)). All three sit two segments past the index, like `/embed/:fileName`: the sender names the part and `:fileName` takes any single segment, so a one-segment preview route would be shadowed by a part named after it. All three read the part through the same `readMailPart` — the same `If-None-Match` 304 off the summary row, before anything parses the `.eml`, and the same `private, no-cache` and ETag rather than a `max-age`, because a preview URL carries no version stamp and a rewritten draft must revalidate instead of serving the body it had; a preview route additionally hands `readMailPart` its renderer's format tag, which goes into the ETag, so a payload or sanitizer fix is not answered with a 304 on a message whose own bytes never moved. All three end in the one bytes-in renderer under Drive's own routes (`getBytesTextPreview` / `getBytesVCardPreview` / `getBytesEmlPreview`, `lib/preview/preview-cache.ts`): a mail part has no Mount and no version stamp, so it renders on every request with no cache in front, while Drive keeps its per-version cache. The gates are the shared ones — `getBytesTextPreviewMode` decides whether a part has a text preview at all (404 when it doesn't), never `getTextPreviewMode`: a sender writes the mime, so a part is rendered and labeled as what its name says rather than inside the document frame an eigen mime claims. `assertVCardPreviewable` refuses a part the mime and name don't call a vCard (400) or one past `IMPORT_MAX_BYTES` (413), the same ceiling an import carries, and `assertEmlPreviewable` does the same for a part that is not a message (400, and 413 past `EML_MAX_BYTES`); a part's size is only known once the message is parsed, so those ceilings are checked on the bytes in hand rather than before the read. A forwarded message is an ordinary part here: the splitter flattens a `message/rfc822` part into its parent only when it is disposed `inline`, so an attached one keeps its own bytes and previews as the message it holds. The text preview decodes with the part's own `charset` (`Attachment.charset`, kept by the parser as an RFC 2045 token because it also reaches a `Content-Type` header), defaulting to UTF-8.

**ETag and re-parsing.** The ETag is the message id, the part index and the summary row's date + size: a draft save rewrites the message under its existing id, re-delivering it as a fresh `<id>,S=<size>:2,<flags>` Maildir file, so the id alone would pin stale bytes (the filename itself carries commas, which `matchesIfNoneMatch` splits `If-None-Match` on). A matching `If-None-Match` is answered with a 304 off that summary row *before* `messageGetAttachment`, because reading a part re-parses and decodes the whole `.eml`: without that check every range request of a seeked video would pay one full parse. A cache miss still does — each range request re-parses the message.

## Delivery and inbound

`POST /mail/deliver/:to` is unauthenticated but `requireLocalhost` (trusts Postfix on localhost): it resolves
the user by address, appends the raw bytes to INBOX, then synchronously scans for iMIP calendar parts
(`processInboundImip`) — see [CALENDAR.md § iMIP](CALENDAR.md#imip-email-based-calendar-invitations). On a
user's first mail init a welcome message is written straight into their INBOX (`welcome.ts`, gated by the
`onboarding.welcomeMail` server setting), bypassing SMTP.

**Role addresses.** When no user owns the recipient and `isRoleAddress` (`apps/api/src/lib/config/server-config.ts`) matches — an address on this server's mail domain whose local part is `postmaster`, `abuse`, or `noreply` (`ROLE_MAILBOX_LOCAL_PARTS`, `packages/lib/src/validation/username.ts`, also part of the reserved-username list) — `mailboxDeliver` delivers the raw bytes unchanged to the INBOX of every org admin (owners and admins, `getOrgAdmins`), so DMARC aggregate reports to `postmaster@` and delivery-status notifications for system mail sent as `noreply@` reach a human instead of bouncing (RFC 2142). No mailbox is created for these addresses. Nobody can claim one: the better-auth `user.create.before` / `user.update.before` hooks reject a role address on every creation and email-change path, and `requestOtp` refuses a guest sign-in for any address on the mail domain, since guest rows bypass those hooks. External addresses such as `postmaster@example.com` are unaffected.

**Importing a saved message.** `POST /mail/:ownerId/import` takes one `.eml` as the raw body and `POST /mail/:ownerId/import-from-drive` takes one the user may read from any drive (`getSharedDrive`; not an `.eml` by `isEmlFile` → 400, past `EML_MAX_BYTES` → 413, the ceiling the raw route enforces on the body too). Both are `requireNonGuest` + `requireSelf` and end in `Mail.messageImport`, which parses the bytes first — a file carrying none of `From`, `Date`, `Subject` or `Message-ID` is not a message and is a 400 with nothing written — charges them to the mail + contacts budget (`enforceMailAndContactsQuota`, 507 before any write, [QUOTA.md](QUOTA.md)), then appends them to the INBOX through the store, so the message arrives unread with the sync and SSE event a delivery gets. It never runs `processInboundImip`: an imported file carries no DKIM verdict this server recorded, so a `text/calendar` REQUEST inside it stays an attachment and no calendar event is created or changed. Importing the same file twice gives two messages, the way an IMAP `APPEND` does.

`POST /internal/mail/queue-alert` is the other localhost-only mail route. The queue lives on a private volume, so the API cannot count it; `docker/postfix/queue-monitor.sh` counts it inside the Postfix container and posts the number once it crosses `QUEUE_ALERT_THRESHOLD`. The route resolves `getOrgOwner()` and relays an `admin-alert` notification through `sendToHome` (never a cross-home `getHome()`), coalesced on the `mail-queue-backlog` tag. A notification and not an email, because an email about a jammed queue would sit in that queue.

## Protocol access (IMAP/CalDAV/WebDAV)

There is **no in-repo IMAP server**. The Maildir is written in a Dovecot-compatible on-disk format; Dovecot
runs as a separate container (`docker/dovecot/`) serving real IMAP off the same files. It authenticates via
its `checkpassword` mechanism → Eigen's `POST /internal/auth/verify` → `verifyProtocolAuth`
(`lib/auth/protocol-auth.ts`), which tries an app-password (better-auth API key) first and falls back to the
primary account password (the fallback fails if 2FA is on). The same `verifyProtocolAuth` is shared by CalDAV
and WebDAV. Full Dovecot config/deployment is in [IMAP.md](IMAP.md#dovecot-configuration-reference).

`verifyProtocolAuth` counts failures per address and per client IP (`protocol-rate-limit.ts`). Both buckets now
fill on the SASL path too: `eigen-checkpassword` forwards Dovecot's `TCPREMOTEIP`, and for a submission login that is
the SMTP client's address, which Postfix reports to Dovecot as `rip`. A valid app password is checked before
the limiter, so a saturated bucket never locks out an app-password client.

## Keyboard shortcuts and settings

Opt-in Gmail-style shortcuts (`use-mail-shortcuts.ts`; cheat sheet in `mail-shortcuts-dialog.tsx`, opened
with `?`) cover navigation (`j`/`k`/`o`/`u`), actions (`e`/`#`/`s`/`r`/`a`/`f`/`[`/`]`), `g`-chord jumps, and
`*`-chord bulk selection; compose sends on ⌘/Ctrl+Enter. The whole set stands down while a dialog is open (`useDialogOpen`, [LAYOUT.md § Keyboard Shortcuts](LAYOUT.md#keyboard-shortcuts)), and the chords also while a field is focused. Mail preferences live in the **space** app, not
`apps/mail`: `apps/space/src/components/space/mail-prefs-section.tsx` (the `keyboardShortcuts` toggle +
`autoAdvance` select) and `signature-section.tsx` (a single rich-text signature), both stored under
`UserSettings.email` (`packages/lib/src/types/settings.ts`) and consumed by the mail route via
`useSpaceSettings`.

## Not yet implemented / limitations

- **No labels** — a message belongs to exactly one mailbox, and that is the only organization mail offers.
- **Step 4 (worker offload) is deferred** — a cold index of tens of thousands of messages saturates the
  shared event loop until it drains (only matters for one-time bulk imports). The move also covers the
  residuals from the mail-parser audit: `DOMPurify.sanitize` still runs uncapped synchronous CPU on untrusted
  HTML in `mail-parse.ts` (the `htmlToText`/`textToHtml` inputs are capped at 2 MB in `html.ts`, DOMPurify's isn't).
  `html-to-text` throws on pathologically nested HTML (tens of thousands of nested tags); that propagates out of
  `parseMail`, so that one email becomes unreadable rather than degrading.
- The summary/cold-index parse fully decodes + buffers attachment content it never reads (audit #12) —
  a `skipAttachmentContent` flag is deliberately unbuilt; add it only if a real large-mailbox profile
  justifies it (largely subsumed by the worker move).
- Fast-saved drafts leave the on-disk `.eml` stale until a full save — external IMAP clients see old content.
- Folders outside the standard six are listed, watched and openable, but Eigen offers no way to create, rename or delete one — that stays an IMAP client's job (the `POST /mail/:ownerId/mailbox` route exists and no UI calls it).
- A `.eml` is a first-class file only on the way out (`/message/:id/download`): in Drive or as an attachment it gets the
  fallback card, and nothing imports one into a mailbox ([ROADMAP.md](ROADMAP.md)).
- Primary-password protocol auth fails when 2FA is enabled (use an app password).
- A second `MailStore` backend (JMAP/Stalwart) is proposed only — see
  [PROPOSAL_STALWART_MAIL.md](proposals/PROPOSAL_STALWART_MAIL.md).
- Mail is hosted or absent: `MaildirStore` is the only `MailStore`, and inbound mail and inbound iMIP only ever arrive through an MTA on localhost (`POST /mail/deliver/:to`). A user whose mailbox lives at another provider has no Mail app and no inbound invitations. An IMAP-backed store for that case is proposed in [PROPOSAL_EXTERNAL_MAIL_PROVIDER.md](proposals/PROPOSAL_EXTERNAL_MAIL_PROVIDER.md).

## Where the code lives

- **Backend**: `apps/api/src/lib/mail/` — the whole stack in the diagram above (routes are the one exception,
  `apps/api/src/routes/mail.ts`). Shared with other protocols: `lib/auth/protocol-auth.ts`, `lib/core/mailer.ts`.
- **Shared**: `packages/lib/src/core/mail/` — hooks (`hooks/use-emails.ts`, `use-mailboxes.ts`, `use-draft.ts`),
  query keys, optimistic-patch helpers, `sse-handlers.ts`. Types in `packages/lib/src/types/mail.ts`.
- **Frontend**: `apps/mail/src/components/mail/` — list, detail, composer, plus their `hooks/` (list state,
  actions, shortcuts). The route wiring sits in `apps/mail/src/routes/`. Mail *settings* live in
  `apps/space/src/components/space/`.

Storage internals (Maildir layout, flag encoding, sync-engine diff, Dovecot): **[IMAP.md](IMAP.md)**.
