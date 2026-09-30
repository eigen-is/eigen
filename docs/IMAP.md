# Maildir Storage and Dovecot

> **TLDR:** Mail lives in a per-user Maildir++ tree that Dovecot serves as it is: the filenames, flags and folder layout are Dovecot's. The store is `apps/api/src/lib/mail/` and the Dovecot container is `docker/dovecot/`. There is no IMAP server in the repo. Dovecot reads and writes the same files out of process, so the files are the truth and `mail.db` is an index that a sync rebuilds from them. Not obvious from the code: Eigen and Dovecot both move `new/` to `cur/` and a lost race is harmless, a mailbox's first index announces no new mail, only the six standard folders have a watcher, and the login helper's exit code decides whether a mail client asks for the password again. The mail app on top of the store is [MAIL.md](MAIL.md).

## The files are the truth because Dovecot writes them too

Dovecot moves, renames and deletes messages behind the API's back, so only a diff of the directories against the index sees its work. `mail.db` holds parsed metadata and flags for fast queries, and every row can be rebuilt by scanning the files: the `.eml`s, plus the `draft-meta/` sidecar a fast draft save writes, which the Drafts sync projects back over the row it rebuilds from the stale `.eml` ([MAIL.md § The Maildir is the truth](MAIL.md#the-maildir-is-the-truth-and-the-index-follows-it)).

The sync parses with `parseEml`, which never sanitizes and returns no body. Only the reader's parse sanitizes ([MAIL.md § Only the reader's parse sanitizes](MAIL.md#only-the-readers-parse-sanitizes)).

## Eigen and Dovecot both move new/ to cur/

A delivery lands in `new/`. Every sync first moves what is in `new/` into `cur/` with an empty `:2,` flag suffix, and Dovecot does the same when a client opens the folder. There is no mode switch between "Dovecot running" and "standalone": whoever renames second gets ENOENT and skips the file (`moveNewToCur`). So the store behaves the same with Dovecot or without it.

Eigen's own writes skip `new/`. A flag change, a move and a delete rename or unlink in `cur/` directly, and a saved draft lands in `cur/` with its flags already in the name. None of them takes Dovecot's `dovecot-uidlist.lock`. When both rename one file at once, the losing rename fails and the next sync reads the winner's name. A move gets a new UID in the target folder, as an IMAP MOVE (COPY plus EXPUNGE) would. For a mailbox with one owner that trade is acceptable. Each of these writes fsyncs the file and the directories it touches ([MAIL.md § The Maildir is the truth](MAIL.md#the-maildir-is-the-truth-and-the-index-follows-it)).

Without Dovecot nothing else sweeps a `tmp/`, so Eigen does: a file a crash stranded there is removed once it is 36 hours old, the age the Maildir spec gives.

## A filename carries the id, the size and the flags

```
new/:  {unique},S={size}
cur/:  {unique},S={size}:2,{flags}
       1709234567.M412345P9876Q0.host,S=4523:2,RS
```

`createUniqueMessageId` builds the unique part as `{time}.M{usec}P{pid}Q{seq}.{host}`. That part alone is the message id: `getMailIDfromFileName` cuts the name at the first `,` or `:`. So a flag change, which renames the file, never changes the id the index and the API use.

## Flags live in the filename and the index mirrors four

The letters after `:2,` are the truth. The index mirrors `S` (`isRead`), `R` (`isReplied`), `F` (`isFlagged`, the star in the UI) and `D` (`isDraft`) for queries. `T` (trashed) and `P` (passed) are parsed and kept in the name, but not indexed. The letters stay ASCII-sorted, as the spec asks.

Dovecot appends lowercase letters for IMAP keywords and maps them in its `dovecot-keywords` file. `rebuildFlagsSuffix` keeps those letters when Eigen changes a standard flag, so Eigen never strips a keyword a client set.

## The Maildir root is the inbox and a folder is a dot directory

```
eigen.mail/Maildir/        INBOX: cur/ new/ tmp/, plus subscriptions
  .Sent/                   cur/ new/ tmp/, plus the maildirfolder marker
  .Drafts/ .Trash/ .Junk/ .Archive/
  .Projects/               a folder an IMAP client made
  .Clients.Acme/           nesting is the `.` delimiter, not a nested directory
```

Eigen creates the standard six (`STANDARD_MAILBOXES`) when it first creates the Maildir, and writes `subscriptions` once then, listing the five beside the inbox. Any other folder normally comes from Dovecot, which makes one for any client that asks, and Eigen lists it under the name Dovecot gave it. A folder made through the API's create route gets its directories and marker, but no `subscriptions` line. A message sits in exactly one folder. Folder membership is the only organization mail has, and there are no labels.

## A mailbox name is refused only for what breaks a path

`mailboxDir` maps the empty name and `INBOX` to the root and any other name to `.{name}`. It joins a `/`-delimited name with `.`, so `Clients/Acme` and `Clients.Acme` are one directory. `isValidMailboxPath` splits a name on both delimiters and refuses a segment that is empty, over 200 characters, holds a control character, or starts or ends with a space. Splitting on both leaves no way to spell `..`. It refuses nothing else, because Dovecot writes non-ASCII names in modified UTF-7 (`Ärger` is `.&AMQ-rger`), and those are ordinary folders ([MAIL.md § A mailbox name is a folder name](MAIL.md#a-mailbox-name-is-a-folder-name-not-an-id)).

`canonicalMailbox` (`packages/lib/src/constants/mailboxes.ts`) case-folds the six standard names, maps `INBOX` in any case to the empty inbox name, folds `/` onto `.`, and passes any other name through. So a folder's own spelling is the one Eigen addresses it by. On a case-sensitive file system this has a limit: a folder whose name differs from a standard one only in case (`.archive` beside `.Archive`) is neither listed nor addressable, because every spelling of it lands on the standard one ([ROADMAP.md](ROADMAP.md)).

## A read answers from the index

`mailboxesList` returns the standard six first, then every other `.Folder` sorted by name, each with `total` and `unread` from the index. It skips a directory whose name fails validation: Dovecot accepts names this store can't address, and one of them must not break the listing. That folder stays reachable over IMAP. It also skips a directory that canonicalizes onto a standard mailbox (`.archive`, `.INBOX`), since that is the standard mailbox under another spelling.

For each folder outside the six, a listing starts a background reconcile, at most once a minute per folder, and the sync's SSE events carry the counts. A listing never waits for it. The throttle exists because every burst of mail SSE events re-lists the mailboxes, and each reconcile takes the lock user mutations need.

`listMessages` waits for the sync only while the mailbox has no rows, so a first open shows content. Otherwise it answers from the index at once and syncs in the background ([MAIL.md § The list pages by keyset](MAIL.md#the-list-pages-by-keyset-and-patches-its-own-mutations)).

## Every file is staged in tmp/ first

`append` writes the bytes to `tmp/`, fsyncs them and renames them into `new/`. It serves every message the store did not write itself: a delivery from Postfix (`POST /mail/deliver/:to`), an import, a copy and the welcome mail. It then reconciles the mailbox, unless the caller passes `skipReconcile`. `saveDraft` stages the same way but renames into `Drafts/cur/` with `D` and `S` set, since Eigen knows the flags. A send moves that draft to Sent and clears `D`.

## A sync diffs cur/ against the index

`reconcileMailbox` moves `new/` into `cur/`, maps every file in `cur/` by message id, and diffs that map against the mailbox's index rows. It reports each difference through `MailStoreEvents`, which the `Mail` domain class turns into SSE events and notifications.

| On disk | In the index | The sync |
|---|---|---|
| yes | no | parses and inserts it, then reports `received` |
| under another filename | yes | re-reads the flags from the name, reports `flagsChanged` |
| no | yes | deletes the row, reports `deleted` |

New files go in chunks of 250: one upsert transaction and one burst of `received` events per chunk. Batching is the cold-index win, since a row-by-row insert was most of a 100k-message sync. A file that fails to parse is logged and skipped, so one bad `.eml` can't drop the rest of its chunk.

A sync runs on a watcher event, after the store's own `append`, and on reads. A sync requested while one runs for that mailbox joins it (`reconcilingMailboxes`). Syncs run under `storeLock`, which every mutation also holds around its file-and-row pair: a sync between a move's rename and its row update would see the message as deleted.

## Only a delivered message is new mail

`append` records the id it is about to write, and whether it is an arrival, before the file lands, because a watcher's sync can reach the file first. Whichever sync reaches it answers for that id. An import, a copy and the welcome mail pass `arrival: false` and notify no one.

Every other file follows its mailbox. A mailbox with no rows yet is a first index: its files were already there, so they reach `received` as not new. An old IMAP folder, an unindexed welcome mail or a home whose `mail.db` was lost announces no new mail. In a mailbox the index already knows, a file that appears is an arrival, which is how a message an IMAP client files into a folder still notifies. `mail-sync.test.ts` and `mail-custom-mailboxes.test.ts` pin both sides.

## Only the six standard folders have a watcher

`watch` puts `fs.watch` on `cur/` and `new/` of the standard six: twelve handles per loaded home, whatever the folder count. A watcher per folder does not scale. A tree with hundreds of IMAP folders would cost hundreds of handles per home, against a per-user inotify limit that every home on the host shares.

A folder outside the six reconciles when it is opened, and when a listing's once-a-minute reconcile comes due. So a message an IMAP client files into `Projects` shows up on a later listing (the sidebar refetches on its stale time and on every mail SSE event) or on open, not within milliseconds of the write.

## A watcher checks that its directory is still the same one

inotify reports the removal of a watched directory as a plain event, and the handle then goes dead without an error. So every watcher event stats its directory and compares the inode and birth time with those read at attach. The inode alone is not enough: Linux hands a removed directory's inode number to the next directory created.

A directory recreated by then is re-attached and reconciled at once, in a fresh pass after any sync already running. A directory still gone closes the watcher, and so does a watcher `error`. A standard folder missing then, or missing when the home loads, gets its watcher back from the next `mailboxesList` once the directory exists. Until then it still reconciles when opened. A listing during teardown attaches nothing. `unwatch` closes every watcher and waits for in-flight syncs when `Mail` destructs, since a running sync would otherwise reach a closed database.

## Eigen never writes Dovecot's files

| File | Owner | Eigen |
|---|---|---|
| `dovecot-uidlist` | Dovecot | Never touches it. Deleting it makes every IMAP client re-download the mailbox. |
| `dovecot-keywords` | Dovecot | Never touches it. It maps the lowercase flag letters to keyword names. |
| `dovecot.index*` | Dovecot | Ignores them. Dovecot rebuilds them if deleted. |
| `subscriptions` | Shared | Writes it once, with the standard folders, when it creates the Maildir. Dovecot updates it on subscribe and unsubscribe. |
| `maildirfolder` | Eigen | An empty marker in each subfolder, which Maildir++ requires. |
| `mail.db` | Eigen | Dovecot ignores it. |

A sync reads only `cur/` and `new/`, and skips names that start with `.`. A listing reads only directories that start with `.`. So no Dovecot file reaches the index.

## Dovecot's config makes its folders Eigen's folders

`docker/dovecot/dovecot.conf` carries the compatibility in three settings. The login helper hands Dovecot the user's `eigen.mail/Maildir` as the mail location. The inbox namespace uses `separator = .`, so Dovecot's folder hierarchy is the on-disk `.Folder` layout. And one `mailbox` block per standard folder sets `auto = subscribe` and its `special_use` flag, so clients label the six the way Eigen does.

IMAP workers run as `vmail`, uid 1000, which owns the Maildirs in the API container. The rest of the file is TLS-only login, the `checkpassword` passdb, and the auth listener Postfix uses for submission logins. The file's comments give each reason.

How an operator turns mail on (DNS records, ports, certificates, fail2ban) is in the help center: [host your mail](../apps/index/src/data/support/self-hosting/host-your-mail.md) and [behind your web server](../apps/index/src/data/support/self-hosting/behind-your-web-server.md). Running the whole stack locally: [CONTRIBUTING.md § Eigen in Docker](CONTRIBUTING.md#eigen-in-docker).

## Dovecot asks the API whether a password is right

Dovecot's passdb runs `docker/dovecot/eigen-checkpassword`, which posts to `/internal/auth/verify`. That route is localhost-only and calls `verifyProtocolAuth`, the check CalDAV, CardDAV and WebDAV share: an app password first, then the primary password unless the account has 2FA. Postfix submission logins take the same path through Dovecot's auth listener.

**The exit code tells a wrong password from a broken server.** A 401, 403 or 429 exits 1, Dovecot's "auth failed": the client gets `535` and asks for the password. A connection failure or any other status exits 111, "temporary failure": Postfix answers `454 4.7.0` and clients retry. A 200 with no `userId` is 111 too, because an answer the script can't read is a broken API, and never an open door. That is why the script reads the HTTP status instead of using `curl -f`, which exits the same way for a 401 as for a 500. A refused password mapped to 111 would also lose failures: Dovecot re-runs or drops the helper, so some attempts would never reach the failure limiter.

The script sends the client's address as `ip`, from `TCPREMOTEIP`. Dovecot's `IP` variable is the local address, so using it would key the limiter on the server. For a submission login the client is the SMTP client, which Postfix hands to Dovecot as `rip`. The variable is unset for internal sessions such as `doveadm`, and then the field is left out.

## See also

- [MAIL.md](MAIL.md): the mail app, the send path and the routes over this store
- [CALDAV.md](CALDAV.md), [CARDDAV.md](CARDDAV.md) and [WEBDAV.md](WEBDAV.md): the other protocols on the same app passwords
- The help center's [host your mail](../apps/index/src/data/support/self-hosting/host-your-mail.md): setting up Dovecot and Postfix on a server
