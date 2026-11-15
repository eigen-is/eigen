# Eigen against the Follow the Money checklist

> **TLDR:** Follow the Money published a checklist of 228 requirements for an organisation that wants to leave Google Workspace. Eigen is scored against every row, honestly, as the code stands on 15 November 2026, and names the proposal or roadmap row that would close each gap, or says there is none. Eigen is strong on documents, Drive, calendar, contacts and the open protocols. It is weak on admin and security controls and on mail rules, and it has no video meetings, no AI and no desktop or mobile apps. As a supplier it fails most of the organisation rows: it is a young, pre-1.0 project with one maintainer.

The checklist is the public sheet [Checklist Google Workspace-alternatieven](https://docs.google.com/spreadsheets/d/1J4jPJWUT8hyIvvoR8Qvuv2nEQOTDX1mJsSNM5ZBdw6w/edit?gid=0#gid=0), first published 14 October 2026 and updated 21 October 2026. Follow the Money wrote it from their own needs, for an organisation of about 80 people. It holds no scores and no priorities, so the score says only whether Eigen does a thing, not how much it matters. The requirements in the tables are short English renderings of the Dutch rows. The numbers count from the first requirement, so number 1 is row 7 of the sheet.

Each row was checked in the code, not only in the docs, at commit `989411aa0` on branch `home-relay`, which is develop plus the home-relay work. A status means:

| Status | Meaning |
|---|---|
| Yes | Built, and a user or admin can reach it today |
| Partly | Some of it is built; the notes say what is missing |
| No | Not built |
| Operator | Up to whoever runs the server, not to Eigen's code; the notes say what Eigen offers toward it |
| n/a | Does not apply to software you host yourself |

The plan column names a proposal in `docs/proposals/` or a row in a backlog. A proposal is a design, not a promise: most are not built, and some are shelved on purpose. "None" means no proposal or roadmap row covers the gap today.

## The score per section

| Section | Rows | Yes | Partly | No | Operator or n/a |
|---|---|---|---|---|---|
| Security | 13 | 4 | 1 | 6 | 2 |
| Admin | 26 | 5 | 5 | 16 | 0 |
| Supplier | 19 | 3 | 3 | 11 | 2 |
| Webmail | 19 | 8 | 3 | 8 | 0 |
| Calendar | 17 | 5 | 3 | 9 | 0 |
| Contacts and tasks | 4 | 3 | 1 | 0 | 0 |
| Documents | 22 | 13 | 6 | 3 | 0 |
| Word processing | 10 | 8 | 0 | 2 | 0 |
| Spreadsheets | 16 | 12 | 0 | 4 | 0 |
| Presentations | 11 | 5 | 2 | 4 | 0 |
| Video meetings | 18 | 0 | 0 | 18 | 0 |
| Chat | 24 | 9 | 5 | 10 | 0 |
| AI | 4 | 0 | 0 | 4 | 0 |
| Platforms | 15 | 4 | 5 | 6 | 0 |
| Migration | 5 | 1 | 2 | 2 | 0 |
| Integrations | 5 | 1 | 0 | 4 | 0 |
| **Total** | **228** | **81** | **36** | **107** | **4** |

## Where the gaps are, and which ones have a plan

Most gaps have no plan. The proposals that do exist cover a handful of rows each, and several cover a row only in part. Read this list before quoting a proposal as the answer to a row.

| Proposal or backlog row | Status | Rows it would close | What it would not close |
|---|---|---|---|
| [PROPOSAL_SSO.md](proposals/PROPOSAL_SSO.md) | Not built, size M, waits for an organisation that asks; [ROADMAP.md](ROADMAP.md) row "SSO / enterprise login" | Sign-in to Eigen with the organisation's own identity provider over OIDC, and accounts made on first sign-in, so row 219 in part | Row 224 asks the opposite: Eigen as the identity provider for other services. The proposal lists that as a non-goal, along with SAML, SCIM and mapping groups to teams. ROADMAP.md wants the "A new account can take a deleted user's email address" fix first |
| [PROPOSAL_SCRIPTING_PLATFORM.md](proposals/PROPOSAL_SCRIPTING_PLATFORM.md) | Not started, size L; [ROADMAP-POST-1.md](ROADMAP-POST-1.md) | Scripts in JavaScript against an SDK that checks permissions. Its phase 5 opens the same SDK over MCP and OAuth 2.1, so an outside assistant such as Claude Desktop can read and change a user's files, mail and calendar with that user's rights: rows 201 and 202, in part. Its SDK gives rows 226 and 227 a token-based API, and its operator switch is a central off switch, row 203 | It brings no assistant inside Eigen: the user brings their own. The SDK leaves out Chat, so row 228 stays open. Its OAuth server serves MCP clients only, not sign-in elsewhere (row 224) |
| [PROPOSAL_AI.md](proposals/PROPOSAL_AI.md) | Research only; ROADMAP-POST-1.md shelves it (size XL, needs a GPU sidecar, kept as a grant narrative) | AI that runs in the browser or on the server, so nothing leaves the instance: writing help and summaries (row 201), semantic search (row 202) | It has a per-user setting, not an admin switch (row 203) |
| [PROPOSAL_TEAM_ADDRESSES.md](proposals/PROPOSAL_TEAM_ADDRESSES.md) | Not built; ROADMAP.md row "Team mail addresses" | A team gets an address whose mail reaches every member (rows 18 and 60); phase 2 lets members send as the team (rows 19, 59 and 61, in part). It also lets a team calendar invite outside guests properly | Each member gets their own copy, so it is no shared mailbox with one read state. Personal aliases (rows 20 and 59) stay open |
| [PROPOSAL_RSPAMD.md](proposals/PROPOSAL_RSPAMD.md) | Not built, 1 to 2 days; ROADMAP.md row "rspamd sidecar + spam learn-loop" | Spam scoring and learning from Report spam (row 9), and SPF, DKIM and DMARC checks on mail that arrives (row 7) | Malware scanning (row 10) |
| [PROPOSAL_PUBLIC_LINKS.md](proposals/PROPOSAL_PUBLIC_LINKS.md) | Not built, and no roadmap row | A view-only link that needs no account (row 106) | Edit links are a possible phase 2 |
| [PROPOSAL_CALENDAR_IMPORT.md](proposals/PROPOSAL_CALENDAR_IMPORT.md) | File import built, subscriptions not; ROADMAP.md row "Calendar subscriptions" | Subscribing to an outside calendar feed (row 82) | Sharing a calendar with outside people (row 81) |
| [PROPOSAL_PORTABLE_DOCUMENTS.md](proposals/PROPOSAL_PORTABLE_DOCUMENTS.md) | Not built; ROADMAP.md row | A document downloaded as one file and uploaded on any Eigen server (row 55, in part) | Chat rooms have no export, and Drive has no folder download as zip |
| [PROPOSAL_EXTERNAL_MAIL_PROVIDER.md](proposals/PROPOSAL_EXTERNAL_MAIL_PROVIDER.md) | Not built, waits for SSO; ROADMAP-POST-1.md | Eigen's Mail on a mailbox at another provider, which eases a migration | A one-shot IMAP import (row 220), which it calls separate, smaller work |
| [PROPOSAL_STALWART_MAIL.md](proposals/PROPOSAL_STALWART_MAIL.md) | Not built; ROADMAP-POST-1.md advises waiting until a user asks for JMAP | Its open questions list Sieve, which would bring mail rules and an away reply (rows 63 and 65) | Sieve is deferred inside the proposal too |
| [DOCS-TODO.md](DOCS-TODO.md) "Suggesting mode (track changes)" | Not built, size XL | Suggested changes in Docs (row 128), and part of who changed what (row 112) | |
| ROADMAP.md "Search: full chat history", "Search: calendar events", "Comments: a mention sends no mail", "Event times use a 12-hour clock" | Not built, each small | Rows 187, 92, 127 and part of 93 | |

These gaps have no proposal and no roadmap row:

- **Security and admin:** hardware keys and passkeys, an Advanced Protection mode, encryption at rest, end-to-end encryption, malware scanning, deactivating a user, bulk user actions, more than one mail domain, a quota per user, removing 2FA for a user who lost it, an audit log, failed sign-ins, who lacks 2FA, security alerts, enforcing 2FA, a password policy and expiry, an org-wide mail log, and handing a leaver's data to someone else.
- **Mail and calendar:** forwarding, rules, an away reply, conversation view, search by date or attachment, working hours, private events, rooms, booking pages, and a date-format and week-start setting.
- **Documents:** a commenter role (commenting needs write access, so "view and comment" cannot be given without edit), transferring ownership of files and folders, and OpenDocument and CSV files (.odt, .ods, .odp, .csv): every Office round trip uses only Microsoft's formats.
- **Sheets and slides:** pivot tables, protected ranges, slide layouts, speaker notes, a presenter view, tables on slides.
- **Video meetings:** all 18 rows. Eigen has no video code at all, and an event cannot even carry a meeting link as a link.
- **Chat:** threads (the `replyTo` column exists, with no interface), pinning, a list of a chat's files, mute, presence, formatting, code blocks, reactions, calls, custom emoji and retention.
- **Platforms and integrations:** desktop and mobile apps, push notifications, Outlook's Autodiscover, bulk account import, Eigen as an identity provider, and webhooks into Chat.

## Security

| # | Requirement | Eigen | What is there, what is missing | Plan |
|---|---|---|---|---|
| 1 | 2FA with an authenticator app | Yes | better-auth's `twoFactor` plugin, set up in Space under Security, with backup codes, a code by mail and "Trust this device" | |
| 2 | Hardware security keys | No | No passkey or WebAuthn plugin | None |
| 3 | An equivalent of Advanced Protection for high-risk accounts | No | No stricter mode per account | None |
| 4 | Encryption in transit | Yes | Caddy serves HTTPS with Let's Encrypt. Mail submission and IMAP require TLS; server-to-server mail on port 25 uses TLS when the other side offers it | |
| 5 | Encryption at rest | No | Eigen encrypts nothing it stores: files are plain on disk, S3 gets no server-side encryption setting, and backup archives are not encrypted. Disk or bucket encryption is left to the operator | None |
| 6 | End-to-end encryption | No | None in mail, files or chat; no S/MIME or PGP | None |
| 7 | SPF, DKIM and DMARC for the mail domains | Yes | Outgoing mail is DKIM-signed by OpenDKIM, and the help center lists the SPF, DKIM and DMARC records. Mail that arrives gets no SPF or DMARC check | [PROPOSAL_RSPAMD.md](proposals/PROPOSAL_RSPAMD.md) adds the checks on arrival |
| 8 | A process for account recovery | Partly | Backup codes for 2FA, and an admin or `./eigen reset-password` can set a new password. There is no "forgot password" mail a user can request themselves | None |
| 9 | Spam filtering of incoming mail | No | Postfix rejects unknown sender domains and the like, but scores nothing. Report spam moves a message to Junk and teaches nothing | [PROPOSAL_RSPAMD.md](proposals/PROPOSAL_RSPAMD.md) |
| 10 | Malware scanning of mail and stored files | No | No ClamAV or similar | None |
| 11 | Backups in more than one physically separate place | Operator | One server backup per day, with retention, which can go to an S3 bucket of its own ([BACKUP.md](BACKUP.md)). Where that bucket lives is up to the operator | |
| 12 | Failover to another location when a data center fails | Operator | No replication or failover. A server archive can be restored onto another machine by hand | None |
| 13 | Regular (security) updates | Yes | Frequent releases, installed with `./eigen update`, which backs up first, and undone with `./eigen rollback`. The operator runs it; nothing updates itself | |

## Admin

| # | Requirement | Eigen | What is there, what is missing | Plan |
|---|---|---|---|---|
| 14 | A central admin console | Yes | The Admin app: users, guests, teams, server settings, waitlist and backups | |
| 15 | Create and delete users | Yes | | |
| 16 | (Temporarily) deactivate users | No | better-auth's ban routes are turned off on purpose ([ORGANISATIONS-AND-TEAMS.md](ORGANISATIONS-AND-TEAMS.md)). The only way to lock someone out is a new password or deleting the account | None |
| 17 | Groups to share files and folders with | Yes | Teams, which a file or folder can be shared with | |
| 18 | Distribution lists | No | A team has no mail address | [PROPOSAL_TEAM_ADDRESSES.md](proposals/PROPOSAL_TEAM_ADDRESSES.md), phase 1 |
| 19 | Shared mailboxes | No | One mailbox per user, and a user can send only as themselves | [PROPOSAL_TEAM_ADDRESSES.md](proposals/PROPOSAL_TEAM_ADDRESSES.md), phase 2, as a copy per member rather than one shared mailbox |
| 20 | Mail aliases for users | No | One address per user, no aliases and no send-as (`docker/postfix/sender_login.regexp`) | None |
| 21 | Set other users' rights centrally | Partly | An admin sets a member's role (admin or member) and their teams, which decide team-drive access. Nothing finer | None |
| 22 | Manage users in bulk | No | No multi-select, import or bulk edit | None |
| 23 | Add more than one domain | No | One mail domain, fixed at setup (`MAIL_DOMAIN`) | None |
| 24 | Storage use per user | Yes | A disk column in the users table and usage bars per user | |
| 25 | A storage quota per user | Partly | A server-wide default and per-team overrides ([QUOTA.md](QUOTA.md)); no quota per user | None |
| 26 | Manage access to shared team folders centrally | Yes | Admins add team drives and team members | |
| 27 | End a user's sessions remotely | Partly | A new password or a deleted account ends every session and app password. The Admin app has no button for it alone | ROADMAP.md "A password reset leaves an open IMAP session up" |
| 28 | Help a user back in who lost their sign-in | Partly | An admin can set a new password, but 2FA stays on, and nothing removes 2FA for a user who lost both authenticator and backup codes | None |
| 29 | Audit or admin logs | No | Nothing records admin actions | None |
| 30 | Suspicious or failed sign-ins | No | Rate limits and the optional fail2ban block attempts, but an admin sees only "Last active" | None |
| 31 | Accounts with weak security, such as no 2FA | No | The Admin app shows no 2FA status | None |
| 32 | Alerts on possible incidents or compromised accounts | No | The owner is alerted only about backups and the mail queue | None |
| 33 | Require 2FA for everyone or for some groups | No | No setting | None |
| 34 | Require hardware keys for some users | No | Hardware keys are not supported (row 2) | None |
| 35 | A central password policy | No | Only a fixed minimum of 8 characters | None |
| 36 | Password expiry | No | | None |
| 37 | Force a user to change their password | No | An admin can only set a new password for them | None |
| 38 | An org-wide view of sent and received mail with delivery status | No | Only the Postfix logs (`./eigen logs postfix`) and the queue monitor | None |
| 39 | Keep a leaver's mail, calendars and files and hand them to someone | Partly | An admin can download a leaver's home as an archive before deleting them. Nothing hands that data to another user, and deleting a user deletes their home | None |

## Supplier

Eigen is open-source software, MIT licensed, that an organisation hosts itself or has a hosting partner run. Most of these rows ask about a supplier, and the Eigen project is not one: there is no hosted offering, no paid support and no contract. The first commit is from 7 March 2025, the latest release is 0.4.3, and nearly every commit is by one maintainer, who builds it in their spare time. A hosting partner could take on the SLA, support, DPA and certification rows; the project rows 40 to 42 stay as they are.

| # | Requirement | Eigen | What is there, what is missing | Plan |
|---|---|---|---|---|
| 40 | Continuity doesn't depend on individual people | No | One maintainer. The MIT license lets anyone fork and carry on | None |
| 41 | Offered for at least 5 years | No | About 20 months, and before 1.0 | |
| 42 | At least one customer with 80 or more users | No | No reference customer. The only instance the project runs is the demo, which resets every hour | |
| 43 | An SLA | No | The software comes with no warranty | |
| 44 | At least 99.9% availability in the SLA | No | Depends on whoever runs it | |
| 45 | ISO 27001 or an equal certification | No | `SECURITY.md` gives a private channel for reporting vulnerabilities, nothing more | |
| 46 | Support by mail or tickets | No | GitHub issues and the maintainer's address, best effort | |
| 47 | Support during Dutch office hours | No | | |
| 48 | A set response time for critical incidents | No | `SECURITY.md` aims to reply to a vulnerability report within a week | |
| 49 | Help with onboarding and migration | Partly | No service, but help-center guides for self-hosting and for moving an Eigen server | |
| 50 | A public status page | No | An admin can link the landing page to a status page of their own, and `./eigen status` shows the server's state | |
| 51 | Customers told about major incidents | No | The changelog, release notes and GitHub security advisories | |
| 52 | Price per user known in advance | Yes | Free: the license costs nothing | |
| 53 | Extra costs such as storage or onboarding known in advance | Yes | The project charges nothing. Servers, storage and a mail relay cost what the host charges | |
| 54 | Monthly or yearly notice, no multi-year contract | Yes | There is no contract | |
| 55 | Export in common formats so moving away is possible | Partly | Documents export to docx, xlsx, pptx, PDF and HTML, calendars to .ics, contacts to .vcf, mail to .eml and over IMAP, files over WebDAV, and the stored formats are open. Stickies boards and chat rooms have no export, and Drive has no folder download | [PROPOSAL_PORTABLE_DOCUMENTS.md](proposals/PROPOSAL_PORTABLE_DOCUMENTS.md) |
| 56 | A data processing agreement | n/a | An organisation that hosts Eigen itself is its own processor; a hosting partner would sign one | |
| 57 | An up-to-date list of subprocessors | n/a | The software sends nothing anywhere of its own accord: no telemetry. S3 and a mail relay are the operator's choice | |
| 58 | A set process for reporting data breaches and incidents | Partly | `SECURITY.md` covers reporting a vulnerability, not telling customers of a breach | |

## Webmail

| # | Requirement | Eigen | What is there, what is missing | Plan |
|---|---|---|---|---|
| 59 | Send and receive with an alias on your account | No | One address per user | [PROPOSAL_TEAM_ADDRESSES.md](proposals/PROPOSAL_TEAM_ADDRESSES.md) gives team addresses, not personal aliases |
| 60 | Send to and receive through a distribution list | No | Only `postmaster@` reaches the admins | [PROPOSAL_TEAM_ADDRESSES.md](proposals/PROPOSAL_TEAM_ADDRESSES.md), phase 1 |
| 61 | Open a shared mailbox and read and send from it | No | Mail is one personal mailbox per user; a team has none | [PROPOSAL_TEAM_ADDRESSES.md](proposals/PROPOSAL_TEAM_ADDRESSES.md), as a copy per member |
| 62 | Forward mail automatically | No | Forward is a button only | None |
| 63 | Rules to tag or forward mail | No | No Sieve and no rules | [PROPOSAL_STALWART_MAIL.md](proposals/PROPOSAL_STALWART_MAIL.md) lists Sieve as deferred |
| 64 | Folders and/or labels | Partly | Folders show and take messages by move or drag, but a new folder can be made only in an IMAP client. No labels | None |
| 65 | An automatic away reply | No | | None |
| 66 | A mail signature | Yes | Set in Space under Mail | |
| 67 | Conversation view | No | The list is flat, one row per message | None |
| 68 | Full-text search of the mailbox | Yes | SQLite full-text search, from the folder's search box and ⌘K | |
| 69 | Filter search results by sender and recipient | Yes | `from:` and `to:` | |
| 70 | Filter search results by date and attachments | No | The index stores both, but search takes neither | None |
| 71 | Add attachments | Yes | From the device, from Drive or by paste | |
| 72 | Preview received attachments | Yes | Images, PDF, video, audio, text, .vcf, .eml and .ics | |
| 73 | Download received attachments | Yes | Download, Save to Drive and Save all | |
| 74 | See and use a sender's or recipient's contact details from the mail | Partly | Addresses open a new mail and the composer suggests contacts. No contact card and no "add to contacts" | None |
| 75 | View and accept or decline an invitation from the mail | Partly | The mail shows the invitation with "View in Calendar"; accepting happens in Calendar | None |
| 76 | Drag attachments into the mail | Yes | | |
| 77 | Stop senders seeing through images and tracking pixels whether a mail was opened | Yes | Remote images wait until the reader clicks Load images ([MAIL.md](MAIL.md)) | |

## Calendar

| # | Requirement | Eigen | What is there, what is missing | Plan |
|---|---|---|---|---|
| 78 | Several calendars | Yes | | |
| 79 | Share a calendar with colleagues | Yes | With people or a team | |
| 80 | Calendars shared with the whole organisation | Yes | An admin turns on a team calendar, and the default team holds every user | |
| 81 | Share a calendar with outside people | No | Shares reach only Eigen users; guests have no calendar, and there is no public feed | None |
| 82 | Subscribe to outside calendars by iCal link | No | Only a one-off .ics import | [PROPOSAL_CALENDAR_IMPORT.md](proposals/PROPOSAL_CALENDAR_IMPORT.md); ROADMAP.md "Calendar subscriptions" |
| 83 | Who may view or edit, per calendar | Yes | Free/busy, read or write, per person or team | |
| 84 | Working hours and work location | No | | None |
| 85 | See colleagues' availability when planning | Partly | Only when a colleague has shared their calendar with you, at least as free/busy. The guest picker shows no availability | None |
| 86 | Visibility per event | No | No private events and no free/busy flag per event | None |
| 87 | Repeating events: daily, weekly, monthly, every other week | Partly | Daily, weekly, monthly, yearly and weekdays. "Every other week" can't be made in the web app | None |
| 88 | Accept or decline invitations in the calendar | Yes | Accept, Maybe or Decline, for one date or the series | |
| 89 | Reminders | Partly | The API and CalDAV keep reminders, so a phone's calendar shows them, but the web form has no reminder field | None |
| 90 | A video meeting link on an event | No | A link can be typed into Location or Description, and shows as text, not as a link | None |
| 91 | Pick a meeting room | No | Location is free text; no rooms or resources | None |
| 92 | Search events by address and title | No | Calendars are not searchable | ROADMAP.md "Search: calendar events" |
| 93 | Choose the date and time format and the first day of the week | No | Fixed: a 12-hour clock and weeks starting on Monday | ROADMAP.md "Event times use a 12-hour clock", for the clock only |
| 94 | A booking page where others pick a time | No | | None |

## Contacts and tasks

| # | Requirement | Eigen | What is there, what is missing | Plan |
|---|---|---|---|---|
| 95 | Find and use colleagues' contact details | Yes | Contacts lists each team's members, and the default team holds everyone | |
| 96 | Personal contacts | Yes | With import, export and CardDAV | |
| 97 | Contact groups and lists | Yes | Coloured labels act as groups; a selection can be mailed or messaged at once | |
| 98 | Personal tasks, for example tied to the calendar | Partly | Stickies cards can be assigned and resolved. They have no due date and no tie to the calendar, and CalDAV carries no tasks | None |

## Documents

| # | Requirement | Eigen | What is there, what is missing | Plan |
|---|---|---|---|---|
| 99 | Store documents centrally | Yes | Drive, on local disk or S3 ([STORAGE.md](STORAGE.md)) | |
| 100 | Folders | Yes | | |
| 101 | Share with colleagues | Yes | | |
| 102 | Share with outside people | Yes | An outside address becomes a guest, who signs in with a code by mail ([GUEST-ACCESS.md](GUEST-ACCESS.md)) | |
| 103 | Share with groups | Yes | With a team | |
| 104 | Rights per document: view, comment, edit | Partly | View and edit only. Commenting needs write access, so nobody can comment without being able to edit | None |
| 105 | Rights per folder: view, comment, edit | Partly | Folder rights pass to everything inside, with the same two levels | None |
| 106 | Share through a public link | No | "Anyone with the link" still needs an Eigen account | [PROPOSAL_PUBLIC_LINKS.md](proposals/PROPOSAL_PUBLIC_LINKS.md), with no roadmap row |
| 107 | Download documents | Yes | Uploaded files as they are; Eigen documents as docx, xlsx, pptx, PDF or HTML | |
| 108 | Team folders the organisation owns | Yes | Team drives, owned by the team | |
| 109 | Edit together at the same time | Yes | Docs, sheets, slides, boards and drawings, with live cursors ([COLLAB.md](COLLAB.md)) | |
| 110 | View earlier versions | Partly | Version history lists versions by time, and picking one asks to restore it. An old version can't be looked at first, and uploaded files have no versions | ROADMAP.md "File History: email digests + version-history unification" |
| 111 | Restore earlier versions | Yes | A restore saves the current state as a version first | |
| 112 | See who made which change | Partly | The Activity panel shows who edited and when. Nothing shows who wrote which text, and versions can't be compared | [DOCS-TODO.md](DOCS-TODO.md) "Suggesting mode (track changes)" |
| 113 | Transfer ownership of documents | No | A move never leaves its drive; a copy to another drive is a new file with new sharing | None |
| 114 | Transfer ownership of folders | No | Same as row 113 | None |
| 115 | A trash for deleted documents | Yes | Kept 30 days by default ([SOFT-DELETE.md](SOFT-DELETE.md)) | |
| 116 | Find documents by name | Yes | | |
| 117 | Find documents by the text inside | Partly | ⌘K searches the text of your own drives and your teams' drives, up to about 100 KB per file. Files others shared with you are not searched ([SEARCH.md](SEARCH.md)) | None |
| 118 | Recently opened or edited documents | Yes | Recent files in Drive | |
| 119 | Store and share files of at least 1 GB | Partly | The default upload limit is 35 MB; an admin can raise it to 1023 MiB, a hair over 1 GB. An upload can't resume after a break | None |
| 120 | Preview PDF files | Yes | | |

## Word processing

| # | Requirement | Eigen | What is there, what is missing | Plan |
|---|---|---|---|---|
| 121 | Create and edit text documents | Yes | The Docs app ([DOCS.md](DOCS.md)) | |
| 122 | Import, edit and export .odt | No | Only docx, PDF and HTML | None |
| 123 | Import, edit and export .docx | Yes | Comments are not carried either way | [DOCS-TODO.md](DOCS-TODO.md) "Docx: comments in export and import" |
| 124 | Export to PDF | Yes | Through WeasyPrint, from the same HTML as the editor ([EXPORT.md](EXPORT.md)) | |
| 125 | Font, size, colour, alignment, lists, headings, tables | Yes | Four fonts to choose from | |
| 126 | Comments | Yes | Needs write access | |
| 127 | Mention people in comments to notify them | Yes | An in-app notification. No mail is sent, so someone who isn't signed in hears nothing | ROADMAP.md "Comments: a mention sends no mail" |
| 128 | Suggest changes for another user to accept or reject | No | A docx import accepts tracked changes outright | [DOCS-TODO.md](DOCS-TODO.md) "Suggesting mode (track changes)", size XL |
| 129 | Word count | Yes | No page count | [DOCS-TODO.md](DOCS-TODO.md) "A page count in Word count" |
| 130 | Find and replace | Yes | | |

## Spreadsheets

| # | Requirement | Eigen | What is there, what is missing | Plan |
|---|---|---|---|---|
| 131 | Create and edit spreadsheets | Yes | [SHEETS.md](SHEETS.md) | |
| 132 | Import, edit and export .xlsx | Yes | | |
| 133 | Import, edit and export .ods | No | | None |
| 134 | Import, edit and export .csv | No | A .csv previews as text only. Copy and paste carry cells as tab-separated text | None |
| 135 | Export to PDF | Yes | | |
| 136 | Font, colour, borders, alignment, number formats | Yes | | |
| 137 | Formulas and functions | Yes | [FORMULA.md](FORMULA.md) | |
| 138 | Pivot tables | No | | None |
| 139 | Charts | Yes | Column, bar, line and pie | ROADMAP-POST-1.md "Charts: more types, mark-bound arrows and linked data" |
| 140 | Conditional formatting | Yes | | |
| 141 | Data validation, such as dropdowns | Yes | Dropdowns and tick boxes | |
| 142 | Filter and sort | Yes | | |
| 143 | Freeze rows and columns | Yes | | |
| 144 | Several sheets in one spreadsheet | Yes | On a phone the tab strip is hidden | ROADMAP.md "Mobile: next round" |
| 145 | Protect cells and ranges against editing | No | Editing is on or off for the whole workbook, by role | None |
| 146 | Comments | Yes | | |

## Presentations

| # | Requirement | Eigen | What is there, what is missing | Plan |
|---|---|---|---|---|
| 147 | Create and edit presentations | Yes | [SLIDES.md](SLIDES.md) | |
| 148 | Import, edit and export .pptx | Yes | A pptx table comes in as a placeholder box, and speaker notes are dropped | |
| 149 | Import, edit and export .odp | No | | None |
| 150 | Export to PDF | Yes | | |
| 151 | Text, images, shapes, tables and charts on slides | Partly | All but tables: slides have no table element | None |
| 152 | Slide layouts | No | A new slide is blank; a pptx import flattens its layouts onto each slide | None |
| 153 | Speaker notes | No | | None |
| 154 | Present mode | Yes | Full screen, with click, keyboard and clicker | |
| 155 | Comments | Yes | | |
| 156 | A presenter view on a second screen | No | Present mode is one full-screen view | None |
| 157 | Import and reuse slides from other presentations | Partly | Import inserts the slides of a .pptx; slides can't be copied between Eigen decks | None |

## Video meetings

Eigen has no video meetings and no code toward them: no WebRTC, no screen sharing, and no tie to Jitsi, BigBlueButton or similar. A calendar event can't even carry a meeting link as a link (row 90). No proposal or roadmap row covers any of these 18 rows.

| # | Requirement | Eigen |
|---|---|---|
| 158 | Start video meetings | No |
| 159 | Plan video meetings ahead | No |
| 160 | Invite outside people by link | No |
| 161 | Outside people join without an account | No |
| 162 | Share the whole screen | No |
| 163 | Share one window or tab | No |
| 164 | Turn camera and microphone on and off | No |
| 165 | Blur or replace the background | No |
| 166 | Chat during a meeting | No |
| 167 | Reactions and raising a hand | No |
| 168 | Hosts mute or remove people | No |
| 169 | Hosts decide who is let in | No |
| 170 | Record meetings | No |
| 171 | Live transcription | No |
| 172 | Meetings with at least 80 people | No |
| 173 | Check camera, microphone and audio before joining | No |
| 174 | Join the meeting straight from the calendar event | No |
| 175 | Share files or links in a meeting | No |

## Chat

| # | Requirement | Eigen | What is there, what is missing | Plan |
|---|---|---|---|---|
| 176 | One-on-one chats | Yes | | |
| 177 | Group chats | Yes | | |
| 178 | Lasting rooms | Yes | A room is a file in Drive; team rooms act as channels ([CHAT.md](CHAT.md)) | |
| 179 | Rooms open to the whole organisation or invite-only | Yes | Share sets a room to Restricted or Unrestricted. There is no list of open rooms to browse | |
| 180 | Invite outside people to chats and rooms | Yes | As guests | |
| 181 | Reply in threads | No | The database has a `replyTo` column and the API takes it, but no interface sets or shows it | None |
| 182 | @mentions | Yes | | |
| 183 | Share files in chats and rooms | Yes | | |
| 184 | View images in the chat | Yes | As a thumbnail that opens in a preview | |
| 185 | Edit and delete your own messages | Yes | | |
| 186 | Pin messages | No | | None |
| 187 | Search messages and chat history | Partly | Rooms are found through Drive search, over about the newest 100 KB. No search inside a chat | ROADMAP.md "Search: full chat history" |
| 188 | Find the files of one chat or room | No | They sit inside the room, which Drive doesn't open, and the chat has no files panel | None |
| 189 | Notifications per chat or room | Partly | Watch adds file events; message and mention notifications can't be turned off per room | None |
| 190 | Mute a chat without leaving | No | | None |
| 191 | Set your availability and see colleagues' | No | The only presence is the live cursors in the editors | None |
| 192 | Formatting: bold, lists, links | Partly | Links only | None |
| 193 | Share code with its formatting | No | Whitespace is kept; no code blocks | None |
| 194 | See which messages and @mentions are unread | Partly | A dot per room in the sidebar. No count, no line in the room, no separate mention marker | None |
| 195 | Emoji reactions | No | The built-in emotes such as `/wave` are messages, not reactions | None |
| 196 | Start an audio or video call from a chat | No | | None |
| 197 | Custom emoji | No | | None |
| 198 | Admins manage users and their access to rooms | Partly | Admins manage teams, which decide who is in team rooms; personal rooms are out of their reach | None |
| 199 | Admins set retention for chat messages | No | | None |

## AI

| # | Requirement | Eigen | What is there, what is missing | Plan |
|---|---|---|---|---|
| 200 | A built-in AI assistant | No | No AI code | [PROPOSAL_AI.md](proposals/PROPOSAL_AI.md), shelved |
| 201 | AI to write, rewrite, summarise and analyse | No | | [PROPOSAL_AI.md](proposals/PROPOSAL_AI.md) phase 1, in the browser; [PROPOSAL_SCRIPTING_PLATFORM.md](proposals/PROPOSAL_SCRIPTING_PLATFORM.md) phase 5, for an assistant the user brings |
| 202 | Ask AI about your own files and data | No | | [PROPOSAL_SCRIPTING_PLATFORM.md](proposals/PROPOSAL_SCRIPTING_PLATFORM.md) phase 5 lets an outside assistant read a user's data over MCP, with that user's rights; [PROPOSAL_AI.md](proposals/PROPOSAL_AI.md) phase 2 |
| 203 | Admins turn AI on and off centrally | No | | [PROPOSAL_SCRIPTING_PLATFORM.md](proposals/PROPOSAL_SCRIPTING_PLATFORM.md)'s operator switch covers MCP |

## Platforms

| # | Requirement | Eigen | What is there, what is missing | Plan |
|---|---|---|---|---|
| 204 | Works in current Edge, Chrome, Firefox and Safari | Partly | A web app, with fixes for Safari and Firefox quirks ([MOBILE.md](MOBILE.md)), but no stated browser list and no cross-browser test; browser checks run in Chrome | None |
| 205 | A Windows desktop app | No | Only a web-app manifest, with no service worker | None |
| 206 | A macOS desktop app | No | | None |
| 207 | A Linux desktop app | No | | None |
| 208 | An iOS app | No | The web app works on phones, and the phone's own mail, calendar and contacts apps connect over IMAP, CalDAV and CardDAV | ROADMAP.md "Mobile: next round", web only |
| 209 | An Android app | No | Same as row 208; the help center points to DAVx5 | ROADMAP.md "Mobile: next round", web only |
| 210 | Notifications on desktop and phone | Partly | The bell and toasts while a tab is open, and notifications by mail. No push and no system notifications | None |
| 211 | Mail over IMAP and SMTP | Yes | When Eigen hosts the mail ([IMAP.md](IMAP.md)), with app passwords | |
| 212 | Calendar over CalDAV | Yes | [CALDAV.md](CALDAV.md) | |
| 213 | Contacts over CardDAV | Yes | [CARDDAV.md](CARDDAV.md) | |
| 214 | Mail in Outlook, Apple Mail and Thunderbird | Yes | Standard IMAP and SMTP. The help center covers Thunderbird and Apple Mail; Outlook is untested | |
| 215 | Calendar in Outlook, Apple Calendar and Thunderbird | Partly | Apple Calendar and Thunderbird. Outlook has no CalDAV, so only .ics files work there | None |
| 216 | Contacts in Outlook, Apple Contacts and Thunderbird | Partly | Apple Contacts and DAVx5 are documented; Thunderbird works without a guide. Outlook has no CardDAV, so only .vcf files | None |
| 217 | Automatic mail setup through Autoconfig | Partly | Caddy serves the Autoconfig file on the web domain only, so it fails when the mail domain differs | None |
| 218 | Automatic setup in Outlook through Autodiscover | No | | None |

## Migration

| # | Requirement | Eigen | What is there, what is missing | Plan |
|---|---|---|---|---|
| 219 | Migrate user accounts in bulk | No | Admins add members one at a time. Only a restore of a whole Eigen server moves every account | [PROPOSAL_SSO.md](proposals/PROPOSAL_SSO.md) makes accounts on first sign-in |
| 220 | Migrate mail with its folders or labels | Partly | The web app imports single .eml files. Folders move over IMAP with a client or `imapsync`, with no guide | [PROPOSAL_EXTERNAL_MAIL_PROVIDER.md](proposals/PROPOSAL_EXTERNAL_MAIL_PROVIDER.md) names a one-shot IMAP import as separate work |
| 221 | Migrate calendars and contacts | Yes | .ics and .vcf import per user, and CalDAV and CardDAV. No bulk tool | |
| 222 | Migrate files and folder trees | Partly | No Google Drive import and no folder upload in the browser; folder trees copy over WebDAV or rclone ([WEBDAV.md](WEBDAV.md)). Office files convert one at a time | None |
| 223 | Move shared folders and their rights | No | | None |

## Integrations

| # | Requirement | Eigen | What is there, what is missing | Plan |
|---|---|---|---|---|
| 224 | Eigen as identity provider for SSO into other services | No | | None: [PROPOSAL_SSO.md](proposals/PROPOSAL_SSO.md) makes Eigen a client of another provider and lists this as a non-goal |
| 225 | See which outside services users reach through SSO | No | | None |
| 226 | An API to create, read, change, move and delete files and folders | Yes | Over WebDAV with app passwords, under the user's rights. The REST API needs a browser session and has no documentation | [PROPOSAL_SCRIPTING_PLATFORM.md](proposals/PROPOSAL_SCRIPTING_PLATFORM.md) adds an SDK and tokens |
| 227 | An API to manage access rights | No | WebDAV can't change sharing, and the sharing routes need a browser session | [PROPOSAL_SCRIPTING_PLATFORM.md](proposals/PROPOSAL_SCRIPTING_PLATFORM.md) |
| 228 | Post messages to rooms by API or webhook | No | | None: the scripting SDK leaves out Chat |

## See also

- [ROADMAP.md](ROADMAP.md) and [ROADMAP-POST-1.md](ROADMAP-POST-1.md): the backlog the plan column points into
- [ARCHITECTURE.md](ARCHITECTURE.md): where each part lives in the code
