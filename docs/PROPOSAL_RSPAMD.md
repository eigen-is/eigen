# Proposal: rspamd sidecar — inbound spam filtering + mark-as-spam training

> **TLDR**: Add `rspamd` (plus its Redis backend) to the `mail` compose profile as a Postfix
> milter. Inbound mail gets SPF/DKIM/DMARC verification and spam scoring at the SMTP edge;
> scored mail is stamped with `X-Spam` headers; `Mail.mailboxDeliver` routes flagged mail to
> `Junk` instead of INBOX. The existing **"Report Spam" button becomes the training signal**:
> `Mail.messageMove` calls rspamd's `/learnspam` when a message moves into Junk and `/learnham`
> when one is rescued out. No FE change is required for v1; a "Not spam" button in the Junk view
> is a small follow-up. Fail-open throughout — a dead sidecar never blocks mail. ~1–2 days.
> This promotes the *§ Cheaper alternative* from
> [PROPOSAL_STALWART_MAIL.md](PROPOSAL_STALWART_MAIL.md) into its own plan.

## Goals

1. **Spam lands in Junk, not INBOX.** Today every inbound message is appended to INBOX
   unconditionally; there is no scoring anywhere in the pipeline.
2. **Inbound authentication checks.** SPF, DKIM and DMARC verification on arrival; egregious
   scores are rejected at SMTP time and never reach the API.
3. **The filter learns from users.** "Report Spam" trains Bayes; rescuing a false positive out
   of Junk untrains it. No new UI needed for the core loop.
4. **Zero behaviour change when absent.** Deployments without the sidecar (or with rspamd down)
   deliver exactly as today. Postfix already runs `milter_default_action = accept`.

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

Full architecture in [IMAP.md](IMAP.md). The relevant facts:

- **Inbound**: internet → Postfix (:25) → pipe transport `eigen-deliver`
  (`docker/postfix/eigen-deliver`) → `POST /mail/deliver/:to` (`apps/api/src/routes/mail.ts:47`)
  → `Mail.mailboxDeliver` (`apps/api/src/lib/mail/mail-domain.ts:130`), which **always** does
  `store.append('', message)` — INBOX. The message is already `simpleParser`-parsed there for
  iMIP detection.
- **"Report Spam" is a pure folder move.** `handleReportSpamByIds`
  (`apps/mail/src/components/mail/hooks/use-mail-actions.ts`) → `PUT
  /mail/:ownerId/message/move` → `Mail.messageMove` (`mail-domain.ts`) → Maildir rename +
  DB update. No flag, no header, no learning.
- **Mail has a single-slot undo (`z`)** that reverses a spam report by moving the message back to
  its previous mailbox through the same `PUT /mail/:ownerId/message/move` — so it rides the
  server-side `messageMove` training hook automatically, un-learning the spam it just learned.
- **Junk is already a first-class mailbox**: in `STANDARD_MAILBOXES`
  (`apps/api/src/lib/core/constants.ts:33`), mapped to IMAP `\Junk`
  (`apps/api/src/lib/mail/mailutils.ts:12`), excluded from search
  (`apps/api/src/lib/mail/maildb.ts:12`).
- **Milter infrastructure exists**: OpenDKIM at `inet:127.0.0.1:8891` with
  `milter_default_action = accept` (`docker/postfix/main.cf.template:33-37`).
- **A recursive resolver already runs**: the `mail` profile includes `unbound`
  (`docker-compose.yml:103`), which Postfix uses via `dns:`. This matters — DNSBL/URIBL lookups
  are refused or lied to through public resolvers like 8.8.8.8, and are the usual pain point of
  an rspamd deployment. Here it's already solved.
- **New-mail notifications** fire in the `received` store callback (`mail-domain.ts:80-92`) for
  every new message regardless of mailbox.

## Design

### 1 — Containers

Two services join the `mail` profile. rspamd needs Redis for Bayes statistics and its
throttling/reputation modules (the SQLite stats backend is deprecated upstream); both are small.

```yaml
# docker-compose.yml (sketch)
  rspamd:
    profiles: ["mail"]
    build:
      context: docker/rspamd
    dns: ["${EIGEN_UNBOUND_IP:-172.20.0.254}"]   # DNSBLs need the recursive resolver
    environment:
      RSPAMD_PASSWORD: ${RSPAMD_PASSWORD:-}       # controller (learn API + web UI)
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

`docker/rspamd/` holds a small Dockerfile on `rspamd/rspamd:stable` plus `local.d/` config
templated by an entrypoint, following the `docker/postfix/` envsubst pattern:

- `worker-proxy.inc` — milter mode on `:11332`.
- `worker-controller.inc` — learn API + web UI on `:11334`, password from `RSPAMD_PASSWORD`.
  **Docker-network only** — never exposed through Caddy; admins reach the web UI via an SSH
  tunnel if they want it.
- `milter_headers.conf` — stamp `X-Spam-Status` / `X-Spamd-Result` on scored mail.
- `options.inc` — `local_addrs = "127.0.0.0/8, 172.16.0.0/12"` (mirrors Postfix `mynetworks`)
  so mail submitted by the API container is not spam-scored.
- `actions.conf` — keep upstream defaults (reject 15, add_header 6) but **disable greylisting**
  for v1: first-contact delays read as "Eigen lost my mail" on a small personal server.
- `classifier-bayes.conf` — Redis backend, `autolearn` off for v1 (only explicit user training).

### 2 — Postfix wiring (one line)

```diff
 # docker/postfix/main.cf.template
-smtpd_milters = inet:127.0.0.1:8891
+smtpd_milters = inet:127.0.0.1:8891 inet:rspamd:11332
 non_smtpd_milters = inet:127.0.0.1:8891
```

Inbound mail on :25 is now scored before the pipe transport hands it to the API. Mail from the
API (relayed via `SMTP_HOST=postfix`) passes `permit_mynetworks` in Postfix and `local_addrs`
in rspamd, so outbound is signed by OpenDKIM as today and not spam-scored.
`milter_default_action = accept` already makes the whole thing fail-open: rspamd down → mail
flows unscored, exactly today's behaviour.

### 3 — Junk routing in `mailboxDeliver`

The one real code change on the inbound path. Because delivery bypasses Dovecot's LDA (pipe →
HTTP), there is no sieve step that could file spam — the API must route it. `mailboxDeliver`
already parses the message; hoist the parse and pick the target mailbox from the rspamd
verdict:

```typescript
// mail-domain.ts (sketch)
async mailboxDeliver(message: Buffer): Promise<string> {
    const parsed = await simpleParser(message).catch(() => null);
    const isSpam = parsed?.headers.get('x-spam-status')?.toString().startsWith('Yes') ?? false;
    const uniqueId = await this.store.append(isSpam ? 'Junk' : '', message);
    // ... existing iMIP handling reuses `parsed`; skip iMIP for spam
    return uniqueId;
}
```

Plus a one-line suppression in the `received` callback (`mail-domain.ts:80-92`): no `mail:new`
notification for messages arriving in Junk (the `MAIL_MOVED`/`MAIL_RECEIVED` SSE still fires so
the Junk count updates).

### 4 — The learn loop: "Report Spam" trains the filter

rspamd's controller exposes `POST /learnspam` and `POST /learnham` (raw RFC-822 body,
`Password` header). Every UI spam action already funnels through `Mail.messageMove`
(`mail-domain.ts:207`), which knows both the source (`email.mailbox`) and target mailbox:

- **Into Junk** (from anywhere) → `/learnspam`.
- **Out of Junk to INBOX or Archive** (a rescue) → `/learnham`.
- **Junk → Trash learns nothing** — deleting spam is not a ham signal.

```typescript
// mail-domain.ts messageMove (sketch)
const wasJunk = email.mailbox === 'Junk';
const isJunk = targetMailbox === 'Junk';
if (isJunk !== wasJunk && (isJunk || targetMailbox === '' || targetMailbox === 'Archive')) {
    const raw = Buffer.from(await this.store.getRawMessage(messageId));
    rspamdLearn(isJunk ? 'spam' : 'ham', raw); // fire-and-forget, logged on failure
}
await this.store.move(messageId, targetMailbox);
```

A new `apps/api/src/lib/mail/rspamd.ts` holds the tiny HTTP client. Rules:

- **No-op when `RSPAMD_URL` is unset** — deployments without the sidecar are unaffected.
- **Fire-and-forget.** Training must never block or fail the move; failures are logged.
- rspamd answers "already learned" for repeat submissions of the same message — treat as
  success.

### 5 — Config

Two API env vars, both optional: `RSPAMD_URL` (e.g. `http://rspamd:11334`) and
`RSPAMD_PASSWORD`. Existing production deployments update via `update.sh` — add both through
the `add_var_if_missing` migration (generate the password) so a stale `.env` cannot break the
update (see the new-env-var gotcha that bit the frontend build vars).

**Frozen-format impact: none.** The added `X-Spam-*` headers live in the per-message EML like
any other header; no DB schema, Yjs root, or MIME value changes.

### 6 — FE follow-up: "Not spam"

The Report Spam button already hides itself in Junk (`email-detail.tsx:46`); there is no
explicit inverse. Add a "Not spam" button in the Junk view that moves to INBOX — the ham
training fires server-side automatically via §4. Small, independent, Phase 3.

## Phased rollout

| Phase | Scope | Result |
|---|---|---|
| **0 — Sidecar** | rspamd + Redis containers, milter line, header stamping, greylist off, thresholds default. No API code change. | Edge rejection of egregious spam; SPF/DKIM/DMARC verified; headers visible in delivered mail for tuning. |
| **1 — Junk routing** | `mailboxDeliver` header check + notification suppression. | Spam lands in Junk. The user-visible fix. |
| **2 — Learn loop** | `rspamd.ts` client, `messageMove` hook, env vars, `update.sh` migration. | "Report Spam" trains the filter. |
| **3 — Polish (optional)** | "Not spam" button; Dovecot IMAPSieve → `rspamc` for IMAP-side moves; ARC signing; revisit greylisting/autolearn. | Parity for external IMAP clients. |

Phases 0–2 are the "~1–2 days" of the roadmap row; each is independently shippable.

## Risks and caveats

- **Bayes cold start.** The statistical classifier stays inert until a minimum corpus is
  learned (`min_learns`, default 200 per class). Rule-based scoring (DNSBLs, SPF/DMARC
  failures, heuristics) works from day one, which is most of the win.
- **False positives.** With the default `add_header 6` threshold and greylisting off, rspamd's
  defaults are conservative, but users must know to glance at Junk. Rescue-out-of-Junk is
  cheap and trains the filter in the right direction.
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

- Existing mail architecture: [IMAP.md](IMAP.md)
- Stalwart proposal (the expensive path this replaces for spam): [PROPOSAL_STALWART_MAIL.md](PROPOSAL_STALWART_MAIL.md)
- rspamd: [rspamd.com](https://rspamd.com/) — [proxy/milter worker](https://rspamd.com/doc/workers/rspamd_proxy.html), [controller learn API](https://rspamd.com/doc/architecture/protocol.html), [Bayes statistics](https://rspamd.com/doc/configuration/statistic.html)
- Prior art for the move-triggered learn loop: Mailcow's Dovecot IMAPSieve → `rspamc` pipeline
