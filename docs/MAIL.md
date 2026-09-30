# Mail

> **TLDR:** Mail is a personal email client over a per-user Maildir. The server half is `apps/api/src/lib/mail/`, the app is `apps/mail/`. The Maildir files are the truth and `mail.db` is only an index rebuilt from them, because Dovecot writes the same files out of process. The inbox has three spellings, one per layer. A send can grant its recipients access to the documents it links. The Maildir format, the sync engine and Dovecot are in [IMAP.md](IMAP.md).

## Mail is personal and sits behind a swappable store

Every user route in `apps/api/src/routes/mail.ts` is `requireSelf`: a mailbox belongs to one user and has no ACL. The route hands off to the user's `Mail` (`mail-domain.ts`), which talks to a `MailStore`. `MaildirStore` is the only one. The interface is the seam for a second backend ([JMAP](proposals/PROPOSAL_STALWART_MAIL.md), or [the user's own provider over IMAP](proposals/PROPOSAL_EXTERNAL_MAIL_PROVIDER.md)), so no file name crosses into the domain or the routes.

The `emails` row is the `EmailSummary` the list returns, unmapped; a full message is re-parsed from its `.eml`.

## The Maildir is the truth and the index follows it

Mail is the one domain whose truth is still files, because Dovecot moves and renames them behind the API's back. Hence the watchers and the readdir diff that contacts and calendar don't need ([CONTACTS.md](CONTACTS.md)).

**The file lands before the index row, always.** A crash between the two leaves the index behind the disk, and the next `reconcileMailbox` repairs it. A fast-saved draft keeps its subject, preview and recipients in a `draft-meta/` sidecar, which the Drafts sync projects back over the row it rebuilds from the stale `.eml`. A sidecar that can't be read counts as absent, so one torn file can't fail that sync.

Every Maildir write fsyncs the staged file and each indexed directory its rename or unlink changes (`lib/core/local-filesystem.ts`). A directory fsync the file system refuses (NFS, some FUSE mounts) is logged once, not thrown: the rename already happened, and a delivery answering 500 makes the MTA send a duplicate. `apps/api/src/test/mail/mail-durability.test.ts` pins each write.

## Only the reader's parse sanitizes

`parseMail` (`mail-parser/`) is Eigen's own parser. Its contract is the golden corpus in `apps/api/src/test/fixtures/mail-corpus/` (`UPDATE_GOLDEN=1` regenerates it).

DOMPurify costs more than the parse (9.4 ms against 2.5 ms on a 25 KiB message), and almost nothing that parses a message wants its body. So `parseEml` returns an `IndexedEmail`, whose `html` is `null` by type, for the index, the sync and attachment reads. `parseEmlForReader` sanitizes, and only `MaildirStore.getMessage` calls it. The type guarantees that a caller that never asked for a body never gets an unsanitized one.

## The inbox has three spellings

`packages/lib/src/constants/mailboxes.ts` is the one source of the six standard mailboxes, their special-use flags and their labels. Nobody spells a mailbox by hand. The inbox still differs per layer, the top source of subtle mail bugs:

| Layer | Inbox | Standard mailbox | Custom folder |
|---|---|---|---|
| Backend: DB `mailbox` column, SSE payloads | `''` | `Sent` | verbatim |
| Frontend query keys (`emailKeys.list`) | `'inbox'` | `sent` | verbatim |
| URL segment (`mailboxRouteSegment`) | `box/inbox` | `box/sent` | verbatim |

`canonicalMailbox` turns any spelling into the backend form at every domain entry. It case-folds the standard names, maps `INBOX` to `''`, and folds `/` onto `.`, since both delimiters name one directory. Without the fold, `Clients/Acme` would reach the DB as a second name for `Clients.Acme`. The search box passes the URL's `inbox` as is: `Mail.search` canonicalizes it, and `''` would drop the filter. Optimistic list patches match on the message id, never on a mailbox key.

## A mailbox name is a folder name, not an id

The mailbox list holds the standard six, then every other Maildir++ folder on disk, so a folder an IMAP client made just shows up. Eigen's UI creates, renames and deletes none. A custom name is literal: `Projects` and `projects` are two folders.

`isValidMailboxPath` refuses only what would break a path, not what falls outside an allowlist. Dovecot writes `&` and non-ASCII in modified UTF-7 (`Ärger` is `.&AMQ-rger`), and those are ordinary folders that `mailboxDisplayName` decodes for the sidebar. The rules and the case-clash limit are in [IMAP.md § Mailbox Structure](IMAP.md#mailbox-structure).

Custom folders have no watcher. A listing kicks a background reconcile of each one, at most once a minute per folder, because every burst of mail SSE events re-lists the mailboxes and each reconcile takes the lock user mutations need.

## The list pages by keyset and patches its own mutations

At 50k messages a mailbox, the whole list is 34 MB and one 200-row page is 130 KB (`apps/api/scripts/mail-bench.ts`). So the list never fetches all of it, and a mutation never refetches it:

- `MailDB.listMessages` pages on a `(date, id)` cursor over the `(mailbox, date DESC, id DESC)` index.
- Move, read, flag and delete patch the cached pages by message id (`patchEmailInLists`) and roll back on error, instead of invalidating.
- The server echoes each mutation over SSE. The mutation records the echo it expects (`markRecentMailMutation`), and the SSE handler skips that one refetch.
- `listMessages` answers from the DB and reconciles in the background, except on the first open of an empty mailbox ([IMAP.md § Sync Engine](IMAP.md#sync-engine)).

A notification goes out only for mail that arrives, coalesced on the `mail:new` tag. The first index of an empty mailbox rings nothing, because the mail it finds was already on disk. An import, a copy and the welcome message pass `arrival: false`, since the user or Eigen put them there.

## A draft skips the rebuild until its attachments change

A full save rebuilds the `.eml` and bakes the Drive link pills into its HTML. A fast save writes only the sidecar and the row. `messageHandleDraft` takes the fast path when the sidecar lists attachments, the kept set equals that list, and the last full save is under five minutes old. Meanwhile IMAP clients see the stale `.eml`, so `Mail.destruct` full-saves every pending sidecar. `messageGet` overlays the sidecar, so the composer shows what the user typed, not the baked markup.

`Attachment.index` is the part's raw position in the parsed message, so the keep list names raw parts and nothing renumbers. An `.ics` part is an ordinary attachment to the composer and the draft save, which never ask a part's type.

The client chooses a draft's id, and that id names a file. So the domain answers 400 to an id `isSafePathSegment` refuses, under any `MailStore`. It never maps one onto a safe name, because two mapped ids would collide on one file.

## Delivery attempts every copy and retries none

`messageSend` full-saves the draft and hands each copy to `sendMail` (`lib/core/mailer.ts`). That save pins From to the account, so a crafted draft can't send as anyone else. The route needs hosted mail, so user mail leaves through the bundled Postfix ([SERVER-SETTINGS.md § Mail environment](SERVER-SETTINGS.md#mail-environment)).

`sendMail` returns `false` instead of throwing, so the loop tries every copy. If any is accepted, the draft moves to Sent and the response lists `failedRecipients`. If all fail, the route answers 500. Nothing retries, because a retry would deliver the accepted copies twice.

## A send with links splits per external recipient

`canonicalizeRecipients` is the one recipient set, for delivery and for grants. It flattens address groups and dedupes with To over Cc over Bcc. It asks only for an `@`, so `@localhost` still sends. The route schema caps the linked documents (`MAX_SEND_REFERENCES`) before any save, because a save renders a pill per link.

When a mail links documents and has external recipients, internal recipients share one bare copy. Each external recipient gets a copy whose links carry `?email=<address>`, which lands them on the guest login with the address filled in ([GUEST-ACCESS.md](GUEST-ACCESS.md)). Each copy has its own SMTP envelope, so a personalized link can't reach the wrong person. Every copy resends the attachments, so past `MAX_PERSONALISED_SEND_BYTES` (20 MB of externals times attachment bytes) everyone gets the bare copy, whose links still work.

## Submission is held to the login's own address

The app sends to `postfix:25` without authenticating. External clients submit on 587 and 465, where a login may only send as its own address (`docker/postfix/sender_login.regexp`). There are no aliases, so login and sender are one string. The empty sender `MAIL FROM:<>` is exempt, because read receipts and vacation replies must use it (RFC 3834).

Password guessing meets three layers:

- The API counts failures per address and per client IP in a 15-minute window (`protocol-rate-limit.ts`). A valid app password is checked first, so a full bucket never locks one out.
- Postfix allows 20 AUTH attempts per client IP a minute on the submission ports, since a real client authenticates about once per message. It hangs up after 5 errors in a session. Port 25 keeps the default, where a rejected recipient should not end the session.
- fail2ban (`docker/fail2ban/`, opt-in) bans in the `DOCKER-USER` chain, because Docker's published ports never pass `INPUT`.

`docker/postfix/queue-monitor.sh` reports a growing queue, and the org owner gets a notification, because an email would wait in that queue. `docker/test-mail-hardening.sh` probes all of this.

## A send grants access only when the sender says so

A send can grant its recipients read access to the documents it links, so the `?email=` link opens. The composer checks each link through the drive `access-check` route and asks once per send, in `ShareAndSendDialog`, whenever there is something to grant or to say.

The send carries `grantAccessRefIds`, so one send can share some documents and not others. `grantAccessForReferences` runs after the demo check and before the first copy, so a rejected send touches no ACL and every grant exists before a recipient clicks. It checks every link before writing any, judging chats by the resolved path type, never the client's `driveType`. A recipient who can already read gets no ACL entry, and a share-registry entry, sourced from the path owner, only if closed signup would otherwise keep them out. Only To and Cc are granted, because an ACL entry would show a Bcc recipient to every reader. The grants pass `suppressShareEmail: 'all'`, since the user's own mail is the invite. They are never rolled back, and a retry is idempotent.

## A mail part is revalidated on every request

Every part route answers through `answerMailPart` (`serve-mail-part.ts`). A part URL carries no version stamp and a draft save rewrites a message under its id, so a part is `private, no-cache`. Its ETag is the message id, the part index and the row's date and size, and a match is a 304 before the `.eml` is parsed. A small cache of parsed messages (`parsedMessages`) lets the range requests of a seeked video share one parse.

The preview routes feed Drive's bytes-in renderers, so the quick look draws a mail part like a Drive file ([PREVIEWS.md](PREVIEWS.md)). They gate on `getBytesTextPreviewMode`, never `getTextPreviewMode`: the sender writes the mime, so a part can't pass as an Eigen document. The routes sit two segments past the index, so a part named `text` can't shadow one. `MessageView` draws the header and body for the reader and the `.eml` quick look alike, so a saved message reads as the message it was.

## Mail only arrives from the local MTA

`POST /mail/deliver/:to` is unauthenticated but `requireLocalhost`, for Postfix. It appends the bytes to the INBOX and scans them for iMIP ([CALENDAR-INVITATIONS.md § Inbound iMIP](CALENDAR-INVITATIONS.md#inbound-imip-acts-only-on-a-sender-our-own-mta-verified)). Mail to `postmaster`, `abuse` or `noreply` (`isRoleAddress`) goes to every org admin, so DMARC reports and bounces reach a human. No account and no guest can claim those addresses.

An imported `.eml` is not an arrival. It lands unread with `arrival: false`, so no notification shows a stranger's name for the user's own action. It never runs iMIP: the file has no DKIM verdict this server recorded, so an invitation inside it can't touch the calendar.

## See also

- [IMAP.md](IMAP.md): Maildir layout, the sync engine, watchers, Dovecot
- [ACL.md](ACL.md) and [GUEST-ACCESS.md](GUEST-ACCESS.md): what a grant writes
- [MEDIA-REFERENCES.md](MEDIA-REFERENCES.md): the link pills a draft carries
