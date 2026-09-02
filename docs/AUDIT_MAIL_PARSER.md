# Audit: mail parser (ported nodemailer mailparser/mailsplit)

> **TLDR**: `apps/api/src/lib/mail/mail-parser/` + `mail-split/` are a 2381-line hand-port of nodemailer's streaming `mailparser` + `mailsplit`. Eigen has exactly one production entry, `simpleParser(Buffer, {})`, so every option branch is dead, the whole two-Transform streaming/backpressure machine only ever processes one already-buffered chunk, and the 81 + 23 `as` casts collapse to two untyped seams (splitter → parser node handoff, loose record → `ParsedMail`). The output contract is far narrower than the type: the `headers` Map serializes to `{}` on the wire, `headerLines`/`priority`/`checksum`/`related`/`cid`/`AddressObject.html` are read by nobody, and `mail.db` persists only the `EmailSummary` subset. Plan: pin a golden `.eml` corpus first, then replace the trio with a ~540-line non-streaming, cast-free parser typed at the header seam, tighten the shared types to what is consumed, and drop three dependencies.

Historical: the TLDR and findings describe the parser before the 2026-09-01 rewrite; see § Status at the end. Audit date 2026-09-01, branch `mail-parser-audit`. Scope from [ROADMAP.md](ROADMAP.md) § Focused audits. The 2026-07 deep-dive findings (#14 bare-CR boundary, #11 htmlToText cap, #24 dead encode half) are shipped with tests and are not re-reported.

## Findings

### 1. One entry, zero options, a streaming machine that never streams

Production calls the parser in two places, both `simpleParser(bytes, {})` on a Buffer: `mail-parse.ts:18` (every list/detail/sync read) and `mail-domain.ts:146` (iMIP scan on delivery). No caller sets any of the eleven `MailParserOptions` (`keepCidLinks`, `skipHtmlToText`, `skipImageLinks`, `skipTextToHtml`, `skipTextLinks`, `formatDateString`, `keepDeliveryStatus`, `maxHtmlLengthToParse`, `checksumAlgo`, `Iconv`, Transform options). Every non-default branch is dead, as are the stream/string/callback input variants of `simpleParser`, `IconvDecoder`, `MimeNode.partNr` and friends, and `Headers.mbox`/`.http`.

The input is fed as one chunk via `parser.end(source)`. The `MailParser → Splitter` Transform pipeline, object-mode `read()` pumps, `_flush`, the `once('drain')` backpressure handlers, the `AttachmentStream` Readable that `simple-parser.ts:83-98` immediately re-buffers, and the `release()`/`waitUntilAttachmentEnd` latch all exist to handle chunked, backpressured streams that never occur. Roughly 250-350 lines are unreachable and another ~600 are streaming apparatus with no job.

### 2. Casts have two root causes, not eighty

| Root cause | Casts | Fix at the source |
|---|---|---|
| Header map is `Map<string, HeaderValue>`; every read re-narrows (`as string`, `as StructuredHeader`, `as Date`, `as AddressObject`) and the accumulator ends in `as unknown as MailHeaders` (`mail-parser.ts:598`) | ~31 | Decode each header by name into its exact type once; expose typed fields, not a union-valued Map |
| Splitter emits `any` (`Transform.read()`); the parser re-describes the same `MimeNode` as `SplitterChunk`/`SplitterNode`/`MimeTreeNode` and casts between them | ~16, incl. most `as unknown as` | One typed node tree; no streaming handoff |
| `simple-parser.ts` builds `mail` as a loose record then `as unknown as ParsedMail` ×5 | 5 | Assemble a real `ParsedMail` once |
| `addressparser` typed via a hand-written ambient module although `@types/nodemailer` ships it (`mail-modules.d.ts:40-48`) | 8 | Delete the ambient decl |
| Loose libmime return types, `Buffer\|string` chunk unions, `Error & {code}` | ~12 | Tighten `mail-modules.d.ts`; narrow with `Buffer.isBuffer`; a small typed error |

### 3. The wire contract is much narrower than the type

`Email = ParsedMail & EmailSummary` crosses Eden only from `GET /message/:id` (`messageGet`), with attachment content blanked. Consumed-field verdicts (BE outside the parser, FE, tests):

| Field | Verdict |
|---|---|
| `attachments`, `html`, `text`, `textAsHtml`, `subject`, `date`, `from`, `to`, `cc`, `bcc`, `replyTo`, `messageId`, `inReplyTo`, `references` | Consumed |
| `to`/`cc`/`bcc` as `AddressObject[]` (multiple header lines), `references` as `string \| string[]`, `EmailAddress.group` | Consumed in both shapes by `buildRecipientSummary` (`mailutils.ts:100`) and the FE (`use-mail-actions.ts:350,373`, `addresses.ts:12`). Keep |
| `Attachment.contentType`, `filename`, `content`, `calendarMethod`, `calendarInvite` | Consumed. `content` is always a `Buffer` at runtime, typed `unknown` |
| `AddressObject.text` | Consumed by the FE draft (`use-draft.ts:64,68`) |
| `headers` (Map) | Serializes to `{}`; zero readers. `MailHeaders`/`HeaderValue`/`StructuredHeader`/`HeaderLines` have no usage outside `types/mail.ts` and the parser |
| `headerLines` | Top-level array serialized, never read; `undefined` at runtime on attachments despite the required type. Fabricated as `[] as unknown as Email['headerLines']` in the draft fast-save (`mail-domain.ts:339,352`) |
| `priority` | Never populated (not in the copy list `simple-parser.ts:109-121`); lives only in the Map. The mapping logic runs for nobody |
| `Attachment.checksum`, `size`, `related`, `cid`, `contentId`, `contentDisposition`, `type` | Serialized, never read. `cid`/`related` are needed inside the parser for the cid → data-URI rewrite, not on the output |
| `AddressObject.html` | Never read. `getAddressesHTML` runs on every address header for it |

`mail.db` persists only the `EmailSummary` subset; the full parse is redone from the `.eml` on every detail read. A behaviour-identical rewrite has to reproduce the consumed rows exactly and nothing else.

### 4. Decoding: keep iconv-lite, drop the rest

Verified on Bun 1.3.14: `TextDecoder` handles the CJK multibyte set (`iso-2022-jp`, `shift_jis`, `euc-jp`, `gb18030`, `gbk`, `big5`, `euc-kr`, and `ks_c_5601-1987`) but throws on `windows-1250/1251/1254/1256`, `iso-8859-2/5/15`, `koi8-r` and `macintosh`. Swapping iconv-lite for `TextDecoder` would silently break Cyrillic and Central European mail, so iconv-lite stays for the general case. `encoding-japanese` exists only for the `iso-2022-jp`/`jis`/`eucjp` branch that iconv-lite lacks; `TextDecoder` covers it. Because content is already buffered, transfer decoding is `Buffer.from(str, 'base64')` and `libqp.decode`, charset decoding is `iconv.decode(buf, charset)`, and no Transform subclass is needed. `punycode.js` is replaced by `node:url`'s `domainToUnicode`; `libbase64` by `Buffer`. `libmime` (encoded words, structured header values, RFC 2231 filenames, flowed text, MIME-type detection), `libqp`, `iconv-lite`, `html-to-text`, `linkify-it` + `tlds` and `he` stay.

### 5. No golden contract exists

No `.eml` fixtures and no serialized-output corpus exist; every test builds messages inline. `mail-parser.test.ts` (16 tests) pins the basics, `mail-parser-fuzz.test.ts` pins robustness, and the route-level tests pin round trips. Missing shapes: quoted-printable bodies, encoded-word subjects, `multipart/related` cid inlining, `multipart/alternative`, address groups and multi-line `To:`, `format=flowed`, non-UTF-8 charsets, `message/rfc822` forwards, RFC 2231 filenames.

### 6. Broken windows

Duplicate `'to'` in both header-key copy lists (`simple-parser.ts:113,115`, `mail-parser.ts:972,974`), and that copy loop exists twice. `this as unknown as Record<string, unknown>` (`mail-parser.ts:982`) hoists header fields onto the Transform for nobody. MAIL.md does not say `headers`/`headerLines`/`priority` are wire-dead.

## Decisions

- **Drop streaming.** Buffer in, typed node tree, `ParsedMail` out, synchronous. The sole caller already holds the whole file in memory; the event-loop cost is unchanged.
- **Type the header seam once.** Headers are decoded by name into exact types at parse time; there is no public union-valued Map. `MailHeaders`, `HeaderValue`, `StructuredHeader` and `HeaderLines` leave `packages/lib/src/types/mail.ts`.
- **Shrink the shared types to what is consumed.** `ParsedMail` loses `headers`, `headerLines`, `priority`. `Attachment` becomes `{ contentType, filename?, content: Uint8Array, calendarMethod?, calendarInvite? }`. `AddressObject` loses `html`. Every removed field was verified unread in the FE and BE; no FE file changes.
- **Behaviour otherwise identical**, pinned by the golden corpus: cid images inlined into `html` as data URIs, `to`/`cc`/`bcc` single-or-array by header-line count, `references` split into `<…>`-wrapped strings, `messageId`/`inReplyTo` wrapped, unparseable `Date` falls back to now, CRLF-normalised text, `checkBoundary` semantics from the #14 fix, `MAX_HEAD_SIZE`/`MAX_CHILD_NODES`/`MAX_HTML_TEXT_LENGTH` caps, `detectMimeType` for `application/octet-stream`, `calendarMethod` from `Content-Type; method=`.
- **Dependencies removed**: `encoding-japanese`, `punycode.js`, `libbase64`, and the ambient `nodemailer/lib/addressparser` declaration.

## Plan

| Unit | Content | Gate |
|---|---|---|
| 0 | Golden corpus: ~25 `.eml` files under `apps/api/src/test/fixtures/mail-corpus/` covering every shape in §5 plus the pinned behaviours in Decisions, and `mail-parser-golden.test.ts` that parses each and compares a consumed-field projection (attachment bytes as SHA-256) with a committed `.golden.json`. Goldens generated from the **old** parser | Golden test green on the old parser |
| 1 | New parser in `apps/api/src/lib/mail/mail-parser/` (~540 lines, six files): `parse.ts` (entry + assembly), `split.ts` (non-streaming MIME tree, byte-exact bodies), `headers.ts` (unfold + typed decode), `decode.ts` (transfer + charset + flowed), `html.ts` (htmlToText, textAsHtml linkify, cid inlining), `index.ts` (barrel). Zero `as` casts | Golden test + `mail-parser.test.ts` + fuzz test green on the new parser |
| 2 | Switch the two callers, delete `mail-split/` and the old files, tighten `packages/lib/src/types/mail.ts`, remove the two `as unknown as` draft casts, drop the three dependencies and stale ambient types, update MAIL.md / IMAP.md, remove the ROADMAP row | `bun run check` green |
| 3 | Simplify pass, then a cold Fable review of every touched file | Review clean, `bun run check` green |

## Status (2026-09-02)

Units 0–3 shipped on branch `mail-parser-audit`: two cold reviews (an Opus recall-biased pass on the rewrite, a Fable pre-merge pass over every touched file) and a four-angle simplify pass, all findings applied; the one open item they surfaced, the pre-existing linkify-it quadratic on address-heavy plain text, was closed on 2026-09-02 by the single-pass linkifier in `linkify.ts` (linkify-it and tlds dropped; bare `example.com` is no longer guessed). `bun run check` is green. Two corrections to the audit above surfaced during the build. `Attachment.size` **is** consumed — `apps/mail` `use-draft.ts` reads it for attachment reconciliation — so it stays on the type. Removing `AddressObject.html` needed one-line deletions in `apps/mail`'s `use-draft.ts`/`use-mail-actions.ts` and in `routes/mail.ts`'s `AddressObjectSchema` (the audit predicted no FE changes).

Deliberate behaviour deviations from the old parser, each pinned by the golden corpus:

- inline `message/rfc822` meta table closes its `</td>`/`</table>` tags (upstream typo)
- empty `References:` → `undefined` (was `null`)
- a header block cut short by a boundary line is never a part (old emitted a 0-byte attachment on a closing delimiter)
- a body of exactly one line break is stripped like any other
- a bare-CR closing boundary at EOF with no final LF is recognised
- base64 bodies are decoded by `Buffer` directly (URL-safe `-`/`_` decode as alphabet characters; the old code stripped them)
- QP bodies are decoded from latin1 bytes (old ran a UTF-8 decode first, corrupting raw 8-bit bytes) and raw 8-bit header values are decoded as UTF-8 uniformly
- encoded-word-only group names keep their members
- `method` is read from the first Content-Type header
- `MAX_CHILD_NODES` throws on the 1001st node
