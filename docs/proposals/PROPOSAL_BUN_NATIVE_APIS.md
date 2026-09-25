# Proposal: Bun-native APIs in place of npm packages

> **Status: Proposal, written 2026-09-25 against Bun 1.4.2. Nothing here is built.** Eigen already uses Bun natively for most runtime work: `S3Client`, `bun:sqlite` (through `drizzle-orm/bun-sqlite`), `Bun.password`, `Bun.CryptoHasher`, `Bun.Glob`, `Bun.semver`, `Bun.spawn`, `Bun.zstd*Sync` and `bun:test`. This page lists the npm packages and `node:*` usage a Bun built-in could still replace, the ones it cannot, and the 1.4.x features worth using, so the next session starts from findings instead of a new survey.

## What 1.4 added

Most of the big native APIs landed in the 1.3 series and were already in 1.3.14, the version Eigen upgraded from: `Bun.Image` (1.3.14), `Bun.markdown` (1.3.8), `Bun.cron` (1.3.11), `Bun.Archive`, `Bun.Terminal` (1.3.5), `Bun.WebView` (1.3.12), `Bun.JSON5`, `Bun.JSONL`. The only new top-level API in 1.4 is `Bun.XML` (confirmed by diffing the 1.3.14 and 1.4.2 `bun-types`). The rest of 1.4 extends existing surfaces:

- `Bun.serve`: `{ dir }` static directory routes with Range, ETag and 304 handling, and backpressure (1.4.0); HTTP/2 serving (1.4.1). Caddy serves the frontend builds in Eigen, so this has no immediate use.
- `fetch`: a `compress` request option and TLS session resumption (1.4.0); `protocol: "http3"` is experimental.
- `Bun.write()` streams a `Response` or `Request` body to disk (1.4.1).
- `node:crypto` `argon2()` (1.4.1).
- `bun test`: `--parallel`, `--isolate`, `--shard` and `--changed` are stable (1.4.0); `--timings` (1.4.0); the `--isolate` module-graph leak fix (1.4.1) that [TESTING.md](../TESTING.md) relies on.
- `bun install`: `audit fix`, `dedupe`, `prune`, `pm diff`, `pm licenses`, transitive `update`, `add --filter` / `--catalog`, nested overrides (1.4.0); `selfContained`, `--offline` (1.4.1).
- Bundler: React Compiler support, `--asset`, faster code splitting (1.4.0); `--min-chunk-size` (1.4.1).
- 1.4.2 itself is fixes only (CMYK JPEG in `Bun.Image`, an `AsyncLocalStorage` leak, a musl GC crash).

The 1.4 release post also says Bun is now written in Rust and that 1.4 is the first release of it. We have not verified this. If it holds, adopt APIs that are new in 1.4 with more care than usual.

## Candidates

| Bun API | Replaces | Where | Effort | Notes |
|---|---|---|---|---|
| `Bun.XML` (1.4.0) | `fast-xml-parser` | 5 backend files, e.g. `apps/api/src/lib/webdav/propfind.ts`, `apps/api/src/lib/carddav/xml-parser.ts` | M | Removes a backend dependency. Attributes come out as `@name` keys, and WebDAV/CardDAV lean on XML namespaces, so every parser and its tests change. Check namespace handling against the DAV test suites before starting. |
| `Bun.markdown` (1.3.8) | `markdown-it` | `apps/api/src/lib/preview/text-preview.ts` | S | Its HTML output is not sanitized; route it through the existing DOMPurify path. The `apps/index` build (`scripts/lib/render-markdown.ts`) also uses `markdown-it-anchor` for heading ids, so that side needs its own heading-id pass or stays on markdown-it. |
| `Bun.cron` (1.3.11) | the `setInterval` wrapper | `apps/api/src/lib/scheduler/scheduler.ts` | S | Only when a job needs a wall-clock schedule ("03:00 UTC daily"); the file's header already says so. Jobs never overlap, and there is a `tz` option. |
| `Bun.YAML` | `gray-matter` | `apps/index/scripts/lib/frontmatter.ts` | S | Build tooling only: split the frontmatter block and parse it with `Bun.YAML`. |
| `Bun.CryptoHasher` | `node:crypto` `createHash` | `apps/api/src/lib/setup/setup-token.ts`, `apps/api/src/lib/storage/s3-storage.ts` | S | Consistency with the rest of the backend, which already hashes through `Bun.CryptoHasher`. |

## Not yet

- **`Bun.Image` in place of `sharp` + `heic-convert`** (`apps/api/src/lib/shared/thumbnail-worker.ts`). HEIC, AVIF and TIFF decode only on macOS and Windows, and production runs Linux, so `heic-convert` stays regardless. The API landed in 1.3.14 and is young. Dropping sharp's native dependency is attractive; it needs a spike first that runs our thumbnail fixtures through `Bun.Image` inside the `oven/bun` image.
- **`Bun.Archive` for backups.** [BACKUP.md](../BACKUP.md) rules it out: it buffers the whole archive in memory and mangles non-ASCII names, so `apps/api/src/lib/backup/archive.ts` keeps its streaming tar over `node:zlib` zstd. Those findings were measured on 1.3.14. The buffering is a design choice, so re-checking the name bug on 1.4.2 would not change the decision.
- **`HTMLRewriter` in place of `jsdom`.** It only does streaming rewrites; the vector export (`apps/api/src/lib/export/vector/transform.ts`) and the docx import (`apps/api/src/lib/import/doc/from-docx.ts`) need a DOM.
- **`Bun.WebView` in place of Playwright** for [VERIFICATION.md](../VERIFICATION.md). On Linux it drives an installed Chrome anyway, and Playwright's multi-context API is what the E2E collab suite needs.

## No Bun equivalent

- `nodemailer`: Bun has no SMTP or mail API.
- `he`: only `he.decode` is used (`apps/api/src/lib/import/sheets/from-xlsx.ts`); `Bun.escapeHTML` escapes but does not decode.
- `jszip`: `Bun.Archive` handles tar, not zip.
- `exiftool-vendored`, `iconv-lite`, `libmime`, `libqp`, `html-to-text`, `isomorphic-dompurify`, `exceljs`, `mammoth`, `ical.js`, `rrule`: domain libraries.
- Browser-side packages (`nanoid`, `uuid`, `dayjs`, `numeral`, `es-toolkit`) cannot use Bun runtime APIs. The shared `escapeHtml` in `packages/lib/src/core/html.ts` runs on both sides, so it cannot switch to `Bun.escapeHTML`.

## Tooling

- `bun install` catalogs: the root `package.json` has none. A catalog would keep shared versions (React, Yjs, Tiptap, types) aligned across the workspaces.
- `bun pm licenses` and `bun audit fix` for release hygiene.
- `bun test --timings` to find the slow API test files.

## Order

`Bun.XML` first (removes a backend dependency, needs care with namespaces), then `Bun.markdown` for the API text preview, then the `Bun.Image` spike on Linux. The small consistency swaps (`createHash`, `gray-matter`) can ride along with any change that touches those files.
