# Deep-dive: mailparser fork on hostile input (audit #14, #11, #12, #24-deadcode)

> **Status (2026-07-12):** verified, no production code changed. This feeds **pending Unit 5** of the audit
> fix pass. The vendored parser is **robust under fuzzing**; the real defects are one boundary typo, one DoS
> lever (whose audit-suggested fix is a footgun), and some dead code.
>
> **Branch:** `fix/api-audit-2026-07` (HEAD `08bda417`).
> **Original audit:** `docs/AUDIT_API_2026_07.md` (findings #14, #11, #12, #24; "spend more time" item #4).
> **Also:** `docs/MAIL.md`.
> **Sibling deep-dives:** `AUDIT_DEEPDIVE_CALDAV_TZ.md`, `AUDIT_DEEPDIVE_UPLOAD_QUEUE.md`, `AUDIT_DEEPDIVE_COLLAB_YJS.md`.

## How to resume this cold

1. Read `AGENTS.md` + `docs/CODE-STANDARDS.md` + `docs/MAIL.md`.
2. Read: `apps/api/src/lib/mail/mail-split/message-splitter.ts` (`checkBoundary`),
   `apps/api/src/lib/mail/mail-parser/mail-parser.ts` (htmlToText guard),
   `apps/api/src/lib/mail/mail-parser/simple-parser.ts` (attachment buffering),
   `apps/api/src/lib/mail/mail-parse.ts` (the caller — `simpleParser(bytes, {})`),
   and the consumers `apps/api/src/lib/mail/maildir-store.ts` (cold-index/sync) + the `messageGet` route.
3. Keeper red test preserved in `docs/superpowers/api-audit-deepdive-tests/zz-mailsplit-boundary.test.ts`
   (proves #14 at unit + end-to-end level). Copy into `apps/api/src/test/` and run:
   `cd apps/api && bun test src/test/zz-mailsplit-boundary.test.ts` (pure unit test; may need `node_modules`
   resolvable; no `--preload`). The original worktree also had `zz-mailfuzz.test.ts` / `zz-mailcost.test.ts` /
   `zz-mailsplit-chunked.test.ts` (fuzz net + cost measurements + well-formed-mail reachability) — recoverable
   from worktree `agent-a8cce6d41d870eb28` if needed.
4. Line numbers below may have drifted — **locate by symbol name**.

---

## #14 — `checkBoundary` `||` where it needs `&&` — **REAL, hostile-input-only (P2)**

**Where:** `mail-split/message-splitter.ts` `checkBoundary` (~:267-289). The inner test (~:271) is
`if (line.length >= 2 && (line[0] === 0x0d || line[1] === 0x0a))`. It should be
`line[0] === 0x0d && line[1] === 0x0a` (a real 2-byte CRLF). The outer `if` already proved `line[0]` is CR or
LF, so with `||` the inner is trivially true whenever `line[0]` is CR → `startpos` over-advances → the `--`
guard reads one byte too far and fails to recognize a valid boundary.

**Failure scenario (proven unit + end-to-end):** a line beginning with a bare CR, e.g. `"\r--boundary123\r\n"`
— reachable when the raw message contains `…\n\r--boundary…` (a body line terminated by bare LF, then a stray
CR before the delimiter; raw `.eml` / IMAP-APPEND / SMTP bytes are attacker-controlled).
- `checkBoundary("\r--boundary123\r\n")` → buggy returns `false` (not recognized); correct answer is `1`.
- End-to-end through `simpleParser`, a 2-part message whose separator before the 2nd boundary is `\n\r`
  instead of `\r\n`: **buggy** → `attachments.length === 0`, the attachment part is absorbed into the
  preceding text part, and its raw MIME (`Content-Type: application/octet-stream…`) **leaks into the visible
  `text` body**. **Fixed** → `attachments.length === 1`, filename + content intact, clean text.

**Reachability nuance (severity-tempering):** brute-forcing every 2-way chunk split of a **well-formed CRLF**
message through the splitter produced **0 divergent offsets** — so this does **not** corrupt standards-compliant
mail. It's a crafted-message evasion vector (smuggle an attachment past scanning; make rendered text diverge
from MIME structure).

**Verdict:** real, but hostile-input only. **Fix is a one-character correctness change with a clear test and
zero risk to normal mail — do it.**

**Fix direction:** `message-splitter.ts:271` — change `(line[0] === 0x0d || line[1] === 0x0a)` to
`line[0] === 0x0d && line[1] === 0x0a`.

**Test:** `zz-mailsplit-boundary.test.ts` — a buggy-vs-fixed differential (fuzzing alone would NOT catch this;
it needs the differential oracle). Load-bearing assertions:

```ts
// unit: the bug, isolated
test('BUG: lone CR before boundary is DROPPED by buggy, kept by fixed', () => {
    const line = Buffer.from('\r--boundary123\r\n', 'binary');
    expect(callBuggyCheckBoundary('boundary123', line)).toBe(false); // not recognized
    expect(callFixedCheckBoundary('boundary123', line)).toBe(1);     // correct: is a boundary
});

// end-to-end: the consequence
test('BUG: \\n\\r separator (bare CR before boundary) drops the attachment on buggy', async () => {
    const bytes = buildMessage('\n\r');            // vs control buildMessage('\r\n')
    const buggy = await parseWith(false, bytes);   // original checkBoundary
    const fixed = await parseWith(true, bytes);    // prototype patched to `&&`
    expect(fixed.attachments).toHaveLength(1);
    expect(fixed.attachments[0].content.toString()).toBe('binary file content');
    expect(buggy.attachments).toHaveLength(0);     // attachment silently dropped
    expect(buggy.text ?? '').toContain('octet-stream'); // MIME leaks into visible body
});
```

---

## #11 — uncapped `htmlToText` on untrusted HTML — **REAL DoS lever (P2); the audit's suggested fix is a footgun**

**Where:** `mail-parser/mail-parser.ts` caps HTML→text only when `options.maxHtmlLengthToParse` is truthy
(~:963-966); the sole caller `mail-parse.ts:18` passes `simpleParser(bytes, {})` → cap disabled. Structure is
capped (`MAX_HEAD_SIZE = 1 MB`, `MAX_CHILD_NODES = 1000`) but content size is not. `parseEml` runs on the
request path (`messageGet` re-parses on every open) **and** for every message in the cold-index/sync loop
(`maildir-store.ts`).

**Measured (single email, `simpleParser(bytes, {})`):** ~70–90 ms/MB of HTML, roughly linear. A 6 MB HTML body
burned **388 ms of synchronous CPU**, during which a `setTimeout(…,0)` was starved for 389 ms — `htmlToText`
returns synchronously, so nothing else on the single-process event loop runs until it returns. A 25 MB body
(within normal size limits) ≈ 1.7 s. `DOMPurify.sanitize` (`mail-parse.ts:23`) adds further uncapped
synchronous CPU on the same HTML. **One crafted email = a real DoS lever on the shared event loop.**

**Verdict:** real. **But the audit's suggested fix (wire `maxHtmlLengthToParse`) is a footgun:** on exceed it
`emit('error')`s (~:967), which makes `simpleParser` **reject the whole parse** — proven: `cap=1MB` → `REJECTED
"HTML too long for parsing 3316685 bytes"`. That trades a DoS for making large-but-legitimate HTML emails
unreadable (500 on open, skipped in sync).

**Fix direction (correct):** (a) **truncate** `node.textContent` to a sane cap (e.g. 1–2 MB) *before*
`htmlToText` — bounds the work, keeps the email readable; or (b) move `parseEml` off the request/sync event
loop into a **worker thread** (already a deferred MAIL.md step, and it also covers #12). If keeping the knob at
all, first make it degrade gracefully (placeholder text) instead of `emit('error')`.

---

## #12 — attachment fully decoded + buffered on the summary path — **CONFIRMED waste, low urgency (P3)**

**Where:** `mail-parser/simple-parser.ts` (~:82-97) always buffers `att.content` (base64-decoded, checksummed).
The cold-index/summary path (`mail-parse.ts` → consumers) reads only `subject/from/to/textShort` +
`hasAttachments` (a `.length` check) — never `content` — yet still pays full decode + buffer per message.

**Measured:** 1 MB attachment → 1.0 MB buffered then discarded; 250 msgs × 200 KB (one cold-index chunk) →
~1.2 ms/msg of pure waste. Dominant cost is transient **memory** and aggregate GC over tens of thousands of
messages, not per-message latency.

**Verdict:** real but modest. **A dedicated "summary parse mode" is premature** relative to #11/#14, and is
largely subsumed by the worker-thread move. Build only the cheap version (a `skipAttachmentContent` flag on the
summary path) if a real large-mailbox profile justifies it — otherwise leave it.

---

## #24 — dead rewrite-path code in the mailsplit fork — **CONFIRMED zero callers (P3)**

Repo-wide grep confirms the encode/re-emit half is dead while the decode/read half is live. Outbound EML
generation lives independently in `mailfile.ts` (no `mail-split` imports).

- **Dead (safe to delete):** `mime-node.ts` `getHeaders()` (~:189), `setContentType()` (~:196),
  `getEncoder()` (~:233); `headers.ts` write methods `add`/`addFormatted`/`update`/`build` (`build` only called
  by the dead `getHeaders`); the `flowed-decoder.ts` (~:46-48) base64 branch (its only construction site passes
  `{ delSp }` only, never `encoding`).
- **Live (do NOT touch):** `MessageSplitter`, `MimeNode.getDecoder/addHeaderChunk/parseHeaders`, plain
  `FlowedDecoder`.

**Verdict:** confirmed dead. **Fix is safe surface reduction — low value, not noise.**

---

## Fuzzing — **ROBUST (checked, not a finding)**

500 deterministic hostile messages (seeded by index) across 9 families — malformed headers, unterminated
boundaries, charset bombs (bogus/10 KB charset names), truncated base64, huge single-line HTML,
nested-multipart depth bombs, random binary, malformed quoted-printable, bare-CR/mixed-EOL chaos — plus a
standalone 5000-deep nested-multipart bomb:

- **No hangs, no crashes, no OOM.** Slowest input < 200 ms.
- Depth bomb is capped: 5000 levels → `"Max allowed child nodes exceeded"` (`EMAXLEN`, `MAX_CHILD_NODES=1000`)
  at 176 ms — bounded, no stack overflow.
- **One caught robustness caveat (ties to #11):** `html-to-text` can throw (nondeterministic stack overflow)
  on deeply-nested HTML (5000-deep `<ul><li>`); it's caught (`mail-parser.ts:971-977`) → the parser
  `emit('error')`s → `simpleParser` **rejects the whole parse** → that one email becomes unreadable. Graceful
  (no crash) but heavy-handed — the same reject-the-parse behavior that makes the #11 knob a footgun.

## Suggested landing order for Unit 5

1. **#14** — one-character `&&` fix + commit `zz-mailsplit-boundary.test.ts`.
2. **#11** — truncate `textContent` before `htmlToText` (do NOT just wire `maxHtmlLengthToParse`), or schedule
   the worker-thread move (which also handles #12 and the html-to-text stack-overflow reject).
3. **#24** — delete the dead encode path.
4. **#12** — only the cheap `skipAttachmentContent` flag, and only if profiling justifies it.
