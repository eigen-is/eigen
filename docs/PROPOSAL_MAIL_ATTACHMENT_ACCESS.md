# Proposal: mailed document links — per-recipient guest links + access grant at send

> **TLDR**: Mailing an eigendoc/folder "attachment" ships one bare link to every recipient and
> grants no access — externals hit `RequestAccessView`, and on `openSignup: false` servers a
> dead login. Phase 1 fixes the link: `messageSend` canonicalises the recipient set (flatten
> groups, dedupe, case-insensitive domain partition) and splits the SMTP send — one shared copy
> for internal recipients, one copy per external with `?email=<recipient>` links in both the
> HTML and text bodies — with identical headers via a pinned Message-ID, explicit
> `{ from, to }` envelopes, and attempt-all delivery (≥1 copy accepted → Sent + structured
> partial result). Phase 2 fixes the access: a send-time dialog, aggregated per document
> ("Give 2 recipients read access to *Roadmap*? **Share & send** / Send without access"),
> backed by a per-reference access check (`{ canShare, hasReadAccess, needsGuestAdmission }`,
> visibility-aware) and a `grantReadAccess` flag on the send payload. Grants run after the demo
> guard through the existing ACL delta + propagation with the share-notification mail
> suppressed (the user's own mail *is* the notification); public paths get registry-only
> entries instead of redundant ACLs; **Bcc recipients are never granted** (decided — a durable
> ACL entry would leak their identity to every reader). Prompting happens at **send time, not
> attach time** (decided — the recipient set doesn't exist yet at attach). ~1 day for Phase 1,
> ~2–3 days for Phase 2; the phases are independent, though Phase 1 alone adds little on
> `openSignup: false` servers. Revised 2026-08-14 after two independent review passes; all
> findings are folded in below.

## Goals

1. **External recipients land on a working login.** A mailed doc link carries
   `?email=<recipient>` for addresses outside the mail domain, so the login page opens the
   Guest tab with the address prefilled — exactly what share-notification mails already do.
2. **Recipients can actually open the document.** At send time the composer offers to grant
   read access to recipients who lack it. Mailing a doc today grants nothing; externals hit
   `RequestAccessView`, and on `openSignup: false` servers they cannot even log in.
3. **One email per recipient.** Recipients are deduplicated and grouped-address members are
   delivered; when the grant fires, the share-notification mail is suppressed — the user's own
   message is the notification and carries the personalised link.
4. **The sender stays in control.** No silent ACL changes; one dialog per send with a good
   default.
5. **Consistency.** User-composed mail is currently the *only* doc-link mail that ignores who
   the recipient is; `composeShareEmail` and `composeCollaboratorsEmail` are already
   per-recipient.

## Non-goals

- **Attaching container bytes.** Containers stay links; export-and-attach is a different
  feature.
- **Editor grants from the prompt.** Read only. Upgrading someone is what the share dialog is
  for; offering write in a send-time dialog is where accidental over-sharing creeps in.
- **Granting Bcc recipients** — decided 2026-08-14. An ACL entry is durable and visible to
  every reader of the document via the access list, which breaks the Bcc contract (a To
  recipient could discover a Bcc address). The dialog states "Bcc recipients are not granted
  access"; Bcc'd externals fall back to `RequestAccessView`. Revisit only with an opaque
  capability-link model.
- **Chat invitation semantics.** Chat references are excluded from automatic grants in v1 —
  chats have their own invite flow (`inviteToChat`, `drive.ts:959-989`) and a bare read ACL
  risks a half-joined state. The dialog shows a non-actionable note instead.
- **Auto-grant without consent** — see *§ Alternatives considered*.
- **Changing server-authored mails** (share notification, email-collaborators, access
  request) — they already have the right shape.
- **Pasted-URL detection.** Gmail also scans raw Drive URLs in the body; we only handle
  structured `driveReferences`. A pasted link is a deliberate act, and body rewriting is a
  can of worms.

## Current state (recap)

The frontend never builds a link. The compose drive-picker splits on `isContainerType`
(`apps/mail/src/components/mail/email-draft.tsx:145-156`, predicate at
`packages/lib/src/types/drive.ts:186`): containers (doc/stickies/slides/sheets, folders,
chats) become an `AttachmentReference` (`packages/lib/src/types/drive-reference.ts:3-11`)
in `mail.driveReferences[]`; plain files become real byte attachments via
`POST …/draft/attachment-from-drive` (`apps/api/src/lib/mail/mail.ts:54-79`).

All user-facing entry points funnel into that one compose flow:

- Compose paperclip → drive picker (`email-draft.tsx:333-341`).
- Drive item menu → Share ▸ "Mail to…" (`packages/ui/src/components/drive/drive-item-menu.tsx:214`)
  via `openMailComposeWith` and the `?attach=owner/mount/path` URL channel
  (`packages/lib/src/core/api.ts:114-123`, consumed at
  `apps/mail/src/routes/_auth.$filterType.$filterId.tsx:34-98`).
- Command palette `drive.mail-to` and the smart "Send {name} to {email}" results
  (`packages/lib/src/core/command-palette/commands/drive.ts:83-96`,
  `providers/smart.ts:44-118`); the open document counts as a palette selection
  (`packages/ui/src/hooks/use-eigen-doc-editor-route.ts:55-56`), so this works from inside
  the editors too. Note these funnels open the compose with the attachment pre-seeded and
  **zero recipients** — relevant to the prompt-timing decision below.

On send (`Mail.messageSend`, `apps/api/src/lib/mail/mail-domain.ts:538-575`):

- `draftFullSave` bakes reference pills into the Sent-folder EML; `appendReferenceLinks`
  (`mail-domain.ts:57-63`) re-bakes them onto the outbound body — calling
  `renderAttachmentPills(refs)` **without a recipient email**, so links are always bare. It
  touches only `message.html`; the plain-text alternative carries no document link at all.
- One `OutboundMail` with `to/cc/bcc` goes to a single `sendMail()`
  (`apps/api/src/lib/core/mailer.ts:93-111`) — one MIME message, one HTML body, no
  per-recipient loop. Postfix fans out delivery (`eigen_destination_recipient_limit = 1`),
  but every recipient gets the same bytes. `sendMail` reports failure by returning `false`,
  not by throwing (`mailer.ts:104-110`).
- `draftToOutboundMail` (`apps/api/src/lib/mail/sender.ts:4-38`) maps to/cc/bcc but does
  **not** flatten RFC 2822 address groups — `convertAddressValue` filters out entries without
  an `address`, silently dropping group members (`sender.ts:40-43`) — and does not
  deduplicate across fields. It also drops the draft's `inReplyTo`/`references` (accepted by
  `MailDraftSchema`, `apps/api/src/routes/mail.ts:37-39`, mapped nowhere), so replies sent
  from Eigen currently carry no threading headers on the wire.
- `OutboundMail` has no `messageId`; the Sent EML pins `<draftId@mailDomain>`
  (`apps/api/src/lib/mail/mailfile.ts:44`) while the wire copy gets a fresh
  nodemailer-generated ID — a pre-existing Sent-vs-wire mismatch.
- **No ACL change happens anywhere on the mail send path.**

The link machinery that already exists (`apps/api/src/lib/core/mail-template.ts`):

- `buildReferenceUrl(ref)` (`:49-68`) — per-type URLs
  (`{DOCS}/doc/{ownerId}/{mountId}/{id}`, `{DRIVE}/fs/…` for folders, …), absolutised
  against `API_URL` by `appUrl()` (`:42-47`).
- `buildAttachmentUrl(ref, recipientEmail?)` (`:73-77`) — appends
  `?email=<recipient>` unless the address ends with `@${getMailDomain()}`
  (`apps/api/src/lib/config/server-config.ts:69-73`: `MAIL_DOMAIN` env, falling back to
  `getDomain()` → `DOMAIN` env → `config.json`). A domain-suffix check, not a user lookup —
  and case-sensitive as written.
- Consumed in exactly one place: the shared login route
  (`packages/ui/src/components/layout/pages/login-route.tsx:6-11`) reads `email` from the
  search params *or* out of a nested `redirect=` param; `LoginPage` then defaults to the
  Guest tab and prefills the OTP form (`login-page.tsx:236-249`). So the param survives the
  auth redirect (`auth-route.tsx:19-29`) without any per-app route changes.
- Already per-recipient today: `composeShareEmail` (ACL add,
  `apps/api/src/lib/core/mail-composers.ts:20-43`, sent from
  `apps/api/src/lib/drive/acl-propagation.ts:85-105`) and `composeCollaboratorsEmail`
  ("Email collaborators", `mail-composers.ts:76-102`, one send per recipient from
  `apps/api/src/lib/drive/drive.ts:926-947`).

Access semantics this proposal must respect:

- `getEffectiveMembers` (`drive.ts:882-923`) expands ACL + owner/team identities only. Real
  read access is wider: `canReadFromAncestors` also grants read via `public-read` /
  `public-write` visibility on the ancestor walk (`apps/api/src/lib/drive/acl.ts:5-20`), and
  ACL entries carry independent `read`/`write` flags — presence in the member map does not
  imply read. `filterRedundantACL` (`acl.ts:115-166`) doesn't consider visibility either, so
  ACL entries added to public docs would persist as redundant clutter.
- The effective-members list is already readable by any reader
  (`GET …/effective-members`, `apps/api/src/routes/drive.ts:461-464`, gated
  `withReadPermission`) — relevant to how the access-check endpoint is gated.
- `SharedDrive.updateACLDelta` (`sharedDrive.ts:296-328`) does **not** accept or forward
  propagation options, unlike `Drive.updateACLDelta` (`drive.ts:781-789`); the sole caller
  passing options today does so on raw Drive (`apps/api/src/routes/chat.ts:99-106`).

The guest/registry flow this proposal leans on ([GUEST-ACCESS.md](GUEST-ACCESS.md)):

- Sharing with an unknown email creates a share-registry entry
  (`acl-propagation.ts:17-39` → `apps/api/src/lib/share/registry.ts:5-11` —
  `addRegistryEntry(fromUserId, email)`, standalone and lowercased), redeemed on account
  creation by `reconcileSharesForNewUser` (`apps/api/src/lib/share/reconciliation.ts:8-69`).
- Guest OTP login **requires** a registry entry when `guests.openSignup === false`
  (`apps/api/src/lib/auth/guest-auth.ts:71-74` — "No shared resources found for this
  email"). Mailing a link creates no entry, so on such servers a mailed `?email=` link
  prefills a login that is guaranteed to fail. The grant in Phase 2 is what fixes this.
- For **team-owned** paths, ACL propagation stores `team_<id>` as the registry source
  (`acl-propagation.ts:157-174`), but `reconcileSharesForNewUser` treats every source as a
  user ID and skips it when `getUserById` finds none (`reconciliation.ts:14-17`). The entry
  still admits OTP login and the owner-side ACL authorises the link, but the new guest gets
  no shared-path mirror or notification. Phase 2 fixes this (see Design § 4).
- `ACLPropagationOptions.suppressShareEmail` (`acl-propagation.ts:15`, used by the new-chat
  wizard) suppresses the share mail **only for registered users** — account-less emails
  still get it (`:94-95`), because that mail is their only invite vehicle. Phase 2 needs a
  stronger variant (see Design § 4). The in-app "shared with you" notification is unaffected
  by either variant: it persists on the recipient home via the relay fan-out
  (`apps/api/src/lib/drive/shared-with-me.ts:84-91`), independent of the mail.

## Decision context: what the incumbents do

- **Google (Gmail + Drive)**: a blocking pre-send dialog when recipients lack access —
  share with recipients (viewer/commenter/editor), turn on link sharing, or send without
  access. Interactive check, sharing as the encouraged default, admin-restrictable.
- **Microsoft (Outlook + OneDrive)**: closer to auto-grant — attaching a cloud file mints a
  sharing link on the spot (tenant-default scope, adjustable per message). Frictionless,
  and also the model that generates the "who can open this link?" compliance questions.

### Alternatives considered

1. **Silent auto-grant (Outlook-style)** — rejected. A typo'd address or a cc'd mailing
   list becomes a durable ACL entry, not just one leaked mail; recipient addresses aren't
   always people (shared inboxes, ticket systems — whoever reads the mailbox can mint a
   guest account via OTP); and the sender never sees that permissions changed. Wrong fit
   for a privacy-positioned, self-hosted product whose share dialog is deliberately
   explicit.
2. **Alert-only ("recipients may not have access")** — rejected. Without a grant button the
   fix is a manual detour through the share dialog; nobody takes it, recipients hit
   `RequestAccessView`, and on `openSignup: false` servers they hit a dead login. Half a
   feature.
3. **Hybrid: auto-grant internal, prompt external** — rejected. Two behaviours, two mental
   models, and internal recipients are the cheap case anyway (their links are bare and
   their accounts exist; a prompt costs them one click).
4. **Prompt at attach time** — rejected. The recipient set isn't final (or even non-empty)
   at attach: people attach first and address later, and the "Mail to…" menu, command
   palette, and editor entry points all open a compose with the attachment pre-seeded and
   zero recipients, so an attach-time dialog has nothing to ask. ACLs and the sender's own
   share capability also drift while a draft sits — `missing` and `canShare` are
   time-of-send properties, and the server re-derives them at send anyway. (Outlook's
   attach-time behaviour is not a consent precedent; it's the silent auto-grant of
   alternative 1.) A passive, non-consent hint on the compose pill ("Only you can open
   this") is a fine deferred addition.
5. **Prompt with read-grant default at send time (Google-style)** — **recommended.** Keeps
   the human decision, removes the friction, and one dialog covers every recipient class.

## Design

### 0 — Recipient canonicalisation (Phase 1)

One server-side canonicaliser in `lib/mail`, consumed by delivery, the access check, and the
grants — never three inline copies of the recipient set:

- Recursively flatten RFC 2822 address groups (fixing the pre-existing drop in
  `convertAddressValue`, `sender.ts:40-43`), validate addresses, and deduplicate
  case-insensitively across to/cc/bcc with precedence to > cc > bcc (the classification is
  retained — bcc stays bcc).
- Classify internal/external via a new shared `isInternalAddress(address)` helper next to
  `getMailDomain()` — lowercased domain comparison — and refit `buildAttachmentUrl` onto it
  (one source of truth; today's inline `endsWith` is case-sensitive and about to be
  duplicated).
- Hard caps as constants (e.g. 100 recipients and 20 references per send; same email cap on
  the access check) with a 400 beyond — one authenticated request must not fan out into
  unbounded SMTP transactions or ACL writes.

### 1 — Per-recipient `?email=` links (Phase 1)

Change point: `messageSend` (`mail-domain.ts:538-575`), currently `appendReferenceLinks` +
one `sendMail`.

- Partition the canonical recipient set with `isInternalAddress`. No `driveReferences`, or
  no external recipients → exactly today's single send. The common case is untouched.
- Otherwise send **one copy for all internal recipients** (bare links) and **one copy per
  external recipient** with personalised links — rendered into **both** the HTML and the
  plain-text alternative (`appendReferenceLinks` gains a text sibling; today plain-text
  clients get no link at all). All copies keep the composed To/Cc headers so every recipient
  sees the same message; no copy carries a Bcc header; delivery is steered by an explicit
  SMTP envelope.
- **Identical headers for real**: `OutboundMail` gains `messageId`, set on every copy to the
  Sent EML's pinned `<draftId@mailDomain>` (`mailfile.ts:44`) — replies from any recipient
  thread together and match the Sent item, and this fixes the pre-existing Sent-vs-wire
  Message-ID mismatch. In the same change, thread the draft's `inReplyTo`/`references`
  through `draftToOutboundMail` (broken-window fix: Eigen replies currently ship without
  threading headers).
- `OutboundMail` gains `envelope?: { from: string; to: string[] }` and `buildMailOptions`
  passes it to nodemailer (`options.envelope`), which supports it on both the SMTP and
  sendmail transports (verified against the installed 6.10.1 source). `from` is required:
  nodemailer *replaces* the generated envelope rather than merging, so a `{ to }`-only
  envelope means an empty SMTP reverse path (broken bounces, sender-policy failures). Bcc
  addresses appear only in the envelope of the appropriate copy, never as a header.
- **Sent copy unchanged** (bare links, baked by `draftFullSave`) — with multiple recipients
  there is no single "right" email for the sender's copy.
- **Failure semantics** (decided): attempt **all** copies — `sendMail` returns `false`
  rather than throwing (`mailer.ts:104-110`), so the loop checks every result. If at least
  one copy is accepted, move the draft to Sent and return a structured partial result
  (`{ failedRecipients: string[] }`) that the composer surfaces ("Delivery to X failed");
  if every copy fails, the draft stays and the route throws the existing `ApiError(500)`.
  No automatic retry in v1 — stopping at the first failure and leaving everything in Drafts
  would make the natural retry re-deliver the already-accepted copies.

Cost: a mail to N externals is N+1 SMTP transactions instead of one, bounded by the
recipient cap. Recipient counts on user-composed mail are small, and the bundled Postfix
already fans inbound delivery out per-recipient.

### 2 — Access check (Phase 2)

New route `POST /drive/:ownerId/:mountId/path/:pathId/access-check`, body
`{ emails: string[] }` (bounded by the shared cap). Always **200 for any readable path**:

```
{ canShare: boolean, recipients: [{ email, hasReadAccess, needsGuestAdmission }] }
```

- `hasReadAccess` — *real* read access, not member-map presence: the effective-members walk
  (teams expanded, implicit owner/team members) **plus** the `read` flag on the matched
  entry (an entry with `read: false` is not access) **plus** ancestor visibility
  (`public-read`/`public-write` grants read, per `canReadFromAncestors`). Case-insensitive;
  the sender's own address is excluded from the input.
- `needsGuestAdmission` — the recipient has no account, `guests.openSignup` is false, and no
  registry entry exists (`guest-auth.ts:71-74`): even with readable content (a public doc)
  they cannot log in. This is an independent dimension from `hasReadAccess`; a single
  "missing" boolean cannot represent both, which is why the response carries the facts and
  the FE derives `needsGrant = !hasReadAccess || needsGuestAdmission`.
- `canShare: false` (with 200) when the sender can read but lacks the share capability — the
  dialog renders those references as non-actionable notes. **403 only for paths the caller
  cannot read.** Treating "can't share" as data rather than an error keeps it off the
  `onMutationError` toast path ([NOTIFICATIONS.md](NOTIFICATIONS.md)) — it's a routine
  outcome, not a failure.
- A stale reference (target deleted or moved since attach) 404s; the FE treats it as
  non-checkable — no prompt for it, mail sends as-is (the link may be dead, exactly as
  today).
- Implemented as a Drive method with a `SharedDrive` wrapper per the architecture rule,
  gated on the share capability like the share dialog. (Not as an "ACL oracle" defence —
  any reader can already enumerate members via the read-gated
  `GET …/effective-members` — but because prompting a sender who can't act on the answer is
  useless.)

### 3 — Compose dialog (Phase 2)

In the mail app's send flow (`use-mail-actions.ts` `handleSend` →
`email-draft.tsx:198-200`): when the draft has `driveReferences`, call the access check for
each reference (they are few) and aggregate. **Always exactly one dialog per send** — never
a sequence of per-reference dialogs — and only when at least one *grantable* reference has
recipients needing a grant; otherwise send exactly as today with no dialog.

- Every grantable reference has the same needing-recipient set (the common case) → one
  sentence: **"Give alice@ and bob@ read access to *Roadmap* and *Budget*?"**
- Sets differ → one row per document: doc name + its needing recipients (collapse to a
  count past ~5).
- Buttons stay global: **Share & send** (primary, default) grants each document exactly its
  own needing set — no cross-product; **Send without access** (secondary) grants nothing;
  Esc returns to the composer. No per-document checkboxes in v1 — the share dialog remains
  the fine-grained tool.
- Non-actionable situations appear in the same dialog as notes, never silently omitted
  (silence would make **Share & send** read as full coverage): references the sender can't
  share ("You can't share *Budget* — recipients can request access"), chat references
  ("Chat invitations aren't granted from mail"), and — whenever needing Bcc recipients
  exist — "Bcc recipients are not granted access".
- The check + dialog are compose-side UI in `apps/mail`; the mutations stay in hooks per
  [NOTIFICATIONS.md](NOTIFICATIONS.md).

### 4 — Grant at send + notification suppression (Phase 2)

The send payload (`POST /mail/:ownerId/message/send`, `routes/mail.ts:221-232`) gains an
optional `grantReadAccess: boolean`. The send path order is normative:

```
draftFullSave → build outbound → validations (incl. empty-message 400) → demo guard → grants → copy loop
```

Grants run **after** the demo guard (`mail-domain.ts:555-560`) and the empty-message 400
(`:548-550`) so demo boxes and rejected sends never mutate ACLs, and **before** the first
SMTP copy so every registry entry exists the moment a recipient clicks.

- The grant logic lives in a `lib/mail` helper (`grantAccessForReferences`, following the
  `attachFromDrive` precedent for mail→drive calls, `mail.ts:54-79`); `messageSend` owns
  the ordering and calls it at the pinned point.
- **Preflight first**: re-check the share capability for every grantable reference before
  the first mutation. The dialog's answer is minutes old; if a capability has been lost in
  the meantime, abort the send with an error *before any side effect* — the user chose
  "Share & send", and silently downgrading that to dead links is worse than a retry.
- **Non-public paths**: per reference, `getSharedDrive(ref.ownerId, user)` → ACL delta
  adding `{ id: email, read: true }` for each needing To/Cc recipient, through the normal
  `updateACLDelta` → `propagateSharedPathChange` path — registry entries for unknown emails,
  mirror fan-out, SSE, and the in-app notification all come for free (and the notification
  is kept deliberately: registered recipients still get a notification-center row).
  `SharedDrive.updateACLDelta` must gain the `options` parameter and forward it
  (`sharedDrive.ts:296-328` has none today) — a required work item, not incidental.
- **Public paths** (`hasReadAccess` via visibility): **no ACL delta** — visibility already
  grants read, and the entries would be permanent redundant clutter `filterRedundantACL`
  can't remove. Recipients flagged `needsGuestAdmission` get a **registry-only** entry via
  `addRegistryEntry(senderId, email)` (`registry.ts:5-11`): it admits their OTP login, and
  the link then opens through public visibility; there is nothing to mirror at signup.
- **Bcc recipients are excluded from all grants** (decided — see Non-goals).
- **Suppress the share mail entirely** for these grants: extend
  `ACLPropagationOptions.suppressShareEmail` from `boolean` to `boolean | 'all'` — `'all'`
  also skips account-less emails (`acl-propagation.ts:94-95`), because here the user's own
  message carries the `?email=` invite link. The chat wizard keeps `true` (registered-only
  suppression) unchanged; the type-level union keeps existing callers untouched.
- **Team-owned references**: fix `reconcileSharesForNewUser` to resolve `team_` registry
  sources through the team home instead of skipping them (`reconciliation.ts:14-17`), so a
  guest granted a team-owned doc gets the shared-path mirror and notification like any other
  share. Small, testable, and part of Phase 2 — the alternative (narrowing the guarantee) is
  a worse product.
- **Grants are never rolled back**: if grant *k* fails at runtime after grants 1…k−1
  committed, abort the send with an error; the committed grants persist (a retry is
  idempotent and the share dialog shows them). Recipients gaining access without receiving
  mail is a recoverable state; mail promising access that was rolled back is not.

### 5 — Degradations and edge cases

- **Sender can't share** (read-only access to someone else's doc): the reference shows as a
  non-actionable note if a dialog opens at all; links go out with `?email=` (Phase 1
  behaviour); externals land on guest login → doc → `RequestAccessView`, the existing,
  working fallback ([GUEST-ACCESS.md](GUEST-ACCESS.md) § access requests).
- **Bcc'd externals**: their copy is personalised (Phase 1) but never granted (decided). On
  `openSignup: false` servers they cannot log in — the accepted trade-off; use To/Cc or the
  share dialog for someone who must have access.
- **Forwarded mail**: the `?email=` value prefills the original recipient's address for a
  forwardee — cosmetic only; the OTP still goes to that address, so no access leaks.
- **Mailing lists / shared inboxes as recipients**: a grant means whoever reads that
  mailbox can OTP in. Inherent to email-based guest auth (identical to sharing with that
  address in the share dialog today); the prompt showing the address is the safeguard.
- **Target routes drop the param**: app routes' `validateSearch` whitelist known params, so
  the surviving `?email=` after login is silently discarded — harmless by construction.
- **Guests can't send** (`requireNonGuest` on the send route), so no guest-grants-guest
  loops.
- **Demo mode**: guaranteed safe by the pinned order — grants sit after the demo guard.
- **Draft edited after a dialog choice**: there is no memory — the dialog is answered at
  send and the payload goes immediately; a later send re-checks and re-prompts (decided:
  the prompt is cheap and rare).

## Phased rollout

- **Phase 1 — personalised links** (~1 day): recipient canonicaliser + `isInternalAddress`,
  `envelope { from, to }` + `messageId` (+ threading headers) on `OutboundMail`, recipient
  partition + attempt-all copy loop in `messageSend`, `recipientEmail` threaded through
  `appendReferenceLinks` for both HTML and text. Ships alone; behaviour-invariant for
  internal-only mail. Honest caveat: on `openSignup: false` servers Phase 1 alone still
  prefills a login that cannot succeed — the registry entry from Phase 2 is the real fix.
- **Phase 2 — access grant** (~2–3 days): `checkAccessForEmails` + `SharedDrive` wrappers
  (including the `updateACLDelta` options parameter) + route, compose dialog,
  `grantReadAccess` + grant helper with the pinned ordering, `suppressShareEmail: 'all'`,
  registry-only handling for public paths, team-source reconciliation fix.
- **Deferred**: a server setting to force a policy (always grant / never prompt), pasted-URL
  detection, an "anyone with the link" option, the passive attach-time pill hint ("Only you
  can open this"), one-click retry for failed recipients.

## Verification gate

- **Canonicaliser unit tests**: group flattening, cross-field dedupe with to > cc > bcc
  precedence, case-insensitive internal/external classification, caps → 400.
- **Send tests** (extend `apps/api/src/test/mail-drive-attachments.test.ts`, send-bake test
  at `:403-455`): mixed internal/external recipients produce one internal + N external
  copies; external copies carry `?email=<that recipient>` in **both** HTML and text;
  assertions run against the final nodemailer options (envelope `{ from, to }` per copy,
  shared Message-ID equal to the Sent EML's, no Bcc header on any copy) — mocking only
  `sendMail` cannot catch envelope defects; internal copy and Sent EML stay bare;
  internal-only mail stays a single send; partial failure: ≥1 accepted → Sent +
  `failedRecipients`, all failed → draft stays + 500.
- **Access-check tests**: ACL entry with `read: false` → not `hasReadAccess`; public
  ancestor → `hasReadAccess`; registered guest vs unknown recipient across
  `openSignup` true/false → `needsGuestAdmission` matrix; sender's own address excluded;
  read-only sender → 200 `canShare: false`; unreadable path → 403; team-expanded ACLs
  honoured; stale reference → 404.
- **Grant-on-send tests**: ACL updated for needing To/Cc recipients only; **Bcc identities
  never written to any ACL** (explicit test); registry entry created for an unknown email;
  public path → registry-only, zero ACL delta; **zero** share-notification mails sent;
  in-app notification still persisted; demo mode leaves ACLs untouched; capability lost
  between dialog and send → abort before side effects; mid-loop grant failure → send
  aborted, earlier grants persist; team-owned doc on a closed-signup server → OTP login
  works, doc opens, shared-with-me mirror and notification row present (after the
  reconciliation fix).
- Manual end-to-end (per [VERIFICATION.md](VERIFICATION.md)): `openSignup: false` server,
  mail an eigendoc to an external address, click the link, OTP login with prefilled email,
  document opens.
- `bun run check`.

## Risks and caveats

- **Partial delivery**: with N copies, some can be accepted and some fail. Attempt-all +
  structured partial result is the chosen semantics; retry is manual in v1. Same reality
  `emailCollaborators` already has (`drive.ts:941-945` uses `allSettled`).
- **Copy divergence**: recipients' bodies differ from each other and from the Sent copy by
  the `?email=` suffix only; identity headers are now pinned equal across all copies.
- **ACL growth**: every granted send adds entries; the share dialog remains the place to
  see and revoke them. Public paths accrete none (registry-only).
- **Registry-only entries have no UI surface**: nothing in the share dialog represents
  them, so an admission granted for a public doc lingers even if the doc later goes
  private. Acceptable: the entry only admits *login*; access itself is still governed by
  ACL/visibility, so the worst case is an OTP login that lands on `RequestAccessView`.
- **Suppression regression risk**: the `'all'` variant must not change the chat wizard's
  `true` semantics; the type-level union keeps the old callers untouched.
- **Domain-suffix ≠ user-existence**: an external-domain address belonging to nobody and one
  belonging to an existing guest both get `?email=` — correct in both cases, since guests
  log in via OTP anyway. A `getUserByEmail` check adds nothing here.

## Decisions (2026-08-14, after two independent review passes)

1. **Prompt at send time, not attach time** — see Alternatives considered § 4. One
   aggregated dialog per send, grouped per document.
2. **Bcc recipients are never granted** — the ACL entry would durably leak the Bcc identity
   to every reader. Stated in the dialog; revisit only with opaque capability links.
3. **Chat references are excluded from automatic grants in v1** — non-actionable dialog
   note; revisit with `inviteToChat` semantics if chat refs in mail turn out to matter.
4. **No per-draft memory of "Send without access"** — re-sending after an edit re-prompts;
   the prompt is cheap and rare.
