# Security Audit (2026-09-06)

> **TLDR**: Full read-pass of the API, the frontends, the document transforms and the Docker deployment, eight domains in parallel, every finding re-verified against source. Three High findings: the better-auth sign-up endpoint is open to the internet, comment-card and stickies descriptions are rendered as raw HTML from the shared Y.Doc, and the sheet paste path parses OS clipboard HTML on a live element. Seven Mediums, mostly defence-in-depth gaps around one already-correct primitive, nine Lows and one Info. No Critical. The ACL model, path handling, cross-home relay, protocol auth, WeasyPrint sandboxing and MTA config all held up. Overall grade: B+. Fix the three Highs and the two cheapest Mediums (editor save guard, sheets preview sanitizer) and it is an A-.

Scope follows [SECURITY.md](../SECURITY.md): `apps/api`, every `apps/*` frontend, `packages/*`, and the default Docker deployment. Out of scope: misconfiguration by the operator, upstream dependency bugs with no reachable sink, single-user self-DoS.

Method: eight domain reviewers read their scope in full (auth and identity, drive and storage, mail, calendar and DAV, collab and realtime, document transforms, frontend sinks, deployment and supply chain). Each reported only findings traced route to sink, plus a "checked and guarded" list. The orchestrating session then re-read every High and the actionable Mediums in source before writing this file. Nothing was executed against a running instance; the librsvg and ffmpeg items below are the only ones whose exploitability depends on a binary version rather than on the code.

Severity is realistic impact on a self-hosted multi-user instance: **High** = account or data compromise of another user with little or no interaction; **Medium** = integrity or privacy loss that needs a precondition, or a missing second layer under a sanitizer that is currently correct; **Low** = hardening; **Info** = verified not exploitable on the shipped build, noted for the next dependency bump.

## Findings

| # | Sev | Finding | Where |
|---|-----|---------|-------|
| 1 | High | Open self-registration through the better-auth sign-up route | `apps/api/src/lib/auth/auth.ts:131` |
| 2 | High | Stored XSS: comment-card and stickies `description` rendered unsanitized from the Y.Doc | `packages/ui/src/components/notes/note-card.tsx:87`, `note-card-dialog.tsx:139` |
| 3 | High | XSS: sheet paste assigns OS clipboard HTML to a live element | `packages/sheet/src/state/events/paste.ts:1135`, `components/Workbook/index.tsx:709` |
| 4 | Medium | Inbound iMIP trusts the spoofable `From:` header | `apps/api/src/lib/calendar/imip.ts:196`, `docker/postfix/main.cf.template:34` |
| 5 | Medium | Editor save route can overwrite a container's `data.db` | `apps/api/src/routes/editor.ts:22`, `lib/drive/inline-edit.ts:49` |
| 6 | Medium | Sheets preview body skips the data-only URL restriction | `apps/api/src/lib/preview/eigensheets-render.ts:19` |
| 7 | Medium | Awareness updates are unbounded and unauthenticated per client id | `apps/api/src/lib/collab/collabDocument.ts:378` |
| 8 | Medium | No Content-Security-Policy on any deployment shape | `Caddyfile:19`, `docker/static/Caddyfile`, `apps/api/src/app.ts` |
| 9 | Medium | DOMPurify 3.3.3 carries 14 open advisories | `bun.lock` (`isomorphic-dompurify@3.6.0`) |
| 10 | Medium | HTML mail renders in a shadow root, not a sandboxed iframe | `packages/ui/src/components/shadow-content.tsx:113`, `apps/api/src/lib/mail/mail-parse.ts:23` |
| 11 | Low | HTML mail auto-loads remote images and CSS `url()` | `apps/api/src/lib/mail/mail-parse.ts:23` |
| 12 | Low | Presence identity in awareness is client-controlled | `apps/api/src/lib/collab/collabDocument.ts:378` |
| 13 | Low | REST create/copy accept a document container as parent | `apps/api/src/lib/drive/drive.ts:250`, `:266`, `:451` |
| 14 | Low | WebDAV GET omits `nosniff` and the sandbox CSP | `apps/api/src/lib/webdav/resource.ts:50` |
| 15 | Low | `request-access` message unbounded, no non-guest gate | `apps/api/src/routes/drive.ts:593` |
| 16 | Info | Uploaded SVGs rasterised through librsvg for thumbnails and avatars (external refs verified blocked) | `apps/api/src/lib/shared/thumbnails.ts:27`, `contacts/avatars.ts:49` |
| 17 | Low | ffmpeg/ffprobe run without `-protocol_whitelist` | `apps/api/src/lib/shared/video-thumbnail.ts:48`, `:80` |
| 18 | Low | `static` deployment shape ships zero security headers | `docker/static/Caddyfile`, `scripts/setup.ts` proxy snippets |
| 19 | Low | Postfix `mynetworks` and OpenDKIM `InternalHosts` cover all of `172.16/12` | `docker/postfix/main.cf.template:14`, `entrypoint.sh:68` |
| 20 | Low | Floating image tags, `build.log` tracked, CI token not scoped | `docker-compose.yml`, `docker/api/Dockerfile:1`, `.github/workflows/check.yml` |

### 1. [High] Open self-registration

`emailAndPassword: { enabled: true }` with no `disableSignUp`, so better-auth mounts `POST /auth/sign-up/email` and the app adds no gate in front of it (the only `onBeforeHandle` on the mounted handler is the demo-mode block list in `routes/auth.ts`). Caddy only 404s `/eigen/internal/*` and `/eigen/mail/deliver/*`. There is no email verification, and `autoSignIn` is on, so the response carries a session cookie. The `user.create.after` hook then joins the account to the default org as a member and reconciles shares.

Scenario: anyone on the internet posts `{name, email, password}` with any address, gets a session, a home, a mailbox, org member-directory access and storage quota. This defeats the invite and waitlist model, which is the only path the frontend offers (no sign-up UI exists; `useInviteRegister` goes through `auth.api.createUser`). Role cannot be mass-assigned (better-auth drops non-input fields), which keeps this High rather than Critical. Whether a self-registered account can relay outbound mail depends on whether its address is on the instance domain; a foreign domain fails the sender-login map, an instance-domain address would not. The 2026-08-31 spam incident is the precedent for what a free mailbox costs.

Fix: `emailAndPassword.disableSignUp: true`. Setup, invites and the admin page already create users via `auth.api.createUser`; the API tests call `auth.api.signUpEmail` server-side, which bypasses the HTTP gate and keeps working. Note `docs/VERIFICATION.md` documents "dev signup is open" as a convenience; keep that by gating on `isProduction()` if wanted.

### 2. [High] Stored XSS via comment-card and stickies descriptions

`useCommentCards` reads `description` off the card's Y.Map with only a `typeof === 'string'` guard (`packages/lib/src/core/comments/hooks/use-comment-cards.ts:20`), and both `NoteCard` and `NoteCardDialog` inject it with `dangerouslySetInnerHTML`. The value is normally produced by the LightEditor, but the Y.Doc is written by peers: any collaborator with write access to a document's comments or to a stickies board can `card.set('description', '<img src=x onerror=...>')` from a modified client. It executes on the app origin in every session that opens the board or the card, no interaction beyond viewing.

The canvas engine already treats exactly this seam as hostile: `element-layer.tsx:110` runs `sanitizeToLightEditorHtml` on stored `html` "because it reaches us verbatim from a hostile peer's Y.Doc write". Comment cards have no equivalent.

Fix: call `sanitizeToLightEditorHtml(description)` at the two render sites (or once in `useCommentCards`). Same allowlist, so legitimate LightEditor markup is unchanged.

### 3. [High] XSS via spreadsheet HTML paste

Both paste paths in the sheet fork take the raw `text/html` clipboard flavour and do `const ele = document.createElement('div'); ele.innerHTML = txtdata;` whenever the payload contains the string `table`. An element created in the live document loads images and fires their `onerror` handlers even while detached. A web page the victim copies from can set a crafted `text/html` clipboard entry; the paste looks like a normal table and runs script on the Eigen origin. The rest of the repo avoids exactly this with `DOMParser` (`packages/lib/src/core/html-dom.ts:5` documents the hazard); the fork never got the pattern.

Fix: `new DOMParser().parseFromString(txtdata, 'text/html')` and walk that inert document in both places. While there, audit the fork's other live-element `innerHTML` writes (`mouse-cell.ts`, `mouse-header.ts`, `inline-string.ts`); they operate on already-escaped content today but each is a latent sink.

### 4. [Medium] Inbound iMIP trusts the `From:` header

Found independently by the calendar and the mail reviewers. `processInboundImip` binds every mutation to `mail.from.value[0].address`, which is the header `From:`, not the SMTP envelope, and the module comment calls it the envelope sender. The bundled Postfix signs with OpenDKIM but verifies nothing on port 25: `milter_default_action = accept`, no opendmarc, no SPF check. So an unauthenticated internet sender can spoof `From: alice@partner.com` with a `text/calendar` part. If the ICS organizer matches, `METHOD:REQUEST` injects an event into Bob's calendar with no acceptance step, and `METHOD:CANCEL` with a known UID (invites are often sent to many people) silently deletes Bob's real meeting. REPLY is better guarded (attendee membership check).

Fix: only act on iMIP when the message carries an aligned DKIM or SPF pass (an `Authentication-Results` header from a verifying milter, or reject at the MTA), or land external changes as "unverified, confirm" rather than applying them. Correct the comment either way.

### 5. [Medium] Editor save route can overwrite container internals

`GET /editor/.../content` refuses anything `getTextPreviewMode` does not consider editable, but `PUT` goes through `prepareSaveContent`, which checks only `type === FILE` and size. A write collaborator on a shared eigendoc lists the container folder (readers can, the internal `data.db` and `comments.db` rows are returned), takes the `data.db` path id, and `PUT`s text with `force: true`. The SQLite bytes are replaced and the shared document is corrupted for the owner and everyone else. WebDAV blocks this via `enclosingDocumentContainer`; the REST editor route does not.

Fix: in the PUT, reject when `getTextPreviewMode(path.mimeType, path.name)` is null and when the path is inside a document container (reuse `enclosingDocumentContainer`), mirroring the GET.

### 6. [Medium] Sheets preview skips the data-only URL restriction

Five of the six preview renderers run their body through `sanitizeExportHtml`, whose `restrictToDataRefs` hook exists, per its own comment, because "a preview body is injected as live DOM in the drive hero (a beacon fired at every viewer)". `eigensheets-render.ts` calls plain `DOMPurify.sanitize` instead. The sheet renderer writes cell colours as `background:${escapeHtml(v.bg)}`, and `escapeHtml` does not touch `(`, `)`, `:` or `;`, so a cell background of `red;background-image:url(http://attacker/beacon)` survives into the preview `style` attribute. Every user who opens the drive and sees the hero fires a GET from their browser: a tracking beacon, or an unauthenticated request to an internal host on the viewer's network.

Fix: use `sanitizeExportHtml(html)` here, as `eigendoc-render.ts:56` does.

### 7. [Medium] Unbounded awareness updates

`handleMessage` gates sync sub-types 1 and 2 on `canWrite` but applies `MESSAGE_AWARENESS` frames from any connection that passed the `canRead` check at open, including read-only share holders and guests. There is no cap on how many client ids one connection may declare or how large a state may be, and a single frame may be up to the 128 MB `maxPayloadLength`. Every declared id lands in the awareness map and `connectionClientIds`, is fanned out to every peer, and is replayed to every joiner until that connection closes. A low-privilege user can push the API process toward OOM and flood every co-editor.

Fix: ignore awareness updates that declare more than a handful of client ids per connection, and cap the per-state byte size before `applyAwarenessUpdate`.

### 8. [Medium] No Content-Security-Policy

The edge Caddyfile sets `X-Frame-Options`, `nosniff` and HSTS and nothing else; the API sets no security headers; the `static` bundle and the setup-generated nginx/caddy/apache snippets set none at all. For an app that renders user HTML in mail, docs, comments, chat and previews, the CSP is the second layer that turns a sanitizer bypass (findings 2, 3, 9, 10) from session takeover into a console error.

Fix: emit `Content-Security-Policy`, `Referrer-Policy: strict-origin-when-cross-origin` and a `Permissions-Policy` from the API so every proxy shape inherits them. Start with `default-src 'self'; img-src 'self' data: blob: https:; script-src 'self'` and iterate against the apps; the sheet fork and Tiptap may need `'unsafe-inline'` for styles only.

### 9. [Medium] DOMPurify 3.3.3 with open advisories

`bun audit` lists 14 advisories against the pinned DOMPurify (mostly `IN_PLACE`, `RETURN_DOM`, `CUSTOM_ELEMENT_HANDLING` and hook-pollution cases). Eigen calls string-mode `sanitize` with `FORCE_BODY` and scoped `addHook`/`removeHook` in `export/sanitize.ts`, and none of the listed bypasses target that configuration, so no reachable bypass was found. It is still the one sanitizer between attacker mail bodies, imported docx and exported previews and a victim session, with no CSP behind it. The same audit run flags ReDoS in `linkify-it@5.0.0` and `markdown-it@14.1.1` (mail and chat linkifier) and `@xmldom/xmldom` via `mammoth`. The better-auth OIDC/MCP criticals do not apply (those plugins are not configured).

Fix: `bun update` DOMPurify, linkify-it, markdown-it and mammoth; re-run `bun audit` as part of a release checklist.

### 10. [Medium] HTML mail renders in a shadow root

Mail bodies are sanitized server-side with DOMPurify defaults plus `ADD_ATTR: ['target']` and then injected via `innerHTML` into a closed shadow root. Shadow DOM is a style boundary, not a security boundary: scripts, image loads and form submits run on the app origin. The default profile keeps `<style>`, `style` attributes and `<form>`, so a mail can paint a `position:fixed` full-viewport overlay that imitates the Eigen UI and phish in place, and `target=_blank` links get no `rel=noopener`. Any sanitizer slip (finding 9) is direct same-origin XSS.

Fix: render mail in `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc=...>` with a CSP `<meta>` inside, or at minimum forbid `<style>`, `<form>`, positioned CSS, and add `rel="noopener noreferrer"` on anchors.

### 11 to 20. Low

- **11. Remote content in mail.** DOMPurify keeps `<img src=http://...>` and CSS `url()`, and nothing gates or proxies them, so opening a mail leaks IP, user agent and read time to the sender. Add a "load remote images" opt-in or a server-side image proxy.
- **12. Client-controlled presence identity.** The server applies awareness payloads verbatim and never stamps the `user` field from the session, so any reader can show another person's name and colour, or overwrite another editor's cursor. Overwrite the identity field with the session user before applying.
- **13. Containers accepted as create/copy parent.** `Drive.create`, `createFolder` and `createFileFromData` admit any `isContainerType` parent, including document containers, while `movePath` restricts to `DRIVE_TYPE_FOLDER` and WebDAV blocks writes inside containers. A write collaborator can inject files into a shared doc's internal tree (ignored by the loader, consumes owner quota). Apply the WebDAV guard to the REST create and copy routes.
- **14. WebDAV GET headers.** Returns `Content-Type: path.mimeType` with no `nosniff`, no `Content-Disposition` and no sandbox CSP, unlike the REST `serveFile`. Basic-auth only, so hard to reach via a link; still add `scriptableInlineHeaders`.
- **15. `request-access` route.** `message` has no `maxLength` and the route lacks `requireNonGuest`, so any account can persist arbitrarily large notification rows into an owner's home. Add both, matching the sibling share routes.
- **16. SVG rasterisation (Info).** `isExiftoolCandidate` accepts any `image/*`, so an uploaded `image/svg+xml` reaches `sharp()` for the 512px list thumbnail and for contact avatars; only the screen-res preview path serves SVG as-is. Verified on the bundled sharp (libvips 8.17.3, librsvg 2.61.2): an SVG with `<image href="file:///etc/hosts">` rasterises to a fully transparent image, so external references are ignored and nothing is readable today. Excluding SVG from the two rasterisers is cheap insurance against a future sharp build, not a fix.
- **17. ffmpeg protocols.** Argv-array spawn, so no injection, but no `-protocol_whitelist file,crypto`; a playlist wearing `video/mp4` could dereference `file://` or `http://` on older builds. Add the flag to both `ffprobe` and `ffmpeg`.
- **18. `static` shape headers.** The `static` profile Caddyfile and the generated host-proxy snippets set no `X-Frame-Options` or `nosniff`. Setting headers at the API (finding 8) fixes every shape at once.
- **19. Postfix trust range.** `mynetworks = 127.0.0.0/8 172.16.0.0/12` and OpenDKIM `InternalHosts` cover 16 times the actual bridge (`172.20.0.0/24`). Docker DNAT preserves the real client IP, so this is not an open relay today, but a host running `userland-proxy=true` with SNAT to the gateway would make it one, with valid DKIM. Scope both to `${EIGEN_SUBNET}`.
- **20. Supply-chain hygiene.** `mvance/unbound:latest`, `caddy:2-alpine` and `oven/bun:1-slim` float; `build.log` is tracked (no secrets, but shows layout and `.env.production` being read); the check workflow has no `permissions:` block and pins actions by tag. Pin by digest, `git rm --cached build.log`, add `permissions: contents: read`.

## Checked and guarded

Reported so the next audit knows what was covered, not to pad the file.

- **Authorization.** Every `:ownerId` route uses `requireSelf`, `requireTeamAccess`, `requireAdmin` or `getSharedDrive`; `getSharedDrive` returns raw `Drive` only for the caller's own home; the `Drive | SharedDrive` union keeps unwrapped methods off the route surface. Org lookups are pinned to `config.orgId`, `allowUserToCreateOrganization` is false. Setup is single-shot on `isSetupRequired()`. The better-auth `secret` is `randomBytes(32)`, never returned.
- **Cross-home.** No `getHome()` for another user outside `home-relay.ts`. SSE streams are self-only; team events reach members through per-user broadcast. Notifications are server-composed; no route creates one with caller-chosen text or link.
- **Paths.** `validateName` rejects `/`, `\`, dot segments, control chars, `.trash`, over 255 bytes, after NFKC folding; `resolveWithinBase` guards local storage; `S3Storage.getKey` rejects `..`. Mailbox folder names and draft ids are character-allowlisted. DAV paths are capped at two segments and id-regexed.
- **Inline serving.** `serveFile`, `/embed` and `/preview` set `nosniff` and `Content-Security-Policy: sandbox; default-src 'none'` for html, xhtml and svg. Mail attachments are always `application/octet-stream` + `attachment`. Thumbnails and avatars are re-encoded to webp. `contentDisposition` strips CR, LF, non-ASCII and escapes quotes.
- **Transforms.** Every export and five of six previews go through `sanitizeExportHtml`, which strips non-`data:` `url()`, `src`, `href`, `xlink:href`, `@import` and CSS-escape evasions before WeasyPrint. Zip imports have a declared-size reject plus a streaming byte cap (200 MB) and a 4M-cell model guard. docx image names are server-generated. No server-side formula can reach the network or filesystem; preview and extract run with `recalc: false`. One document Worker at a time, bounded queue, per-kind kill deadlines, 503 on overload, never a main-thread fallback. All subprocess spawns are argv arrays.
- **Collab.** Session from cookie on upgrade, no token in URL. Sync sub-types 1 and 2 dropped for `!canWrite`, write re-checked per message, `enforceReadAccess` drops revoked readers live. zstd decompression only runs on server-written blobs. Version restore requires write.
- **Chat and comments.** Author is the session user; edit and delete require authorship; whispers are redacted server-side; attachments resolve inside the room's own `media/`. Comment reads are read-gated, status and assignee writes are write-gated, assignees are validated as members.
- **Mail.** `from` and the envelope are forced to the session user's address on save and send; submission ports enforce `reject_authenticated_sender_login_mismatch`; port 25 relays only for `mynetworks` and `reject_unauth_destination`. MIME parser caps nodes (1000), head size (1 MB) and derived HTML (2 MB). `/mail/deliver/:to` and `/internal/*` are 404 at Caddy and reject any request carrying `X-Real-IP` or `X-Forwarded-For` in `requireLocalhost`. Recipient lookup is exact-match on lowercased email, no catch-all.
- **Calendar and DAV.** Event writes check `existing.calendarId` (no cross-calendar reach from a share). Free-busy returns times and status only. Attendees on linked events may change only reminders and colour. CalDAV and CardDAV are `requireSelf` on every handler. RRULE is bounded (no sub-daily, 1900 to 2200, 10 000 occurrences, 5-year windows). Bodies are capped before XML parsing (1 MiB PROPFIND/REPORT, 64 KB WebDAV); `fast-xml-parser` v5 resolves no external entities. Remote vCard `PHOTO` URIs are never fetched.
- **Protocol auth.** App password checked first and bound to `key.referenceId === user.id`; 2FA and guest accounts are hard-blocked off the primary-password fallback; failure-only limiter (10 per email, 50 per IP, 15 min). Caddy overwrites `X-Real-IP` and `X-Forwarded-For` on `/eigen/*` and drops inbound XFF on `/dav/*`, so IP buckets are not spoofable behind the shipped edge.
- **Frontend.** Cookie auth with `credentials: 'include'`, no token in storage or URLs; CORS locked to `trustedOrigins` with credentials, so cross-site JSON POSTs preflight and cookies are `SameSite=Lax`. No `callbackURL`/`returnTo` open redirect. Chat links are `https?://` only with `rel="noopener noreferrer"`; contacts render only `mailto:` and `tel:`; sheet hyperlinks allowlist http, https, mailto. Canvas rich text is re-sanitized at the mount seam and on paste. `sanitizeToLightEditorHtml` is DOMParser-based, drops all attributes, restricts `href` to http(s) and mailto.
- **Deployment.** No secrets tracked in git; API container runs as `1000:1000` with `--frozen-lockfile --ignore-scripts` and `trustedDependencies: []`; `eigen-api` has no host port; `host-api` and `static` overlays bind `127.0.0.1`; global rate limit 1000/60 s plus better-auth 10/60 s on sign-in and 2FA; demo mode is an exact `EIGEN_DEMO === '1'` check; error handler returns a generic 500; nothing logs bodies, headers or tokens.

## Coverage gaps

- No finding was executed against a running instance. Finding 16 was tested against the bundled sharp directly (external refs blocked). Finding 17 still depends on the deployed ffmpeg; confirm by uploading an `.m3u8` referencing `file:///etc/passwd` and inspecting the thumbnail.
- better-auth's own organization and admin plugin endpoints (`update-member-role`, `add-member`, `set-role`, `ban-user`, `impersonate-user`) were checked for loosening config only, not traced inside the vendored dist. Worth one test: a plain member session calling `update-member-role` on itself.
- `ical-parse.ts`, `vtimezone.ts`, the vCard parser, `proppatch.ts`, `maildb.ts` and the full `maildir-store.ts` sync engine were read at their security seams, not line by line, for a crafted-input hang within the size caps.
- ExcelJS and mammoth OOXML parsing was not audited for entity expansion (upstream, SAX-style parsers).
- Whether an operator's `TRUSTED_NETWORKS` or `userland-proxy` setting widens the Postfix trust range (finding 19) was not checked live.

## Recommended order

1. Findings 1, 2, 3 (one line, one call, one `DOMParser`): an afternoon, closes every High.
2. Findings 5 and 6: two small guards reusing existing helpers.
3. Finding 8 (CSP from the API) then 9 (`bun update`): the second layer under every sanitizer.
4. Finding 4 (iMIP alignment) and 7 (awareness caps): each needs a short design decision first.
5. Finding 10 (mail iframe): a UX change; do it with finding 11 in one round.
6. The rest as broken-window fixes when touching the file.

Findings are tracked as one row in [ROADMAP.md](ROADMAP.md); tick items off here and prune this file when everything has shipped, as with the 2026-07 audit files.
