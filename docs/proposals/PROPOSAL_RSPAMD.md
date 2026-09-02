# Proposal: rspamd sidecar — inbound spam filtering + mark-as-spam training

> **TLDR**: Add `rspamd` (pinned image, plus its Redis backend) to the `mail` compose profile as
> a Postfix milter with bounded fail-open timeouts, scanning **port 25 only** — authenticated
> submission (465/587) and API-originated mail are exempt by construction. The verdict travels in
> an Eigen-owned `X-Eigen-Spam` header that Postfix strips from inbound mail before rspamd re-adds
> it, so it is trustworthy even when the sidecar is down; `Mail.mailboxDeliver` routes on it only
> when `RSPAMD_URL` is configured. Training intent is **explicit**: the move API gains a
> `train: 'spam' | 'ham'` field driven by Report Spam, a new "Not spam" button, and the undo slot —
> the server never infers votes from folder transitions. Training runs after the move as a caught
> background task; rspamd's learn cache makes repeats idempotent and class flips self-unlearning.
> iMIP processing for quarantined invitations is deferred and replayed exactly once on rescue.
> Rollout is observe-first: SMTP-time rejection stays off until real scores have been measured.
> ~2–3 days for phases 0–2. This promotes the *§ Cheaper alternative* from
> [PROPOSAL_STALWART_MAIL.md](PROPOSAL_STALWART_MAIL.md) into its own plan.

## Goals

1. **Spam lands in Junk, not INBOX.** Today every inbound message is appended to INBOX
   unconditionally; there is no scoring anywhere in the pipeline.
2. **Inbound authentication checks.** SPF, DKIM and DMARC verification on arrival. SMTP-time
   rejection of egregious scores is a *later, gated* step — v1 only classifies, so a false
   positive is always recoverable from Junk.
3. **The filter learns from users.** "Report Spam" trains Bayes; "Not spam" (and undo) untrains
   it. Intent is carried explicitly end-to-end.
4. **Zero behaviour change when absent.** Deployments without the sidecar (or with rspamd down)
   deliver exactly as today — including when a sender forges spam headers. This is enforced at
   two layers: Postfix strips inbound instances of the verdict header, and the API ignores the
   header entirely unless `RSPAMD_URL` is set.

## Non-goals

- **JMAP, server-side mail FTS, Sieve scripting** — that's the Stalwart proposal
  ([PROPOSAL_STALWART_MAIL.md](PROPOSAL_STALWART_MAIL.md)); this proposal deliberately stays on
  the Maildir+Dovecot+Postfix stack.
- **Replacing OpenDKIM.** Outbound DKIM signing stays in the Postfix container. rspamd *can*
  sign DKIM/ARC; consolidating is an open question, not v1.
- **Per-user Bayes.** One global classifier for v1 (see *§ Risks*).
- **Training from IMAP clients.** Dragging mail to Junk in Thunderbird moves the file via
  Dovecot and never touches the API; catching that needs an IMAPSieve hook in the Dovecot
  container (Phase 3, optional).

## Current state (recap)

Full architecture in [IMAP.md](../IMAP.md). The facts that drive this design:

- **Inbound**: internet → Postfix (:25) → pipe transport `eigen-deliver`
  (`../../docker/postfix/eigen-deliver`) → `POST /mail/deliver/:to` (`apps/api/src/routes/mail.ts:47`)
  → `Mail.mailboxDeliver` (`apps/api/src/lib/mail/mail-domain.ts:134`), which **always** does
  `store.append('', message)` — INBOX.
- **Outbound from the API uses the same listener.** `sendMail` relays via `SMTP_HOST=postfix`
  port 25 (`apps/api/src/lib/core/mailer.ts:39-45`, `docker-compose.yml:53-54`) — so port 25
  carries both internet mail and Eigen's own outbound, and the design must exempt the latter.
- **Submission listeners inherit milters.** `submission` (587) and `smtps` (465) are separate
  `smtpd` services in `../../docker/postfix/master.cf.template` with no `-o smtpd_milters` override —
  a global milter change would silently start filtering authenticated clients.
- **"Report Spam" is a pure folder move** with no semantics attached: `handleReportSpamByIds`
  (`../../apps/mail/src/components/mail/hooks/use-mail-actions.ts`) → `PUT /mail/:ownerId/message/move`
  → `Mail.messageMove` → Maildir rename + DB update. The button is shown in **every** non-Junk
  mailbox, including Trash and Sent (`apps/mail/src/components/mail/email-detail.tsx:47`), and
  the folder-picker move to Junk already toasts "Reported as spam" (`use-mail-actions.ts:272`).
- **Undo is a replayed move.** The single-slot undo (`z` / toast) records `{from, to}` and moves
  the message back. It carries no intent — "undo a spam report from Trash" and "delete spam"
  are both `Junk → Trash` on the wire, so folder transitions alone cannot express training
  semantics.
- **iMIP runs only at delivery.** `processInboundImip` has exactly one call site,
  `mailboxDeliver` (`mail-domain.ts:142`) — anything skipped there is never replayed.
- **Junk is already a first-class mailbox**: in `STANDARD_MAILBOXES`
  (`apps/api/src/lib/core/constants.ts:33`), mapped to IMAP `\Junk`
  (`apps/api/src/lib/mail/mailutils.ts:12`), excluded from search
  (`apps/api/src/lib/mail/maildb.ts:12`).
- **Milter infrastructure exists**: OpenDKIM at `inet:127.0.0.1:8891` with
  `milter_default_action = accept` (`docker/postfix/main.cf.template:33-37`). But the
  OpenDKIM-failure fallback runs `sed -i '/milter/d'` (`docker/postfix/entrypoint.sh:95`),
  which would also delete any rspamd milter line — the fallback must become targeted.
- **The Docker subnet is configurable, and Postfix doesn't know it.** Setup falls back through
  `172.30.0.0/24`, `172.31.0.0/24`, `10.20.0.0/24` when `172.20.0.0/24` conflicts
  (`scripts/setup.ts:127`), yet `mynetworks` and OpenDKIM's TrustedHosts hardcode
  `172.16.0.0/12` (`main.cf.template:11`, `entrypoint.sh:68-72`). On the `10.20.0.0/24`
  fallback the API is *outside* `mynetworks` today — a latent bug this proposal fixes by
  templating the subnet.
- **A recursive resolver already runs**: the `mail` profile includes `unbound`
  (`docker-compose.yml:106`), which Postfix uses via `dns:`. This matters — DNSBL/URIBL lookups
  are refused or lied to through public resolvers like 8.8.8.8, and are the usual pain point of
  an rspamd deployment. Here it's already solved.
- **New-mail notifications** fire in the `received` store callback (`mail-domain.ts:80-97`) for
  every new message regardless of mailbox.

## Design

### 1 — Containers

Two services join the `mail` profile. rspamd needs Redis for Bayes statistics, the learn cache
(which provides idempotent re-learning and automatic class-flip unlearning, see §4), and its
throttling/reputation modules; both are small.

```yaml
# docker-compose.yml (sketch)
  rspamd:
    profiles: ["mail"]
    build:
      context: docker/rspamd
    dns: ["${EIGEN_UNBOUND_IP:-172.20.0.254}"]   # DNSBLs need the recursive resolver
    environment:
      RSPAMD_PASSWORD: ${RSPAMD_PASSWORD:-}       # controller (learn API + web UI)
      EIGEN_SUBNET: ${EIGEN_SUBNET:-172.20.0.0/24}
    volumes:
      - rspamd-data:/var/lib/rspamd
    depends_on:
      redis: { condition: service_started }
      unbound: { condition: service_healthy }
    restart: unless-stopped
    networks: [eigen]

  redis:
    profiles: ["mail"]
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes:
      - redis-data:/data
    restart: unless-stopped
    networks: [eigen]
```

`docker/rspamd/` holds a small Dockerfile pinned to **`rspamd/rspamd:4.1.4`** — the current
stable release. A `:stable` tag does **not** exist on Docker Hub (the registry 404s on it), and
`:latest` is a moving target; pin the version tag and bump it deliberately. The image ships
`local.d/` config templated by an entrypoint, following the `../../docker/postfix` envsubst pattern:

- `worker-proxy.inc` — milter mode on `:11332` (milter support lives in the `rspamd_proxy`
  worker; the `normal` worker on `:11333` does the actual scanning).
- `worker-controller.inc` — learn API + web UI on `:11334`. The entrypoint hashes
  `RSPAMD_PASSWORD` with `rspamadm pw` and renders the hash into **both** `password` and
  `enable_password` (`/learnspam` and `/learnham` are privileged controller commands; a lone
  `password` would cover them but logs warnings). The entrypoint **refuses to start** when
  `RSPAMD_PASSWORD` is empty — an unauthenticated controller must not exist, even
  Docker-network-internal. Never exposed through Caddy; admins reach the web UI via an SSH
  tunnel if they want it.
- `milter_headers.conf` — the standard `x-spam-status` / `x-spamd-result` routines for
  visibility and threshold tuning, plus a `custom` routine that adds the **Eigen-owned verdict
  header `X-Eigen-Spam: Yes`** when the action is `add_header` or worse. Routing trusts only
  this header (§3); the X-Spam-* pair is informational.
- `settings.conf` — the API-outbound exemption:

  ```
  internal_relay {
      ip = "${EIGEN_SUBNET}";
      want_spam = yes;
  }
  ```

  `want_spam = yes` is rspamd's documented **complete** bypass ("a full bypass of all Rspamd
  processing" — no rules, no score, no headers, no history). This, not `local_addrs`, is the
  no-action boundary: `local_addrs` only skips origin checks like SPF while the message is
  still scanned and actioned.
- `options.inc` — `local_addrs = "127.0.0.0/8, ${EIGEN_SUBNET}"` as belt-and-braces for the
  origin checks it does govern.
- `actions.conf` — **greylisting disabled** (first-contact delays read as "Eigen lost my mail"
  on a small personal server) and **`reject` disabled for v1** — observe mode. `add_header`
  stays at the default 6. SMTP-time rejection is enabled later, as its own gated step, after
  real scores have been observed (§ Phased rollout): a rejected false positive is never stored,
  cannot be rescued from Junk, and cannot feed the correction loop, so it must not ship blind.
- `classifier-bayes.conf` — Redis backend, `autolearn` off for v1 (only explicit user
  training), **learn cache on** (§4 depends on it).

### 2 — Postfix wiring

Three coordinated changes in `../../docker/postfix`, not one line:

**a) Scope: rspamd scans port 25 only.** The `submission` and `smtps` services in
`master.cf.template` each get `-o smtpd_milters=inet:127.0.0.1:8891` — authenticated clients
keep DKIM signing but are never spam-filtered (the global `milter_default_action = accept`
keeps that override fail-open too). Port 25 gets both milters via `main.cf`; API-originated
mail on :25 is exempted inside rspamd by the `want_spam` rule (§1).

**b) Bounded fail-open.** `milter_default_action = accept` only chooses the action *after* a
milter error — Postfix still waits out the milter timeouts first, and the defaults (30s
connect/command, **300s** content) would let a hung sidecar stall SMTP sessions for minutes.
Use the per-milter override syntax (Postfix ≥ 3.0; we set `compatibility_level = 3.6`):

```diff
 # docker/postfix/main.cf.template
-smtpd_milters = inet:127.0.0.1:8891
+smtpd_milters =
+    { inet:127.0.0.1:8891, default_action=accept }
+    { inet:rspamd:11332, connect_timeout=5s, command_timeout=10s, content_timeout=30s,
+      default_action=accept }
+header_checks = regexp:/etc/postfix/header_checks
 non_smtpd_milters = inet:127.0.0.1:8891
```

A dead or hung rspamd now delays a session by seconds, bounded, then mail flows unscored —
today's behaviour.

**c) The verdict header is a trusted boundary.** `/etc/postfix/header_checks` gets
`/^X-Eigen-Spam:/ IGNORE`. Ordering makes this sound: cleanup applies `header_checks` **before**
invoking milters (per `cleanup(8)`, drop-headers happen "after applying header_checks and before
invoking Milter applications"), so sender-forged instances are stripped while the instance
rspamd adds afterwards survives. When rspamd is down, forged instances are still stripped —
the header simply never appears, and mail routes to INBOX. rspamd's own `milter_headers`
remove-then-add semantics additionally sanitize the informational `X-Spam-*` headers whenever
it is running.

**Subnet templating.** `mynetworks` and OpenDKIM's TrustedHosts are rendered from
`EIGEN_SUBNET` (compose passes it to the postfix container; entrypoint envsubst), replacing the
`172.16.0.0/12` hardcodes — fixing the latent `10.20.0.0/24`-fallback mismatch for Postfix and
rspamd from one value. Setup should derive the API-side `TRUSTED_NETWORKS` default from the
same chosen subnet while it's in there.

**Targeted OpenDKIM fallback.** Replace `sed -i '/milter/d'` in `entrypoint.sh` with additive
generation: the entrypoint composes the effective `smtpd_milters` / `non_smtpd_milters` values
(via `postconf -e`) from the services that actually started, dropping only the OpenDKIM
endpoint when OpenDKIM fails. rspamd filtering must survive an OpenDKIM failure.

### 3 — Junk routing in `mailboxDeliver`

The one real code change on the inbound path. Because delivery bypasses Dovecot's LDA (pipe →
HTTP), there is no sieve step that could file spam — the API must route it. `mailboxDeliver`
already parses the message; hoist the parse and pick the target mailbox from the trusted
verdict header — **only when the deployment declares rspamd** (`RSPAMD_URL` set). Without it
the header is ignored entirely, so an rspamd-less deployment keeps byte-for-byte today's
behaviour even against forged headers:

```typescript
// mail-domain.ts (sketch)
async mailboxDeliver(message: Buffer): Promise<string> {
    const parsed = parseMail(message);
    // parseHeaders would decode X-Eigen-Spam into a typed field; the parser exposes no raw header map
    const isSpam = rspamdEnabled() && parsed.spam;
    const uniqueId = await this.store.append(isSpam ? 'Junk' : '', message);
    // iMIP: ham → process now (reusing `parsed`); spam → defer, see below
    return uniqueId;
}
```

**Deferred iMIP with exactly-once rescue.** Skipping `processInboundImip` for spam is right
(processing quarantined mail would let calendar spam through), but a false positive must
recover: today iMIP runs *only* at delivery, so a rescued invitation would leave calendar state
missing forever. Fix by construction:

- At delivery, when a message is routed to Junk **and** carries a `text/calendar` attachment,
  record its id in a small `imip_pending` table (additive `MailDB` migration through the
  existing versioned-migration mechanism).
- When a message moves out of Junk and its id is in `imip_pending`: re-read the raw message,
  run `processInboundImip`, delete the row. `messageDelete` also clears the row.

One row, written only for the rare quarantined invitation, gives exactly-once semantics:
repeated Junk round-trips can't double-apply, and INBOX-delivered mail (already processed)
never has a row so rescuing it never re-processes.

**Notification suppression.** The `received` callback (`mail-domain.ts:80-97`) skips
`notifications.persist` for messages arriving in Junk; the `MAIL_RECEIVED` SSE still fires so
the Junk count updates.

### 4 — The learn loop: explicit intent, not folder inference

Folder transitions cannot express training semantics — the recap shows why: Report Spam is
available from every non-Junk mailbox (including Trash), so "undo a report that started in
Trash" and "delete spam" are the same `Junk → Trash` move; and the undo slot replays moves
without knowing why. So intent travels **with the request**:

- `PUT /mail/:ownerId/message/move` gains an optional `train?: 'spam' | 'ham'` field. The
  server trains exactly when told to, and never infers.
- FE callsites set it: `handleReportSpamByIds` → `'spam'`; the folder-picker move to Junk —
  which the UI already labels "Reported as spam" — → `'spam'` (an explicit product decision,
  made where the intent exists: client-side); a new **"Not spam"** button in the Junk view →
  move to INBOX with `'ham'`. The `Undoable` slot records the **inverse** value (`'spam'` ↔
  `'ham'`), so `z`/toast-undo reverses the training exactly, from any origin mailbox.
  `Junk → Trash` sends nothing — deleting spam is not a ham signal.

Server side, training is strictly after — and detached from — the move:

```typescript
// mail-domain.ts (sketch)
async messageMove(messageId: string, targetMailbox: string, train?: 'spam' | 'ham'): Promise<void> {
    // ... existing lookup + canonicalisation ...
    await this.store.move(messageId, targetMailbox);
    this.emit(SSEventType.MAIL_MOVED, { messageId, mailbox: email.mailbox, toMailbox: targetMailbox });
    if (train) this.trainSpamFilter(messageId, train); // void async chain, fully caught
}
```

`trainSpamFilter` reads the raw message (id-addressed, so the post-move location is fine) and
posts it — inside one caught chain, so a raw-read failure, network failure, or rspamd error can
only ever produce a log line, never block or fail the move. The old sketch awaited
`getRawMessage` *before* the move, which violated exactly that rule.

A new `apps/api/src/lib/mail/rspamd.ts` holds the tiny HTTP client
(`POST ${RSPAMD_URL}/learnspam | /learnham`, raw RFC-822 body, plaintext `Password` header):

- **No-op when `RSPAMD_URL` is unset** — deployments without the sidecar are unaffected.
- **HTTP 404 "already learned as spam/ham" is idempotent success** — rspamd's learn cache
  dedupes same-class repeats by message hash. Other failures (auth, transport, config) are
  logged.
- **Class flips need no unlearn endpoint** — the learn cache recognizes an opposite-class
  learn, unlearns the previous class and relearns in one operation. Undo-then-redo chains
  therefore converge on the user's final intent.

### 5 — Config: one credential lifecycle

Two API env vars: `RSPAMD_URL` (e.g. `http://rspamd:11334`; also the Phase-1 routing gate) and
`RSPAMD_PASSWORD`. The password exists in two representations — a `rspamadm pw` **hash** inside
the rspamd container (§1) and the **plaintext** in the API's environment for the `Password`
request header — and must survive every path that writes `.env.production`:

| Touchpoint | Change |
|---|---|
| `../../scripts/update.sh` | `add_var_if_missing RSPAMD_URL http://rspamd:11334` + `add_var_if_missing RSPAMD_PASSWORD "$(openssl rand -hex 24)"` — existing deployments migrate without a stale-`.env` break (the gotcha that bit the frontend build vars). |
| `../../scripts/setup.ts` | Include both vars in the written template; **preserve an existing `RSPAMD_PASSWORD` on rerun** (like `SMTP_RELAY_*`), generate when absent. Today a setup rerun would silently erase a migrated variable it doesn't know. |
| `../../scripts/generate-env.sh` | Same: add to the preserve-whitelist, generate when absent. |
| `.env.example` | Document both (commented, like the relay block). |
| `../../docker-compose.yml` | `eigen-api` gets `RSPAMD_URL` + `RSPAMD_PASSWORD`; `rspamd` gets `RSPAMD_PASSWORD` + `EIGEN_SUBNET`. |
| rspamd entrypoint | Hash → `worker-controller.inc`; refuse to start on empty (§1). |

**Frozen-format impact: none.** The added headers live in the per-message EML like any other
header; `imip_pending` is an additive `MailDB` table through the existing versioned-migration
mechanism. No Yjs root, drive value, or MIME constant changes.

## Phased rollout

| Phase | Scope | Result |
|---|---|---|
| **0 — Sidecar, observe-only** | rspamd (pinned) + Redis containers, milter wiring incl. per-milter timeouts + submission/smtps overrides, `X-Eigen-Spam` strip + stamp, `want_spam` exemption, subnet templating, targeted OpenDKIM fallback. Greylist **off**, reject **off**. No API code change. | SPF/DKIM/DMARC verified; scores visible as headers in delivered mail for threshold tuning; zero user-facing change; fail-open measured. |
| **1 — Junk routing** | `RSPAMD_URL` env (compose + migration), `mailboxDeliver` gate + header check, `imip_pending` + rescue replay, notification suppression. | Spam lands in Junk. The user-visible fix. |
| **2 — Learn loop** | `rspamd.ts` client, `train` through the move API, FE intent callsites + "Not spam" button, undo inverse-intent, `RSPAMD_PASSWORD` lifecycle. | "Report Spam" trains the filter; undo untrains it. |
| **3 — Rejection + polish (gated / optional)** | Enable SMTP-time `reject` after observed production scores (config flip, documented rollback = disable it again); Dovecot IMAPSieve → `rspamc` for IMAP-side moves; ARC signing; revisit greylisting/autolearn. | Edge rejection of egregious spam; parity for external IMAP clients. |

Phases 0–2 are ~2–3 days; each is independently shippable. Rejection deliberately leaves
Phase 0: an SMTP-rejected false positive is unrecoverable (never stored, never rescuable), so
it needs production evidence first.

## Verification gate

Not shippable on unit tests around `mailboxDeliver` alone — the blast radius spans container
startup, SMTP policy, untrusted parsing, undo semantics, calendar side effects, and the update
scripts. Each phase lands with its slice of:

- Compose build of the pinned image; rspamd config check passes.
- Forged `X-Eigen-Spam`/`X-Spam-Status` delivered with rspamd healthy, stopped, and hung
  (listening but silent): never routes to Junk; measured worst-case SMTP delay stays within the
  configured milter timeouts; port 25 keeps accepting.
- With `RSPAMD_URL` unset, a forged header is ignored by the API (no-sidecar contract).
- Authenticated submission on 465 and 587 is never spam-scanned or rejected; API-originated
  delivery works and is unscored on both the default and the `10.20.0.0/24` fallback subnet.
- Inbox vs Junk routing, SSE/count refresh, and Junk notification suppression.
- Learn spam, duplicate learn (404 → success), opposite-class relearn, wrong password rejected.
- Report Spam + undo from every mailbox where the button is exposed (including Trash) issues the
  matching train/untrain pair.
- Raw-read failure, controller failure, and move failure each leave the move contract intact;
  training never blocks a user action.
- A quarantined invitation has no calendar effect; rescue produces exactly one; a second
  Junk round-trip does not duplicate it.
- Fresh setup, headless `generate-env.sh`, `update.sh` migration, and a setup **rerun** all end
  with the same non-empty `RSPAMD_PASSWORD` in `.env.production`.
- OpenDKIM startup failure leaves rspamd filtering active.

## Risks and caveats

- **Bayes cold start.** The statistical classifier stays inert until a minimum corpus is
  learned (`min_learns`, default 200 per class). Rule-based scoring (DNSBLs, SPF/DMARC
  failures, heuristics) works from day one, which is most of the win.
- **False positives.** With `add_header 6`, greylisting off, and rejection off, nothing is lost
  in v1 — worst case a legitimate mail sits in Junk until rescued, which also trains the filter
  in the right direction. Users must know to glance at Junk.
- **One global Bayes.** All users share one classifier; one user's "spam" vote affects
  everyone's scoring. Acceptable at current scale; rspamd supports per-user statistics if it
  ever isn't.
- **IMAP moves bypass training** (see Non-goals) — the filter learns only from the Eigen UI
  until Phase 3.
- **Redis is a new stateful service.** Losing it means retraining, not data loss —
  `appendonly` + a volume is enough; backups optional.
- **Footprint.** rspamd idles ~100–150 MB RAM, Redis ~10–30 MB. Two more containers in the
  `mail` profile.

## Open questions

1. **Greylisting** — revisit once real spam volume is known? It is rspamd's cheapest
   high-impact measure, but the delivery delay confuses new users.
2. **Autolearn** — let rspamd auto-train from very-high/very-low scores, or keep training
   strictly explicit? Explicit-only is easier to reason about; start there.
3. **DKIM consolidation** — move outbound DKIM (and add ARC) signing from OpenDKIM into rspamd
   later? One less daemon inside the Postfix container and automated key rotation, but a DNS
   selector migration; not worth coupling to v1.
4. **Admin surface** — is SSH-tunnel access to the rspamd web UI enough, or should scoring
   stats appear in the Eigen admin page eventually?

## Reference

- Existing mail architecture: [IMAP.md](../IMAP.md)
- Stalwart proposal (the expensive path this replaces for spam): [PROPOSAL_STALWART_MAIL.md](PROPOSAL_STALWART_MAIL.md)
- rspamd: [rspamd.com](https://rspamd.com/) — [proxy/milter worker](https://rspamd.com/doc/workers/rspamd_proxy.html), [controller learn API](https://rspamd.com/doc/architecture/protocol.html), [Bayes statistics](https://rspamd.com/doc/configuration/statistic.html), [settings module](https://docs.rspamd.com/configuration/settings) (`want_spam`), [milter_headers](https://docs.rspamd.com/modules/milter_headers)
- Postfix: [MILTER_README](https://www.postfix.org/MILTER_README.html) (per-milter timeouts, `default_action`), [cleanup(8)](https://www.postfix.org/cleanup.8.html) (header_checks-before-milter ordering)
- Prior art for the move-triggered learn loop: Mailcow's Dovecot IMAPSieve → `rspamc` pipeline

Upstream facts in this document (no `:stable` tag / 4.1.4 current; `want_spam` full bypass;
`local_addrs` partial; learn-cache 404-on-repeat + class-flip unlearn; privileged learn
endpoints; milter timeout defaults and header_checks ordering) were verified against the
official rspamd docs/source, Docker Hub's registry API, and Postfix documentation on 2026-08-13.
