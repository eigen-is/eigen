# Proposal: Cross-App Copy-Paste System (ECP v2)

## TLDR

Upgrade Eigen's clipboard from a two-type (text/image) system to a multi-type protocol that preserves
structure across all apps. Use HTML attribute smuggling as the universal transport (already proven in
Sheets), add a BroadcastChannel bus for cut coordination and large payloads, and implement cross-app
content converters incrementally. The current system is a solid foundation -- this is an evolution, not
a rewrite.

---

## Summary of Research Findings

The research document (`docs/RESEARCH_COPY_PASTE.md`) covers clipboard APIs, competitor analysis, a proposed
data format, cross-app mapping, cut coordination, drag-and-drop, mobile considerations, and edge cases. Key
findings:

1. **The current system works but is inconsistent.** Docs uses the sync-only custom MIME path (data lost on
   cross-tab). Sheets correctly writes both custom MIME and HTML-embedded marker. Slides uses async for
   context menu, sync for Ctrl+C. Only Sheets cross-tab actually works reliably.

2. **HTML attribute smuggling is the correct universal transport.** Custom MIME types are stripped by the
   system clipboard. The `web ` prefix (Chromium-only) is not cross-browser. `text/html` with a `data-*`
   attribute survives everywhere. This is what Google Docs, Notion, and Linear do. Eigen already does this
   in the async path and in Sheets -- it just needs to do it consistently.

3. **BroadcastChannel is the right tool for cross-tab coordination.** It is same-origin, synchronous, and
   purpose-built. No existing BroadcastChannel usage in the codebase, so no conflicts.

4. **The proposed content type taxonomy is sound.** `richtext`, `cells`, `slideobjects`, `image`, `file`,
   `card`, `calendarevent`, `contact`, `chatmessages` cover all current and planned apps. The `vectorelements`
   and `chart` types are forward-looking but well-scoped.

5. **Fortune-sheet has its own internal clipboard.** It uses `luckysheet_copy_save` in the context object for
   internal copy/paste (which preserves formulas, formatting, merge info). This is separate from the system
   clipboard. The eigen clipboard integration sits on top, not inside fortune-sheet.

6. **Tiptap already supports table nodes.** The Docs editor has `@tiptap/extension-table` configured with
   `resizable: true`. Pasting an HTML table from Sheets into Docs via the standard Tiptap paste path will
   produce a Tiptap table node -- this has been verified by the extension setup in `editor.tsx`.

---

## Critical Evaluation

### What the Research Gets Right

- The three-representation strategy (plain text, visual HTML, structured JSON) is exactly correct and matches
  industry practice.
- The phased approach is sensible. Phase 0 (fix cross-tab consistency) is genuinely a one-line change.
- The BroadcastChannel cut coordination design is simple and correct.
- The edge case analysis (large payloads, sanitized HTML, clipboard permissions) is thorough.

### Where the Research Has Blind Spots or Oversells

1. **Sheets-to-Docs table paste is not as clean as implied.** The research assumes fortune-sheet's HTML table
   output will paste cleanly into Tiptap. In reality, fortune-sheet generates a `<table data-type="fortune-copy-action-table">` with inline styles for dimensions. Tiptap's table extension will parse this, but cell
   widths expressed in pixels may not respect Tiptap's resizable column model. Styling (background colors,
   borders, font formatting) will be partially preserved through `transformPastedHTML`, but formula content
   will be flattened to display values. This is acceptable for Phase 2 but should be documented as lossy.

2. **The `EigenStyle` shared vocabulary (Strategy 2) is overengineered for the current need.** No app
   currently produces or consumes this abstraction. The HTML preview serves the same purpose with less
   coupling. Recommendation: drop `EigenStyle` from the proposal. If a shared style vocabulary is needed
   later, it can be added as a concern of individual converters.

3. **Undo after cross-app paste is trickier than stated.** The research correctly notes that Tiptap uses
   `editor.chain()...run()` for atomic undo. But for Sheets, fortune-sheet's undo stack is managed internally
   through `setContextWithProduce`. Pasting eigen data into Sheets currently creates a synthetic paste event
   that goes through fortune-sheet's paste handler -- the undo behavior depends on whether that handler wraps
   the operation in a single context update. This needs verification during implementation, not design.

4. **The `cells` content type proposes including the full `CellMatrix`.** Fortune-sheet's Cell type contains
   internal state (calculation results, dependency graphs) that is not serializable or meaningful outside the
   source sheet. The clipboard should include: display values, formatting (bold, italic, color, background,
   borders, number format), merge info, and column/row dimensions. Formulas should be included as strings
   but with the understanding that cell references will be wrong in a different sheet context.

5. **The research does not address clipboard permissions being denied.** On Firefox, `navigator.clipboard.write()`
   may require a permission grant. On iOS Safari, it only works inside a user gesture. The async path
   (`writeEigenClipboardAsync`) could fail silently. The proposal should specify fallback behavior: if the
   async write fails, show a toast telling the user to use Ctrl+C instead.

6. **Incognito mode and private browsing.** BroadcastChannel works in incognito (same-origin, same profile).
   `navigator.clipboard` works in incognito. No special handling needed.

7. **Browser extensions intercepting clipboard.** Extensions like password managers or clipboard managers may
   modify clipboard contents. The `data-eigen-clipboard` attribute is unlikely to be targeted, but the read
   path should gracefully degrade to treating the content as external HTML if the attribute is malformed.

8. **Very large clipboard payloads (10,000+ cells).** The research proposes a 100KB threshold for the
   token+bus approach. This is reasonable. A 10,000-cell range with formatting could easily be 500KB+
   of JSON, which URI-encoded would be 1.5MB+ in an HTML attribute. The BroadcastChannel in-memory path
   handles this. For cross-session (clipboard read from a fresh tab), the HTML preview (the actual table
   HTML) is the fallback -- it is lossy but functional.

9. **Concurrent paste in collaborative editing.** Two users pasting simultaneously into the same Yjs document
   is handled by Yjs's CRDT merge -- each paste creates a Yjs transaction, and Yjs resolves conflicts at the
   character/node level. This is not a clipboard concern; it is a Yjs concern, and it already works for
   regular typing. For fortune-sheet (which is also Yjs-backed), the same applies.

---

## Integration Proposal

### Phase 0: Fix Cross-Tab Consistency (1 session)

**Goal:** Make the sync clipboard path write HTML-embedded data, so cross-tab works for Docs and Slides.

**Changes:**

| File | Change |
|---|---|
| `packages/lib/src/core/clipboard/clipboard.ts` | In `writeEigenClipboard()`, add `text/html` write with embedded JSON attribute. Accept optional `html` parameter for the visible HTML representation. |

**Implementation:**

In `writeEigenClipboard`, after the existing custom MIME write, add:

```typescript
export function writeEigenClipboard(e: ClipboardEvent, data: EigenClipboardData, plainText?: string, html?: string) {
    e.clipboardData?.setData(EIGEN_CLIPBOARD_MIME, JSON.stringify(data));
    const encoded = encodeURIComponent(JSON.stringify(data));
    const marker = `<span data-eigen-clipboard="${encoded}"></span>`;
    e.clipboardData?.setData('text/html', html ? marker + html : marker);
    if (plainText) {
        e.clipboardData?.setData('text/plain', plainText);
    }
}
```

No changes needed in any app code -- the existing Docs and Slides copy handlers call `writeEigenClipboard`
and will now automatically produce cross-tab-safe clipboard data. The read path (`readEigenClipboard`)
already handles the HTML attribute fallback.

**Verify:** `bun run typecheck && bun run test`

---

### Phase 1: Version 2 Protocol (2-3 sessions)

**Goal:** Define the v2 data model, implement the new write/read functions, and migrate all three document apps.

#### 1a. Data Format

**File:** `packages/lib/src/types/clipboard.ts`

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
    cells: unknown[][]; // fortune-sheet cell data (display values + formatting, not internal state)
    rows: Array<{ index: number; height: number }>;
    cols: Array<{ index: number; width: number }>;
    merges: Array<{ r: number; c: number; rs: number; cs: number }>;
    html: string; // the fortune-sheet HTML table
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

**File:** `packages/lib/src/core/clipboard/clipboard.ts`

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

**Docs** (`apps/docs/src/components/docs/editor.tsx`):
- Copy handler: Extract Tiptap JSON fragment via `editor.state.doc.slice(from, to).toJSON()` for the selection.
  Wrap in `EigenClipboardRichText` content with the existing image extraction. Produce `htmlPreview` via
  `editor.getHTML()` (scoped to selection). Produce `plainText` via `editor.state.doc.textBetween(from, to)`.
- Paste handler: Check for v2 payload first. If `content` contains `richtext`, use `editor.commands.insertContent(tiptapJson)` for lossless paste. If `content` contains `cells`, let Tiptap's built-in
  HTML paste handle it via the `html` field (produces a table node). Fall back to v1 compat, then native paste.

**Slides** (`apps/slides/src/components/slides/editor.tsx`):
- Copy handler: Wrap slide objects in `EigenClipboardSlideObjects`. Already serializes full object data in
  `meta` -- restructure into the v2 content type.
- Paste handler: Prefer `slideobjects` content for lossless paste. Accept `richtext` to create a text box.
  Accept `image` for image objects.

**Sheets** (`packages/fortune-sheet/src/components/Workbook/index.tsx`):
- Copy handler: Wrap the existing fortune-sheet HTML table and plain text in `EigenClipboardCells`. Include
  cell data for the selected range (display values + formatting, extracted from the sheet context).
- Paste handler: Prefer `cells` content for lossless paste (feed back into fortune-sheet's paste handler).
  Accept `richtext` to extract text into cells.

**File changes summary for Phase 1:**

| File | Action |
|---|---|
| `packages/lib/src/types/clipboard.ts` | Add v2 types |
| `packages/lib/src/core/clipboard/clipboard.ts` | Add v2 write/read, v1->v2 upgrade, keep v1 functions |
| `packages/lib/src/core/clipboard/bus.ts` | New: BroadcastChannel bus |
| `packages/lib/src/core/clipboard/index.ts` | Re-export new functions and bus |
| `apps/docs/src/components/docs/editor.tsx` | Migrate copy/paste to v2 |
| `apps/slides/src/components/slides/editor.tsx` | Migrate copy/paste to v2 |
| `packages/fortune-sheet/src/components/Workbook/index.tsx` | Migrate copy/paste to v2 |

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

**File:** `apps/stickies/src/components/stickies/board.tsx` (or wherever the board-level keyboard handler lives)

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

1. **Phase 0 only adds behavior** to the existing `writeEigenClipboard` -- no data model change.
2. **Phase 1 adds v2 alongside v1.** The `readEigenPayload` function includes a `upgradeV1ToV2` path that
   wraps v1 data in a v2 envelope. Old clipboard data written by code not yet migrated will still be readable.
3. **Apps are migrated one at a time.** During migration, one app may write v2 while another still writes v1.
   The read path handles both.
4. **Once all apps are on v2, v1 types and the upgrade function can be removed.** Since data is throwaway
   during dev (per CLAUDE.md), there is no need for long-term v1 support.

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
| **Tiptap `insertContent(tiptapJson)` may not handle all node types from a different document.** Custom extensions (resizable images, comments) in the source doc may not exist in the target. | Low | Tiptap silently drops unknown node types. Comments should be stripped during copy (they are document-specific). Images use the standard resizableImage extension which is present in all Docs instances. |
| **URI-encoded JSON in HTML attributes could be very large.** | Medium | The 100KB threshold with BroadcastChannel fallback handles this. For cross-browser-session paste of very large payloads, the HTML table/text fallback is lossy but functional. |
| **Async clipboard write fails on iOS Safari outside user gesture.** | Medium | The sync path (`writeEigenPayload` in a `copy` event handler) is the primary path. The async path is only used for context menu buttons. For these, ensure the `navigator.clipboard.write()` call is synchronous within the click handler. Show a toast on failure. |
| **Drag-and-drop does not work on mobile.** | Low | This is a known platform limitation. Document it. Mobile users use copy-paste. |
| **Cut coordination fails if source tab is closed before paste.** | Low | This is acceptable behavior (same as OS file managers). The pasted content is still correct; only the source cleanup is skipped. |
| **BroadcastChannel not available in some contexts (e.g., SharedWorker).** | Very Low | The bus constructor catches the error and sets `channel = null`. All bus methods become no-ops. Cut coordination and large payload transfer degrade gracefully to clipboard-only. |

---

## Timeline Estimate

| Phase | Scope | Effort |
|---|---|---|
| Phase 0 | Fix cross-tab consistency | 1 session |
| Phase 1 | v2 protocol + app migration (Docs, Sheets, Slides) | 2-3 sessions |
| Phase 2 | Cross-app converters + external content classification | 2-3 sessions |
| Phase 3 | Non-document apps + cut + drag-and-drop | 3-4 sessions |
| Phase 4 | Polish (Paste Special, smart URL, clipboard indicator) | 1-2 sessions |
| Phase 5 | Vector + chart integration | When those apps ship |

Phases 0 and 1 should be done first and can be shipped independently. Phases 2-4 are incremental
improvements that can be interleaved with other work. Phase 5 is blocked on the vector and chart apps.
