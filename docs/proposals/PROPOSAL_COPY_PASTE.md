# Proposal: Cross-App Copy-Paste System (ECP v2)

## TLDR

Upgrade Eigen's clipboard from a two-type (text/image) system to a multi-type protocol that preserves
structure across all apps. Use HTML attribute smuggling as the universal transport (already proven in
Sheets), add a BroadcastChannel bus for cut coordination and large payloads, and implement cross-app
content converters incrementally. The current system is a solid foundation -- this is an evolution, not
a rewrite.

**As built (v1):** the shipped clipboard -- `EigenClipboardData`, the `data-eigen-clipboard` HTML
marker, the `application/eigen-clipboard` MIME, and the cross-document media re-upload path -- is
documented in [CLIPBOARD.md](../CLIPBOARD.md). Read that first; this proposal only covers what v2 adds
on top, plus the one v1 residual in Phase 0.

## Design rationale

The four arguments the v2 shape rests on:

1. **Three representations per copy.** Every payload carries plain text, visual HTML, and structured
   JSON. Plain text and HTML make Eigen content paste usefully into any external app; the JSON makes
   Eigen-to-Eigen paste lossless. This is what Google Docs, Notion, and Linear do.
2. **HTML attribute smuggling is the universal transport.** Custom MIME types are stripped by the
   system clipboard on the way between browser sessions, and the `web ` MIME prefix is Chromium-only.
   `text/html` carrying a `data-*` attribute survives everywhere. Eigen already does this in the async
   path and in Sheets -- v2 makes every path do it.
3. **BroadcastChannel for cross-tab coordination.** Same-origin, synchronous, purpose-built, and
   unused elsewhere in the codebase, so no conflicts. It carries cut coordination and the >100KB
   payloads that do not belong in an HTML attribute.
4. **A typed content taxonomy, not a bag.** `richtext`, `cells`, `slideobjects`, `image`, `file`,
   `card` cover the current apps; `calendarevent`, `contact`, `chatmessages`, `vectorelements` and
   `chart` are added with the app that needs them. The `EigenStyle` shared style vocabulary from the
   original research is deliberately **not** part of this -- no app produces or consumes it, and the
   HTML preview serves the same purpose with less coupling.

## Known constraints

- **The sheet engine has its own internal clipboard.** `ctx.copyState` (upstream's
  `luckysheet_copy_save`, renamed) handles internal copy/paste separately from the system clipboard.
  It holds **coordinates only** — a sheet id and the copied rectangles; formulas, formatting and
  merge info survive because the paste re-reads the live cells at those coordinates, which is
  exactly why it cannot cross a tab or a login boundary. The eigen clipboard integration sits
  **on top of** it, not inside it. Consequences: the
  `cells` content type carries display values, formatting, merge info and dimensions -- not the
  internal `Cell` state (calculation results, dependency graphs), which is neither serializable nor
  meaningful in another sheet. Formulas travel as strings, with references that will be wrong in a
  different sheet context. Undo behaviour after a paste into Sheets depends on whether the engine's
  paste handler wraps the operation in a single `setContextWithProduce` update -- verify during
  implementation, not design.
- **Sheets-to-Docs table paste is lossy.** Tiptap has `@tiptap/extension-table` configured with
  `resizable: true`, so a pasted sheet table does become a Tiptap table node. But the engine emits
  `<table data-type="sheet-copy-action-table">` with pixel-valued inline styles, which Tiptap's
  resizable column model may not respect; background colours, borders and font formatting survive
  only partially through `transformPastedHTML`; and formula content flattens to display values.
  Acceptable for Phase 2, but document it as lossy rather than promising fidelity.
- **Clipboard permission modes differ per browser.** `navigator.clipboard.write()` may need a
  permission grant on Firefox and only works inside a user gesture on iOS Safari, so the async path
  can fail silently. The sync `copy`-event path is the primary one; the async path exists for
  context-menu and button copies and must keep the `write()` call inside the click handler and show
  a toast on failure. Related, lower-severity: browser extensions (password/clipboard managers) may
  rewrite clipboard contents, so a malformed `data-eigen-clipboard` attribute must degrade to
  "treat as external HTML", never throw. Incognito needs no special handling -- both
  BroadcastChannel and `navigator.clipboard` work there.

Concurrent paste in a collaborative document is not a clipboard concern: each paste is a Yjs
transaction and the CRDT merge resolves it, exactly as it already does for typing.

---

## Integration Proposal

### Phase 0: Add the custom MIME to the async write (S)

Phase 0 as originally written -- make the **sync** path write the HTML-embedded marker -- **shipped**:
`writeEigenClipboard` in `../../packages/lib/src/core/clipboard/clipboard.ts` already writes
`application/eigen-clipboard`, the `data-eigen-clipboard` HTML marker and the plain-text fallback.

What is left is the mirror-image residual on the **async** path (the ROADMAP P2 row):

| File | Change |
|---|---|
| `../../packages/lib/src/core/clipboard/clipboard.ts` | `writeEigenClipboardAsync` writes only `text/html` + `text/plain`. Add an `application/eigen-clipboard` blob to the `ClipboardItem`, matching the sync path. |

The async path is used by Slides' context-menu / button copy
(`../../apps/slides/src/components/slides/editor.tsx`). Without the custom MIME, a same-tab paste has to
fall back to parsing the HTML marker, which is the lossy route -- adding the MIME makes Slides
button-copy lossless. One caveat to check while implementing: browsers reject unrecognised MIME types
in `ClipboardItem` on the async API, so if `application/eigen-clipboard` is refused, keep the write in
a `try`/`catch` and let the existing HTML marker carry the payload.

**Verify:** `bun run typecheck && bun run test`, then a manual Slides copy-then-paste round trip.

---

### Phase 1: Version 2 Protocol (2-3 sessions)

**Goal:** Define the v2 data model, implement the new write/read functions, and migrate all three document apps.

#### 1a. Data Format

**File:** `../../packages/lib/src/types/clipboard.ts`

Add the v2 types alongside v1 (v1 stays for backward-compatible reading):

```typescript
type EigenClipboardSource = {
    app: 'docs' | 'sheets' | 'slides' | 'stickies' | 'chat' | 'calendar' | 'contacts' | 'drive' | 'mail';
    ownerId: string;
    mountId?: string;
    fileId?: string;
    timestamp: number;
    isCut: boolean;
    cutId?: string;
}

type EigenClipboardRichText = {
    kind: 'richtext';
    tiptapJson: object;
    html: string;
    text: string;
    images: Array<{ src: string; sourcePath?: DrivePath; width?: number; height?: number }>;
}

type EigenClipboardCells = {
    kind: 'cells';
    cells: unknown[][]; // sheet cell data (display values + formatting, not internal state)
    rows: Array<{ index: number; height: number }>;
    cols: Array<{ index: number; width: number }>;
    merges: Array<{ r: number; c: number; rs: number; cs: number }>;
    html: string; // the sheet HTML table
    tsv: string;
}

type EigenClipboardSlideObjects = {
    kind: 'slideobjects';
    objects: Array<Record<string, unknown>>; // SlideObject serialization
    html: string;
}

type EigenClipboardImage = {
    kind: 'image';
    src: string;
    sourcePath?: DrivePath;
    width?: number;
    height?: number;
    mimeType: string;
    dataUrl?: string;
}

type EigenClipboardFile = {
    kind: 'file';
    files: Array<{ id: string; name: string; mimeType: string; ownerId: string; mountId: string; size: number; isFolder: boolean }>;
}

type EigenClipboardCard = {
    kind: 'card';
    cards: Array<{ title: string; description: string; color?: string; columnTitle?: string }>;
    html: string;
}

type EigenClipboardContent =
    | EigenClipboardRichText
    | EigenClipboardCells
    | EigenClipboardSlideObjects
    | EigenClipboardImage
    | EigenClipboardFile
    | EigenClipboardCard;

type EigenClipboardPayload = {
    version: 2;
    source: EigenClipboardSource;
    content: EigenClipboardContent[];
    plainText: string;
    htmlPreview: string;
}
```

Types deliberately omitted from Phase 1: `calendarevent`, `contact`, `chatmessages`, `vectorelements`, `chart`.
These are added when the corresponding app integration is built (Phase 3+).

#### 1b. Transport Layer

**File:** `../../packages/lib/src/core/clipboard/clipboard.ts`

Add v2 write/read functions. Keep v1 functions for backward compatibility during migration.

```typescript
export function writeEigenPayload(e: ClipboardEvent, payload: EigenClipboardPayload) {
    const json = JSON.stringify(payload);
    e.clipboardData?.setData(EIGEN_CLIPBOARD_MIME, json);
    const encoded = encodeURIComponent(json);
    const marker = `<span data-eigen-clipboard="${encoded}"></span>`;
    e.clipboardData?.setData('text/html', marker + payload.htmlPreview);
    e.clipboardData?.setData('text/plain', payload.plainText);
}

export async function writeEigenPayloadAsync(payload: EigenClipboardPayload) {
    const json = JSON.stringify(payload);
    const encoded = encodeURIComponent(json);
    const marker = `<span data-eigen-clipboard="${encoded}"></span>`;
    const html = marker + payload.htmlPreview;
    const items: Record<string, Blob> = {
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([payload.plainText], { type: 'text/plain' }),
    };
    try {
        await navigator.clipboard.write([new ClipboardItem(items)]);
    } catch {
        // Async clipboard write failed (permissions denied, not in user gesture, etc.)
        // Caller should handle this gracefully.
        throw new Error('Clipboard write failed. Use Ctrl+C instead.');
    }
}

export function readEigenPayload(clipboardData: DataTransfer): EigenClipboardPayload | null {
    // Try custom MIME first (same-tab)
    const raw = clipboardData.getData(EIGEN_CLIPBOARD_MIME);
    if (raw) {
        const parsed = tryParsePayload(raw);
        if (parsed) return parsed;
    }
    // Try HTML attribute (cross-tab)
    const html = clipboardData.getData('text/html');
    if (html) {
        const match = html.match(/data-eigen-clipboard="([^"]*?)"/);
        if (match?.[1]) {
            try {
                const decoded = decodeURIComponent(match[1]);
                return tryParsePayload(decoded);
            } catch { /* invalid encoding */ }
        }
    }
    return null;
}

function tryParsePayload(raw: string): EigenClipboardPayload | null {
    try {
        const data = JSON.parse(raw);
        if (data.version === 2 && data.source && Array.isArray(data.content)) return data;
        // v1 backward compat: wrap in v2 envelope
        if (data.version === 1 && Array.isArray(data.items)) return upgradeV1ToV2(data);
    } catch { /* invalid JSON */ }
    return null;
}
```

#### 1c. BroadcastChannel Bus

**New file:** `packages/lib/src/core/clipboard/bus.ts`

```typescript
class EigenClipboardBus {
    private channel: BroadcastChannel | null;
    private lastPayload: EigenClipboardPayload | null = null;
    private pendingCut: { cutId: string; cleanup: () => void } | null = null;

    constructor() {
        try {
            this.channel = new BroadcastChannel('eigen-clipboard');
            this.channel.onmessage = this.handleMessage;
        } catch {
            this.channel = null; // BroadcastChannel not available
        }
    }

    broadcast(payload: EigenClipboardPayload) { ... }
    getLastPayload(): EigenClipboardPayload | null { ... }
    registerCut(cutId: string, cleanup: () => void) { ... }
    confirmCut(cutId: string) { ... }
    private handleMessage = (e: MessageEvent) => { ... }
    destroy() { this.channel?.close(); }
}
```

Expose as a singleton via a React context or module-level instance. The bus is instantiated once per tab.

#### 1d. Migrate Apps to v2

**Docs** (`../../apps/docs/src/components/docs/editor.tsx`):
- Copy handler: Extract Tiptap JSON fragment via `editor.state.doc.slice(from, to).toJSON()` for the selection.
  Wrap in `EigenClipboardRichText` content with the existing image extraction. Produce `htmlPreview` via
  `editor.getHTML()` (scoped to selection). Produce `plainText` via `editor.state.doc.textBetween(from, to)`.
- Paste handler: Check for v2 payload first. If `content` contains `richtext`, use `editor.commands.insertContent(tiptapJson)` for lossless paste. If `content` contains `cells`, let Tiptap's built-in
  HTML paste handle it via the `html` field (produces a table node). Fall back to v1 compat, then native paste.

**Slides** (`../../apps/slides/src/components/slides/editor.tsx`):
- Copy handler: Wrap slide objects in `EigenClipboardSlideObjects`. Already serializes full object data in
  `meta` -- restructure into the v2 content type.
- Paste handler: Prefer `slideobjects` content for lossless paste. Accept `richtext` to create a text box.
  Accept `image` for image objects.

**Sheets** (`../../packages/sheet/src/components/Workbook/index.tsx`):
- Copy handler: Wrap the existing sheet HTML table and plain text in `EigenClipboardCells`. Include
  cell data for the selected range (display values + formatting, extracted from the sheet context).
- Paste handler: Prefer `cells` content for lossless paste (feed back into sheet's paste handler).
  Accept `richtext` to extract text into cells.

**File changes summary for Phase 1:**

| File | Action |
|---|---|
| `../../packages/lib/src/types/clipboard.ts` | Add v2 types |
| `../../packages/lib/src/core/clipboard/clipboard.ts` | Add v2 write/read, v1->v2 upgrade, keep v1 functions |
| `packages/lib/src/core/clipboard/bus.ts` | New: BroadcastChannel bus |
| `../../packages/lib/src/core/clipboard/index.ts` | Re-export new functions and bus |
| `../../apps/docs/src/components/docs/editor.tsx` | Migrate copy/paste to v2 |
| `../../apps/slides/src/components/slides/editor.tsx` | Migrate copy/paste to v2 |
| `../../packages/sheet/src/components/Workbook/index.tsx` | Migrate copy/paste to v2 |

---

### Phase 2: Cross-App Content Converters (2-3 sessions)

**Goal:** When pasting cross-app content, convert it intelligently instead of falling back to plain text.

**New files in `packages/lib/src/core/clipboard/converters/`:**

| File | Conversion | Notes |
|---|---|---|
| `cells-to-richtext.ts` | Sheet cells -> Tiptap table JSON | Generate a `{ type: 'table', content: [...rows] }` Tiptap node from the cell matrix. Map cell formatting (bold, italic, color) to Tiptap marks. |
| `richtext-to-cells.ts` | Tiptap table node -> cell matrix | Parse Tiptap table JSON, extract text content per cell. Non-table richtext becomes a single cell. |
| `richtext-to-slideobjects.ts` | Rich text -> slide text box | Extract text, font size, color. Create a text-type slide object. |
| `slideobjects-to-richtext.ts` | Slide objects -> Tiptap content | Text objects become paragraphs. Image objects become inline images. |
| `cells-to-slideobjects.ts` | Sheet cells -> slide table image | Render the HTML table to a text box or image. |

**Changes to paste handlers:**

Each app's paste handler adds a content negotiation step:

```typescript
function handleEigenPaste(payload: EigenClipboardPayload) {
    for (const content of payload.content) {
        if (content.kind === NATIVE_KIND) {
            // Lossless paste
            pasteNative(content);
            return;
        }
    }
    // Cross-app: find best converter
    for (const content of payload.content) {
        const converter = getConverter(content.kind, TARGET_APP);
        if (converter) {
            pasteConverted(converter(content));
            return;
        }
    }
    // Last resort: paste plain text
    pastePlainText(payload.plainText);
}
```

**External content classification** (`packages/lib/src/core/clipboard/classify.ts`):

Add the `classifyPasteContent` function from the research. Start with detecting: eigen data, HTML tables,
rich HTML, plain text, images, TSV, and URLs. Google Docs / Excel / Notion detection are nice-to-have and
can be added iteratively.

---

### Phase 3: Non-Document Apps + Cut + Drag-and-Drop (3-4 sessions)

**Goal:** Clipboard support for remaining apps, cut coordination, drag-and-drop.

#### 3a. Stickies Clipboard

**File:** `../../apps/stickies/src/components/stickies/board.tsx` (or wherever the board-level keyboard handler lives)

- Copy: Serialize selected cards as `EigenClipboardCard`. Plain text = card titles. HTML = card visual.
- Paste: Accept `card` for lossless paste. Accept `richtext` to create a card with description. Accept `cells`
  to create one card per row.
- This is straightforward since stickies uses Yjs and cards are simple data objects.

#### 3b. Chat Clipboard

- Copy: Serialize selected messages as `EigenClipboardChatMessages` (add this type when needed).
- Paste: Accept any content kind, convert to message text. Images -> upload and attach.

#### 3c. Calendar, Contacts, Drive

- Calendar: Copy event as `EigenClipboardCalendarEvent` with iCal fallback.
- Contacts: Copy contact as `EigenClipboardContact` with vCard fallback.
- Drive: Copy file references as `EigenClipboardFile`. Paste file references into folders (move/copy).

#### 3d. Cut Coordination

- Implement the BroadcastChannel cut protocol as designed in the research.
- Add visual "pending cut" state (dashed border / dimmed opacity) to Docs, Slides, Sheets, Stickies.
- Handle the same-tab case (BroadcastChannel does not fire for self-sent messages).

#### 3e. Drag-and-Drop

- Add `dragstart`/`drop` handlers that use the same serialization as clipboard.
- Drive file drag into Docs/Slides/Chat.
- Desktop only (no mobile touch drag).

---

### Phase 4: Polish (1-2 sessions)

- "Paste Special" (Ctrl+Shift+V) dialog.
- Smart URL paste (image URLs become images, YouTube URLs become embeds).
- Clipboard indicator in status bar via BroadcastChannel.
- Async clipboard write failure toast.

---

### Phase 5: Vector + Charts (when those apps ship)

- Add `vectorelements` and `chart` content types.
- Converters between vector elements and slide objects.
- Chart copy with `sourceRef` for live linking.

---

## Migration Path

The migration is non-breaking because:

1. **Phase 0 only adds a MIME type** to the existing `writeEigenClipboardAsync` -- no data model change.
2. **Phase 1 adds v2 alongside v1.** The `readEigenPayload` function includes a `upgradeV1ToV2` path that
   wraps v1 data in a v2 envelope. Old clipboard data written by code not yet migrated will still be readable.
3. **Apps are migrated one at a time.** During migration, one app may write v2 while another still writes v1.
   The read path handles both.
4. **Once all apps are on v2, v1 types and the upgrade function can be removed.**

---

## Testing Strategy

### Unit Tests

**File:** `packages/lib/src/core/clipboard/__tests__/clipboard.test.ts`

- `writeEigenPayload` produces correct `text/html` with embedded JSON.
- `readEigenPayload` parses custom MIME, HTML attribute, and v1 upgrade.
- `tryParsePayload` rejects invalid/malformed JSON.
- Each content converter: cells-to-richtext, richtext-to-cells, etc.
- `EigenClipboardBus`: broadcast, receive, cut registration, cut confirmation.

### Integration Tests

- Copy in Docs, paste in Docs (same tab): lossless richtext round-trip.
- Copy in Sheets, paste in Docs: cells become a Tiptap table.
- Copy in Docs, paste in Slides: richtext becomes a text box.
- Copy in Slides, paste in Docs: slide objects become paragraphs + images.
- Large payload (>100KB): BroadcastChannel bus stores payload, clipboard gets token.

### Manual Testing Checklist

- Cross-tab copy-paste (Docs -> Docs in another tab).
- Cross-app copy-paste (Sheets -> Docs, Docs -> Slides, etc.).
- External paste (from Google Docs, from Excel, from Notion, from plain text editor).
- Paste into external apps (Eigen -> Google Docs, Eigen -> plain text editor).
- Cut from Docs, paste in Slides (verify source content is deleted).
- Clipboard permissions denied in Firefox/Safari (verify graceful fallback).
- Large sheet selection (1000+ cells) copy and paste.
- Undo after paste in each app.
- Mobile paste (iOS Safari, Android Chrome).

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **HTML attribute sanitization differs across browsers.** Some browser versions may strip `data-*` attributes in specific contexts. | Medium | Test on Chrome, Firefox, Safari, Edge. The `data-eigen-clipboard` attribute on `<span>` is safe in all current browsers. If a browser strips it, the content degrades to external HTML paste (not a crash). |
| **Fortune-sheet cell serialization is complex.** The internal Cell type has many fields; deciding which to include in the clipboard is non-trivial. | Medium | Start with display values + basic formatting (bold, italic, color, background, number format, merge). Add more fields as needed. Formulas as strings, with a comment that references will be wrong. |
| **Tiptap `insertContent(tiptapJson)` may not handle all node types from a different document.** Custom extensions (resizable images, comments) in the source doc may not exist in the target. | Low | Tiptap silently drops unknown node types. Comments should be stripped during copy (they are document-specific). Images use the standard `figure` node (`mediaName` attribute), present in all Docs instances. |
| **URI-encoded JSON in HTML attributes could be very large.** | Medium | The 100KB threshold with BroadcastChannel fallback handles this. For cross-browser-session paste of very large payloads, the HTML table/text fallback is lossy but functional. |
| **Async clipboard write fails on iOS Safari outside user gesture.** | Medium | The sync path (`writeEigenPayload` in a `copy` event handler) is the primary path. The async path is only used for context menu buttons. For these, ensure the `navigator.clipboard.write()` call is synchronous within the click handler. Show a toast on failure. |
| **Drag-and-drop does not work on mobile.** | Low | This is a known platform limitation. Document it. Mobile users use copy-paste. |
| **Cut coordination fails if source tab is closed before paste.** | Low | This is acceptable behavior (same as OS file managers). The pasted content is still correct; only the source cleanup is skipped. |
| **BroadcastChannel not available in some contexts (e.g., SharedWorker).** | Very Low | The bus constructor catches the error and sets `channel = null`. All bus methods become no-ops. Cut coordination and large payload transfer degrade gracefully to clipboard-only. |

---

## Timeline Estimate

| Phase | Scope | Effort |
|---|---|---|
| Phase 0 | Custom MIME on the async write | S |
| Phase 1 | v2 protocol + app migration (Docs, Sheets, Slides) | 2-3 sessions |
| Phase 2 | Cross-app converters + external content classification | 2-3 sessions |
| Phase 3 | Non-document apps + cut + drag-and-drop | 3-4 sessions |
| Phase 4 | Polish (Paste Special, smart URL, clipboard indicator) | 1-2 sessions |
| Phase 5 | Vector + chart integration | When those apps ship |

Phases 0 and 1 should be done first and can be shipped independently. Phases 2-4 are incremental
improvements that can be interleaved with other work. Phase 5 is blocked on the vector and chart apps.
