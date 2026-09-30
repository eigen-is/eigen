# Typed Previews: `.vcf`, `.eml`, `.ics`

> **TLDR:** A `.vcf`, an `.eml` and an `.ics` preview as what they hold (contact cards, a message, events), served as a typed JSON payload rather than an HTML body. The builders live in `apps/api/src/lib/preview/{vcard,eml,ics}-preview.ts` and run in the transform Worker. Four things are not obvious: each payload has its own format tag, bumped on every change to its type; the `.eml` payload is where an untrusted message is made safe to render; the client never rewrites the HTML text it renders; and nothing a file points at reaches a card. The shared cache and routes are in [PREVIEWS.md](PREVIEWS.md).

## Three formats preview as what they hold

A `.vcf` is mostly base64 photo, an `.ics` is folded property lines, and an `.eml` is headers, boundaries and base64. None of them reads well as text. So `getBytesTextPreviewMode` answers `null` for all three, and `getPreviewMode` gives each its own mode before it reaches the text rule. That also keeps each path at one cached artifact, which matters because `pruneOldVersions` is not format-scoped.

Search follows the same split. A `.vcf` indexes the names in its cards and an `.ics` its raw body, but an `.eml` is not content-indexed under any mime ([SEARCH.md](SEARCH.md)).

## One pipeline serves all three

| Format | Mode and predicate | Ceiling | Payload | Cache tag |
|---|---|---|---|---|
| `.vcf` | `vcard`, `isVCardFile` | `VCARD_MAX_BYTES` | `VCardPreview` | `VCARD_FORMAT` |
| `.eml` | `eml`, `isEmlFile` | `EML_MAX_BYTES` | `EmlPreview` | `EML_FORMAT` |
| `.ics` | `ics`, `isIcsFile` | `ICS_MAX_BYTES` | `IcsPreview` | `ICS_FORMAT` |

Each format has a Drive route (`/drive/…/file/:pathId/<format>-preview`) and a mail-part route (`/mail/…/attachment/:index/preview/<format>`). One guard runs first: a 400 for a file that isn't the format, a 413 past the ceiling. Drive checks the row before it reads the bytes. A file the parser throws on is a 422, "Could not read this file", never a crash or an empty success. The ceiling is the import's, because the preview parses the whole file the way an import does.

Drive caches the payload per file version through the same `getOrCacheText` the text preview uses, with the same revalidation. A mail part hands its bytes to `getBytes*Preview` and is not cached.

The client reads all six routes through `plainApi` (`packages/lib/src/core/api.ts`). Eden's default reviver would turn a bare `YYYY-MM-DD` birthday, an ISO `date` or an all-day `start` into a `Date` the type does not admit. `PreviewPane` (`packages/ui/src/components/drive/preview-pane.tsx`) is the box all three draw into, with the too-large, loading and unreadable states they share. A query that is still disabled, because the owner is unknown until auth settles, shows the loader and not an error.

## A format tag is bumped on every payload change

A cached payload is JSON this process wrote. Reading it back is a typed assignment that nothing checks. **Change a payload type and bump its tag in `preview-cache.ts`**, or a restored `previewsDir` serves the old shape. The tag is also part of the ETag, so the bump reaches a browser holding the old body. Bump `EML_FORMAT` on every DOMPurify upgrade too: a cached message is HTML the previous sanitizer filtered.

`dropped` means the same in all three payloads: what the parser could not read. What a payload merely does not list is `total - dropped - listed`, which the surface derives. The counted lines under the cards, "and N more" and "N could not be read", come from `remainingLine` and `unreadableLine` in `packages/lib/src/core/transfer.ts`.

## The `.eml` payload is where a message is made safe

The mail parser bounds neither the size of a body nor its references, so the builder does both.

**Size.** `EML_PREVIEW_MAX_HTML_BYTES` (2 MiB) is measured on the sanitizer's input, not its output. A 12 MiB `text/html` part costs 4.4 GB of RSS inside `DOMPurify.sanitize`, which the Worker would pay before an output bound applied. A body over the ceiling is measured again without its inlined `data:` images, since one `cid:` named 200 times is 200 copies. Only a body still over it becomes `null`, so a heavier message never shows less than a lighter one.

**References.** The preview makes no network request when it renders. The rule is an allowlist inside DOMPurify's own DOM, because a regex over serialized HTML would void the sanitizer's output guarantee. On top of the reader's config it forbids `svg`, `math`, media, `picture` and form controls. It removes every URL attribute that is not an inline raster image, since an SVG or HTML `data:` URI is a document of its own. Links keep only `http:`, `https:` and `mailto:`, and open in a new tab.

**CSS** is refused on a token, never on a well-formed `url()` pair. A CSS escape spells `url(` invisibly to a regex (`u\72l(`), and an unterminated `url(` still fetches. The check also reads the text a viewer's color-scheme deletion would leave: removing `@media (prefers-color-scheme: dark){}` from `ur@media …{}l(https://…)` rejoins a `url(`. The hooks are added and removed around one synchronous call, because DOMPurify's hooks are global. `apps/api/src/test/preview/eml-preview.test.ts` is the hostile corpus that pins all of it.

## The client never rewrites the text it renders

`MessageView` (`packages/ui/src/components/mail/message-view.tsx`) draws the header and body for the mail reader and the `.eml` quick look alike, so a saved message reads as the message it was. The body goes into `ShadowContent`'s closed shadow root. It drops the color-scheme rules that disagree with its canvas through the CSSOM, once the sheet is parsed, and never over the text: a text deletion could splice the halves around it into the `url(` the server refused. Search highlights are wrapped on the parsed tree too.

## An `.ics` preview lists masters only

The builder runs the one parser, `parseIcs` ([CALENDAR.md](CALENDAR.md)), on a strict UTF-8 decode. It lists **masters only**: an override and the cancelled row an EXDATE becomes are parts of a series the master's `rrule` already describes. An override whose master the file lacks attaches to nothing a card can show, so it counts as dropped. So does an event dated outside the years 1 to 9999, which `toISOString` would spell as an invalid date.

Nothing in the payload is relative to now, because it is cached per file version. `start` and `end` are strings: an instant, or a bare date with the exclusive end the calendar stores for an all-day event. The quick look and the drive hero turn them into `Date`s where they draw them.

An organizer or attendee is listed only as a plain address. A CAL-ADDRESS is a URI, and the card writes a `mailto:` link from it, so `javascript:…` or an address with a `?` is left out. `EventDetailCard` is the same card the calendar's detail dialog renders, so a file's event reads like a stored one.

## A `.vcf` preview never fetches a photo

The build decodes strict UTF-8 and parses no more cards than an import accepts. A card the parser refuses is counted, not fatal. The first 200 cards are listed. An inline `PHOTO` becomes a `data:` URI; a `PHOTO;VALUE=uri` is dropped rather than fetched, so the file can't make a viewer's browser call a URL it chose.

## See also

- [PREVIEWS.md](PREVIEWS.md): the cache, the routes and the text previews
- [FILE-ACTIONS.md](FILE-ACTIONS.md): the overlay, and the Import to Contacts, Mail and Calendar rows
- [MAIL.md](MAIL.md), [CALENDAR.md](CALENDAR.md), [CONTACTS.md](CONTACTS.md): the parsers and the imports
