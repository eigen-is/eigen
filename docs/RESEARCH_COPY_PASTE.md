# Research: Cross-App Copy-Paste System for Eigen

> Deep research into building a robust, cross-app, cross-browser clipboard system that works seamlessly within Eigen
> and gracefully with external applications.

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Technical Deep Dive: Clipboard APIs](#technical-deep-dive-clipboard-apis)
3. [How Other Products Solve This](#how-other-products-solve-this)
4. [Proposed Architecture: Eigen Clipboard Protocol (ECP)](#proposed-architecture-eigen-clipboard-protocol-ecp)
5. [Data Format Specification](#data-format-specification)
6. [Cross-App Content Mapping Table](#cross-app-content-mapping-table)
7. [Cross-Tab Communication](#cross-tab-communication)
8. [Layout Preservation Strategy](#layout-preservation-strategy)
9. [Inbound Paste: External Content into Eigen](#inbound-paste-external-content-into-eigen)
10. [Cut Operations and Cleanup](#cut-operations-and-cleanup)
11. [Drag-and-Drop Integration](#drag-and-drop-integration)
12. [Mobile and Touch Considerations](#mobile-and-touch-considerations)
13. [Edge Cases and Fallbacks](#edge-cases-and-fallbacks)
14. [Cross-Cutting Concerns](#cross-cutting-concerns)
15. [Implementation Phases](#implementation-phases)

---

## Current State Analysis

### What Exists Today

Eigen already has a clipboard system (`packages/lib/src/core/clipboard/`) that handles basic inter-app copy-paste. It
works, but has significant limitations.

**Current data model** (`packages/lib/src/types/clipboard.ts`):

```typescript
type EigenClipboardItem =
    | { type: 'text'; text: string; meta?: Record<string, unknown> }
    | { type: 'image'; src: string; sourcePath?: DrivePath; meta?: Record<string, unknown> };

type EigenClipboardData = { version: 1; items: EigenClipboardItem[] }
```

**Current transport mechanism** (`packages/lib/src/core/clipboard/clipboard.ts`):

- Sync path (during `copy` event): Sets `application/eigen-clipboard` custom MIME + `text/plain` fallback on
  `ClipboardEvent.clipboardData`. Does NOT write `text/html`, so the eigen data only survives within the same
  browsing context (custom MIME types are stripped on cross-tab/cross-app clipboard reads).
- Async path (button click): Encodes JSON in a `data-eigen-clipboard` HTML attribute, writes as `text/html` blob via
  `navigator.clipboard.write()`. This is the only path that survives cross-tab.
- Read path: Checks for custom MIME first, then parses HTML attribute fallback
- Sheets have a hybrid: the `copy` event handler in Workbook writes both the custom MIME AND an HTML-embedded eigen
  marker alongside the fortune-sheet HTML table (`fortune-copy-action-table`), so sheets data survives cross-tab.

### Per-App Clipboard Usage

| App | Copy | Paste | Format | Notes |
|---|---|---|---|---|
| **Docs** (Tiptap) | Extracts images + text from ProseMirror selection, writes `EigenClipboardData` via custom MIME only (sync path, no HTML smuggling) | Reads eigen data for images, delegates rich text to Tiptap's built-in paste. Also handles `transformPastedHTML` to clamp oversized images/tables. | Images only get eigen treatment; text uses native HTML paste | Eigen data lost on cross-tab because sync path does not write HTML. No structured doc JSON in eigen format. |
| **Slides** | Serializes `SlideObject` (position, style, content) into `EigenClipboardItem` with full `meta`. Uses sync path for Ctrl+C, async path (`writeEigenClipboardAsync`) for context menu copy. | Reconstructs slide objects from eigen data, re-uploads images across docs. Falls back to plain text as new text object. | Full round-trip for slide objects | Best current implementation. Only app that uses both sync and async write paths. |
| **Sheets** (fortune-sheet) | Generates HTML table (`fortune-copy-action-table`), prepends eigen marker span, writes both custom MIME and HTML-embedded marker | Checks for eigen data from other apps, extracts text, creates synthetic paste event for fortune-sheet processing | Lossy: other apps' rich data reduced to plain text | Fortune-sheet has its own internal clipboard (`luckysheet_copy_save`). Cross-tab works because of HTML embedding. |
| **Stickies** | No clipboard handling | No clipboard handling | N/A | Has dnd-kit drag-and-drop for internal card/column reordering, but no system clipboard integration |
| **Chat** | No clipboard handling | No clipboard handling | N/A | Missing entirely |
| **Drive** | No clipboard handling | No clipboard handling | N/A | No file copy/paste via clipboard (only UI buttons for move/copy) |

### Identified Gaps

1. **Only two content types** (`text` and `image`). No support for tables, cell ranges, slide objects, kanban cards,
   calendar events, contacts, or rich formatted text.
2. **No structured rich text**. When copying from Docs, the Tiptap/ProseMirror JSON is not included in the eigen
   clipboard. Pasting rich text into Slides loses all formatting.
3. **Sheets are isolated**. Fortune-sheet has its own internal clipboard system that does not participate in the eigen
   protocol. Copying cells from Sheets into Docs produces plain text, not a table.
4. **No cut support**. The current system only handles copy. There is no mechanism to notify the source app that a cut
   was completed so it can clean up.
5. **No cross-tab awareness**. Each browser tab handles clipboard independently. There is no BroadcastChannel or shared
   state for cut coordination.
6. **Drag-and-drop is image-only**. Docs and Slides handle dropped image files, but there is no cross-app drag (e.g.
   dragging a card from Stickies into a Doc).
7. **No smart external paste**. External HTML pasted into Sheets is handled by fortune-sheet's parser. External content
   into Slides becomes a raw text box with no intelligence.
8. **The HTML-attribute encoding is fragile**. URI-encoding JSON into an HTML attribute works but is size-limited and
   requires regex parsing. Large payloads (e.g. a 50-cell sheet range) could exceed practical limits.
9. **Inconsistent cross-tab behavior**. Docs uses the sync-only path (custom MIME, no HTML smuggling), so eigen data
   is lost when pasting across tabs. Sheets correctly writes both custom MIME and HTML-embedded marker. Slides uses
   async path for context menu copy (which does HTML smuggling) but sync-only for Ctrl+C. This inconsistency means
   cross-tab copy-paste works in some apps but not others.
10. **No Drive file clipboard**. Cannot Ctrl+C files in Drive and paste them elsewhere (into another folder, into a doc
    as a link, into chat as an attachment).

---

## Technical Deep Dive: Clipboard APIs

### The Three Clipboard Surfaces

The browser provides three separate mechanisms. A robust system must use all of them.

#### 1. ClipboardEvent (synchronous, in event handler)

```typescript
document.addEventListener('copy', (e: ClipboardEvent) => {
    e.preventDefault();
    e.clipboardData!.setData('text/plain', 'hello');
    e.clipboardData!.setData('text/html', '<b>hello</b>');
    e.clipboardData!.setData('application/x-eigen', '{"type":"..."}');
});
```

**Capabilities**: Can set *any* MIME type string. The browser does not filter or sanitize custom MIME types set during
a `copy`/`cut` event. The data is available when pasting in the *same browsing context*.

**Limitation**: Custom MIME types (like `application/x-eigen`) do NOT survive cross-browser-tab or cross-application
clipboard reads. Only `text/plain`, `text/html`, and `image/png` survive the system clipboard round-trip.

#### 2. Async Clipboard API (navigator.clipboard)

```typescript
await navigator.clipboard.write([
    new ClipboardItem({
        'text/plain': new Blob(['hello'], { type: 'text/plain' }),
        'text/html': new Blob(['<b>hello</b>'], { type: 'text/html' }),
    })
]);
```

**Capabilities**: Works outside of clipboard events (button clicks, etc.). Returns a Promise. Supports `text/plain`,
`text/html`, `image/png`, and (in Chromium) `image/svg+xml`.

**Limitation**: Only "well-known" MIME types are allowed. Custom MIME types are rejected. Requires secure context
(HTTPS) and user permission/activation.

**`ClipboardItem.supports(mime)`**: Static method to check if a MIME type is writable. Use before attempting custom
types.

#### 3. Web Custom Formats (Chromium-only, as of mid-2025)

Chromium introduced a mechanism for custom clipboard formats using a `"web "` prefix:

```typescript
await navigator.clipboard.write([
    new ClipboardItem({
        'text/plain': new Blob(['hello'], { type: 'text/plain' }),
        'web application/x-eigen': new Blob([jsonStr], { type: 'application/x-eigen' }),
    })
]);

// Reading:
const items = await navigator.clipboard.read({ unsanitized: ['web application/x-eigen'] });
for (const item of items) {
    if (item.types.includes('web application/x-eigen')) {
        const blob = await item.getType('web application/x-eigen');
        const json = await blob.text();
    }
}
```

**Status**: Available in Chrome/Edge 120+. Firefox has been implementing the Async Clipboard API with custom format
support (behind flags as of Firefox 127+). Safari has partial support for the Async Clipboard API but does not support
`web ` custom formats. The `unsanitized` option in `read()` is Chromium-only.

**Implication**: This is the ideal long-term mechanism for Eigen-to-Eigen clipboard, but cannot be the only path.
The HTML smuggling technique remains the universal fallback. Check support at runtime:

```typescript
const supportsWebCustom = (() => {
    try { return typeof ClipboardItem !== 'undefined' && ClipboardItem.supports?.('web text/plain'); }
    catch { return false; }
})();
```

### MIME Type Survival Matrix

| Write method | `text/plain` | `text/html` | `image/png` | Custom MIME | `web ` custom | Cross-tab | Cross-app |
|---|---|---|---|---|---|---|---|
| `e.clipboardData.setData()` | Survives | Survives | N/A | Same-tab only | N/A | Partially | No |
| `navigator.clipboard.write()` | Survives | Survives | Survives | Rejected | Chromium only | Yes | Partial |
| System clipboard (native app) | Yes | Yes | Yes | No | No | Yes | Yes |

### The HTML Smuggling Technique

Since `text/html` survives all clipboard paths, the most reliable way to transport structured data through the
clipboard is to embed it in HTML. This is what Eigen already does (and what Google Docs does):

1. Encode structured data as a JSON string
2. Embed it in an HTML element attribute: `<span data-eigen="...encoded...">`
3. Append it to (or wrap it around) the visible HTML representation
4. On paste, check for the attribute first; if found, use structured data; otherwise fall back to HTML parsing

**Pitfall**: Browsers may sanitize HTML during clipboard round-trips. Attributes on `<meta>`, `<script>`, `<style>` are
stripped. Data attributes on `<span>`, `<div>` generally survive in all major browsers. The `data-*` attribute
convention is safe.

**Size considerations**: A URI-encoded JSON payload in an attribute can get large. For a 100x20 sheet range with
formatting, the JSON could be 50-100KB. URI-encoding inflates size by ~3x for non-ASCII characters. In practice,
browsers handle multi-MB `text/html` clipboard payloads without issue (Google Sheets regularly produces 200KB+ HTML
for large selections). For Eigen, the BroadcastChannel in-memory path handles the largest payloads, with the HTML
attribute as a cross-tab/cross-browser fallback for smaller ones. For payloads over 100KB, use the token + bus
approach described in Edge Cases.

---

## How Other Products Solve This

### Google Workspace (Docs/Sheets/Slides)

Google uses a multi-representation clipboard strategy:

- **`text/plain`**: Plain text fallback
- **`text/html`**: Rich HTML with embedded metadata. Google Docs uses a hidden `<b>` tag with a
  `id="docs-internal-guid-..."` attribute. Google Sheets generates a full HTML table with inline styles. Google Slides
  generates HTML with layout metadata.
- **Internal clipboard**: Within the same Google app session, a JavaScript object is kept in memory (not on the system
  clipboard). This is used for the "smart" internal paste that preserves all formatting, formulas, etc.
- **Cross-app (Sheets to Docs)**: The HTML table from Sheets is pasted into Docs as an HTML table. Docs recognizes
  the Google-specific attributes and reconstructs a Docs-native table with preserved column widths, cell styles, etc.
- **Cross-app (Docs to Slides)**: Rich text HTML is pasted into a Slides text box. Images are re-uploaded.

Key insight: Google relies on **HTML as the universal interchange format** between its apps, with app-specific JSON
metadata baked into the HTML for lossless reconstruction within the ecosystem. External apps get the HTML and it looks
reasonable. Internal apps get the metadata and it is perfect.

### Notion

Notion uses a similar approach:

- Copies produce `text/html` with Notion-specific data attributes on block elements
- Each block carries a `data-block-id` attribute
- Notion also sets `text/plain` with Markdown-formatted content (a nice touch)
- Cross-page paste within Notion uses the block IDs to do a server-side block copy (deep copy with sub-blocks)
- External paste into Notion runs an HTML-to-blocks parser that converts standard HTML elements into Notion blocks
- External paste of Markdown is detected and parsed via a Markdown-to-blocks converter

Key insight: Notion's **Markdown fallback for plain text** is clever. When a user pastes Notion content into a plain
text editor, they get clean Markdown rather than stripped HTML. Eigen should adopt this: use Tiptap's built-in
Markdown serialization (or a lightweight converter) to produce clean Markdown for the `text/plain` representation
of rich text content. This is especially natural since Eigen Chat already uses Markdown for message formatting.

### Figma

Figma faces the hardest challenge: its content (vector graphics, layouts, components) has no standard HTML equivalent.

- Figma encodes selected objects as a proprietary binary format
- On copy, it writes: `text/html` (a PNG preview image as `<img>` tag), plus a custom format using the
  `web ` prefix (in Chromium) or an IndexedDB-backed fallback
- Cross-tab paste (Figma to Figma) uses the `web ` custom format or falls back to reading from the Figma server
  (objects are temporarily stored server-side with a clipboard token)
- External paste produces just the PNG preview image

Key insight: Figma's **server-side clipboard buffer** is an interesting fallback for when browser APIs are insufficient.
For Eigen, this could be an API endpoint that temporarily stores clipboard data, keyed by a token embedded in the HTML.

### Linear, Coda, Airtable

These products follow the same general pattern:

- Rich HTML with embedded metadata attributes
- Plain text fallback (often Markdown)
- Internal paste uses in-memory JavaScript objects
- Cross-tab uses HTML attribute smuggling

---

## Proposed Architecture: Eigen Clipboard Protocol (ECP)

### Design Principles

1. **Three representations, always**: Every clipboard write includes `text/plain`, `text/html` (visually accurate),
   and eigen structured data (embedded in HTML or via web custom format)
2. **HTML is the interchange format**: The HTML representation should be high-quality enough that pasting into external
   apps produces reasonable results
3. **Structured data is the internal format**: When pasting within Eigen, the structured data takes priority and
   enables lossless reconstruction
4. **Progressive enhancement**: Use `web ` custom formats when available, fall back to HTML attribute embedding
5. **Source-aware paste**: The receiver knows what app produced the content and can make intelligent conversion decisions
6. **Cut coordination via BroadcastChannel**: Cut operations notify the source tab to clean up after successful paste

### System Overview

```
                                    COPY
                                      |
                            +---------+---------+
                            |                   |
                      App Serializer       App Serializer
                      (per-app logic)      (per-app logic)
                            |                   |
                            v                   v
                     EigenClipboardPayload (unified format)
                            |
                    +-------+-------+
                    |       |       |
                text/plain  |   text/html
                (markdown)  |   (visual + embedded JSON)
                            |
                   web application/x-eigen
                   (structured, Chromium only)
                            |
                     System Clipboard
                            |
                                    PASTE
                                      |
                            +---------+---------+
                            |                   |
                    Read web custom      Read text/html
                    format (ideal)       (universal fallback)
                            |                   |
                            v                   v
                    EigenClipboardPayload  <-- parse embedded JSON
                            |                   |
                            +---------+---------+
                                      |
                              Content Negotiation
                              (what can the target app accept?)
                                      |
                            +---------+---------+
                            |         |         |
                        App Paste  App Paste  App Paste
                        Handler    Handler    Handler
                        (Docs)     (Sheets)   (Slides)
```

### The EigenClipboardPayload

This is the core data structure that all apps serialize to and deserialize from:

```typescript
type EigenClipboardPayload = {
    version: 2;
    source: EigenClipboardSource;
    content: EigenClipboardContent[];
    plainText: string;
    htmlPreview: string;
}

type EigenClipboardSource = {
    app: 'docs' | 'sheets' | 'slides' | 'stickies' | 'chat' | 'calendar' | 'contacts' | 'drive' | 'mail' | 'vector';
    ownerId: string;
    mountId?: string;
    fileId?: string;
    timestamp: number;
    isCut: boolean;
    cutId?: string;   // unique ID for cut coordination
}
```

The `content` array contains typed content blocks. Each block carries its source representation and optional
pre-converted representations for common targets:

```typescript
type EigenClipboardContent =
    | EigenClipboardRichText
    | EigenClipboardCells
    | EigenClipboardSlideObjects
    | EigenClipboardImage
    | EigenClipboardFile
    | EigenClipboardCard
    | EigenClipboardCalendarEvent
    | EigenClipboardContact
    | EigenClipboardChatMessages
    | EigenClipboardVectorElements
    | EigenClipboardChart;
```

---

## Data Format Specification

### Rich Text (`richtext`)

For content from Docs, chat messages, card descriptions, and any Tiptap-based editor:

```typescript
type EigenClipboardRichText = {
    kind: 'richtext';
    // The ProseMirror/Tiptap JSON document fragment
    tiptapJson: object;
    // Pre-rendered HTML (for external paste)
    html: string;
    // Plain text extraction
    text: string;
    // Embedded images with their drive paths (for re-upload)
    images: Array<{
        src: string;
        sourcePath?: DrivePath;
        width?: number;
        height?: number;
    }>;
}
```

**Why include tiptapJson?** Because Tiptap can reconstruct the exact document fragment from its JSON format, preserving
headings, lists, task items, code blocks, tables, links, highlights, colors, and comments in a way that HTML parsing
cannot fully replicate.

### Cells (`cells`)

For content from Sheets (fortune-sheet):

```typescript
type EigenClipboardCells = {
    kind: 'cells';
    // The cell matrix (fortune-sheet's internal Cell type)
    cells: CellMatrix;
    // Row/column dimensions
    rows: Array<{ index: number; height: number }>;
    cols: Array<{ index: number; width: number }>;
    // Merge information
    merges: Array<{ r: number; c: number; rs: number; cs: number }>;
    // Border information
    borders: object;
    // Pre-rendered HTML table (for Docs/external paste)
    html: string;
    // TSV text (for plain text paste / external spreadsheet apps)
    tsv: string;
}
```

**Why include the full `CellMatrix`?** So that pasting back into Sheets preserves formulas, formatting, conditional
formatting, data validation, and cell types. The HTML table is a visual-only representation.

### Slide Objects (`slideobjects`)

For content from Slides:

```typescript
type EigenClipboardSlideObjects = {
    kind: 'slideobjects';
    objects: Array<{
        type: 'text' | 'image';
        // Position and dimensions (pixel values in 1920x1080 coordinate space,
        // converted to percentages at render time via pxToPercent)
        x: number;
        y: number;
        w: number;
        h: number;
        rotation: number;
        // Style
        borderColor: string;
        borderWidth: number;
        borderRadius: number;
        // Type-specific: text
        text?: string;
        fontSize?: number;
        fontWeight?: string;
        fontStyle?: string;
        textDecoration?: string;
        textAlign?: string;
        verticalAlign?: string;
        color?: string;
        letterSpacing?: number;
        lineHeight?: number;
        highlightColor?: string;
        backgroundColor?: string;
        // Type-specific: image
        src?: string;
        sourcePath?: DrivePath;
        objectFit?: string;
    }>;
    // Pre-rendered SVG or PNG (for external paste)
    html: string;
}
```

### Image (`image`)

For standalone images (from Drive, or pasted from external sources):

```typescript
type EigenClipboardImage = {
    kind: 'image';
    src: string;
    sourcePath?: DrivePath;
    width?: number;
    height?: number;
    mimeType: string;
    // Base64 data URL fallback (for small images, ensures they survive clipboard)
    dataUrl?: string;
}
```

### File Reference (`file`)

For files copied from Drive:

```typescript
type EigenClipboardFile = {
    kind: 'file';
    files: Array<{
        id: string;
        name: string;
        mimeType: string;
        ownerId: string;
        mountId: string;
        size: number;
        isFolder: boolean;
    }>;
}
```

### Kanban Card (`card`)

For cards copied from Stickies:

```typescript
type EigenClipboardCard = {
    kind: 'card';
    cards: Array<{
        title: string;
        description: string;
        color?: string;
        columnTitle?: string;
        creator?: string;
    }>;
    // Pre-rendered HTML (card-like visual representation)
    html: string;
}
```

**Note**: The actual `CardItem` type in stickies also has `chatId` (for embedded comment threads) and `createdAt`.
The `chatId` is intentionally omitted from the clipboard type because comment threads are document-specific and
cannot be meaningfully copied. The `creator` is included so that pasting into another context can attribute the card.

### Calendar Event (`calendarevent`)

For events copied from Calendar:

```typescript
type EigenClipboardCalendarEvent = {
    kind: 'calendarevent';
    events: Array<{
        title: string;
        description: string | null;
        location: string | null;
        startTime: number;
        endTime: number;
        allDay: boolean;
        rrule: string | null;
    }>;
    // iCalendar format (for external calendar apps)
    ical: string;
    // Human-readable text
    text: string;
}
```

### Contact (`contact`)

For contacts copied from Contacts:

```typescript
type EigenClipboardContact = {
    kind: 'contact';
    contacts: Array<{
        firstName: string;
        lastName: string;
        email: string[];
        phone: string[];
        company?: string;
        jobTitle?: string;
    }>;
    // vCard format (for external apps)
    vcard: string;
    // Human-readable text
    text: string;
}
```

### Chat Messages (`chatmessages`)

For messages copied from Chat:

```typescript
type EigenClipboardChatMessages = {
    kind: 'chatmessages';
    messages: Array<{
        authorName: string;
        content: string;
        timestamp: number;
        attachments: string[];
    }>;
    // Human-readable transcript
    text: string;
    // HTML transcript
    html: string;
}
```

### Vector Elements (`vectorelements`)

For shapes, paths, and drawings copied from the Vector app (see [RESEARCH_VECTOR.md](RESEARCH_VECTOR.md)):

```typescript
type EigenClipboardVectorElements = {
    kind: 'vectorelements';
    elements: Array<{
        type: 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'path' | 'text' | 'image' | 'group';
        x: number;
        y: number;
        w: number;
        h: number;
        rotation: number;
        // Full element data (type-specific properties, fill, stroke, etc.)
        data: Record<string, unknown>;
    }>;
    // SVG rendering (for external paste / preview)
    svg: string;
    // PNG fallback (base64, for apps that cannot render SVG)
    png?: string;
}
```

**Why this matters**: The vector app shares rendering DNA with slides (both use positioned elements in a 2D space).
Copy-paste between vector and slides should preserve element positions and styles. Pasting vector elements into docs
should insert an inline SVG or PNG image.

### Chart (`chart`)

For charts copied from Sheets or embedded in Docs/Slides (see [RESEARCH_GRAPHS.md](RESEARCH_GRAPHS.md)):

```typescript
type EigenClipboardChart = {
    kind: 'chart';
    // Serializable chart definition (library-agnostic)
    chartDef: {
        type: 'bar' | 'line' | 'pie' | 'scatter' | 'area' | 'combo';
        data: Array<{ label: string; values: number[] }>;
        labels: string[];
        options: Record<string, unknown>;
    };
    // Source sheet reference (for live-linked charts)
    sourceRef?: {
        ownerId: string;
        mountId: string;
        fileId: string;
        sheetId: string;
        range: string;  // e.g. "A1:D10"
    };
    // SVG rendering (for external paste)
    svg: string;
    // PNG fallback
    png?: string;
}
```

---

## Cross-App Content Mapping Table

When content of type X is pasted into app Y, what happens?

| Source \ Target | Docs | Sheets | Slides | Stickies | Chat | Calendar | Mail |
|---|---|---|---|---|---|---|---|
| **richtext** (Docs) | Insert Tiptap JSON directly | Extract text, fill cells (or detect table and map to cells) | Create text box with formatted text | Set card description (strip to plain or keep simple formatting) | Paste as message text | Set event description | Insert into compose body |
| **cells** (Sheets) | Insert as HTML table (with styles) | Paste cell matrix directly (lossless) | Create text box with tabular layout or auto-generate table image | Create one card per row or paste as description text | Paste as formatted text table | Set event description from cell text | Insert as HTML table |
| **slideobjects** (Slides) | Insert text objects as paragraphs, images as inline images | Extract text into cells | Paste objects directly (lossless) | Create cards from text objects | Paste text content | N/A | Insert as images/text |
| **vectorelements** (Vector) | Insert as inline SVG/PNG image | Insert as cell image | Create image object from SVG render | Insert as card attachment | Send SVG/PNG as attachment | N/A | Insert as inline image |
| **chart** | Insert as chart node (if chart extension exists) or PNG image | Paste chart definition (reconstruct chart) | Create chart object on slide | Insert as card attachment image | Send as PNG image | N/A | Insert as inline image |
| **image** | Insert as resizable image | Insert as cell image (or background) | Create image object | Set card background/attachment | Send as attachment | N/A | Insert inline or as attachment |
| **file** (Drive) | Insert link to file | Insert file name/link | Create link text box | Create card with file link | Send as file attachment | Attach to event | Attach to email |
| **card** (Stickies) | Insert as heading + description paragraph | One card per row (title, description columns) | Create text box per card | Paste cards directly (lossless) | Paste as formatted text | Create event from card title | Insert as text |
| **calendarevent** | Insert as formatted event block | Create row per event (title, time, location columns) | Create text box with event info | Create card per event | Paste as event summary text | Paste event directly (lossless) | Insert as meeting details |
| **contact** | Insert as contact card (name, email, phone) | Create row per contact | Create text box with contact info | Create card per contact | Paste as contact info text | Add as attendee (if pasting into event editor) | Add to To/CC field |
| **chatmessages** | Insert as blockquote transcript | Insert messages as rows | Create text box with transcript | Create card with transcript | Paste messages directly | N/A | Insert as quoted text |

### Content Negotiation Logic

Each target app registers what content kinds it can accept, in priority order:

```typescript
// Example: Docs paste handler
const DOCS_PASTE_PRIORITY = ['richtext', 'cells', 'chatmessages', 'card',
    'calendarevent', 'contact', 'slideobjects', 'image', 'file'];

// Example: Sheets paste handler
const SHEETS_PASTE_PRIORITY = ['cells', 'richtext', 'card', 'contact',
    'calendarevent', 'chatmessages', 'slideobjects', 'file', 'image'];
```

The paste handler iterates through the payload's `content` array and the target's priority list to find the best match.

---

## Cross-Tab Communication

### The Cut Problem

A cut operation in tab A should remove the source content after tab B successfully pastes. This requires communication
between tabs.

### BroadcastChannel Strategy

```typescript
const clipboardChannel = new BroadcastChannel('eigen-clipboard');

// Source tab (on cut):
clipboardChannel.postMessage({
    type: 'cut-initiated',
    cutId: crypto.randomUUID(),
    source: { app: 'slides', fileId: '...', objectIds: ['obj1', 'obj2'] }
});

// Target tab (after successful paste):
clipboardChannel.postMessage({
    type: 'cut-completed',
    cutId: '...',  // from the clipboard payload
});

// Source tab (on receiving cut-completed):
clipboardChannel.addEventListener('message', (e) => {
    if (e.data.type === 'cut-completed' && e.data.cutId === pendingCutId) {
        // Delete the source objects
        deleteObjects(pendingCutObjectIds);
        pendingCutId = null;
    }
});
```

**Why BroadcastChannel?** It is same-origin, synchronous delivery, no server needed, and widely supported since 2022.
It is purpose-built for exactly this use case.

### Additional BroadcastChannel Uses

Beyond cut coordination, the channel enables:

- **Clipboard preview**: When content is copied in one tab, other Eigen tabs could show a "Clipboard contains: 3 cells
  from Sheets" indicator
- **Paste shortcut**: A "Paste from Eigen" button in the toolbar that reads from the BroadcastChannel's last message
  instead of the system clipboard (avoids permission prompts)
- **Clipboard history**: A small ring buffer of recent copies, accessible from any Eigen tab

### The EigenClipboardBus

```typescript
class EigenClipboardBus {
    private channel = new BroadcastChannel('eigen-clipboard');
    private lastPayload: EigenClipboardPayload | null = null;
    private pendingCut: { cutId: string; cleanup: () => void } | null = null;

    // Called by the source app after copy/cut
    broadcast(payload: EigenClipboardPayload) {
        this.lastPayload = payload;
        this.channel.postMessage({ type: 'clipboard-write', payload });
    }

    // Called by the target app to read the latest eigen clipboard
    getLastPayload(): EigenClipboardPayload | null {
        return this.lastPayload;
    }

    // Called by the source app on cut
    registerCut(cutId: string, cleanup: () => void) {
        this.pendingCut = { cutId, cleanup };
    }

    // Called when receiving cut-completed from another tab
    private handleMessage = (e: MessageEvent) => {
        if (e.data.type === 'clipboard-write') {
            this.lastPayload = e.data.payload;
        }
        if (e.data.type === 'cut-completed' && this.pendingCut?.cutId === e.data.cutId) {
            this.pendingCut.cleanup();
            this.pendingCut = null;
        }
    }
}
```

### Fallback: localStorage Events

If BroadcastChannel is somehow unavailable, `window.addEventListener('storage', ...)` fires when another tab writes to
localStorage. This is a well-established fallback:

```typescript
// Write
localStorage.setItem('eigen-clipboard', JSON.stringify(payload));

// Listen
window.addEventListener('storage', (e) => {
    if (e.key === 'eigen-clipboard' && e.newValue) {
        const payload = JSON.parse(e.newValue);
        // ...
    }
});
```

---

## Layout Preservation Strategy

### The Core Problem

When you copy a formatted table from Sheets and paste into Docs, the table should look the same. When you copy styled
text from Docs and paste into Slides, the font size, color, and weight should be preserved. Currently, this is lossy.

### Strategy 1: HTML as the Visual Bridge

Since all Eigen apps render to the DOM, the most natural interchange format is HTML+CSS. The idea:

1. Each app's copy handler generates a **self-contained HTML fragment** with inline styles that visually reproduces the
   copied content
2. This HTML is included in the `htmlPreview` field of the payload
3. Target apps that cannot natively handle the source format use this HTML as a starting point and parse it into their
   native format

**For Sheets to Docs**: Fortune-sheet already generates an HTML table on copy. This table (with inline styles for
column widths, row heights, cell colors, fonts, borders) can be directly inserted into Tiptap as an HTML table. Tiptap
has native table support and will preserve the structure.

**For Docs to Slides**: The Tiptap HTML output (with inline styles) can be parsed to extract font size, weight, color,
and alignment, then mapped to slide text object properties.

### Strategy 2: Shared Style Vocabulary

Define a common style vocabulary that all apps understand:

```typescript
type EigenStyle = {
    fontFamily?: string;
    fontSize?: number;        // in pt
    fontWeight?: 'normal' | 'bold';
    fontStyle?: 'normal' | 'italic';
    textDecoration?: 'none' | 'underline' | 'line-through';
    textAlign?: 'left' | 'center' | 'right' | 'justify';
    color?: string;           // hex
    backgroundColor?: string; // hex
    borderColor?: string;
    borderWidth?: number;
    borderRadius?: number;
}
```

All content types embed this style information. Target apps map from `EigenStyle` to their native style system.

### Strategy 3: Screenshot Fallback for Complex Content

For content that is too complex to translate (e.g., a chart from Sheets, a complex slide layout), render the content to
a canvas and include a PNG representation:

```typescript
type EigenClipboardContent = {
    // ... other fields
    screenshot?: string;  // data:image/png;base64,... or a temporary URL
}
```

The target app can insert this as an image when it cannot interpret the structured data. This ensures that *something*
always shows up, even for the most exotic content types.

### Strategy 4: Shared HTML Renderer

A shared rendering function in `packages/lib/src/core/clipboard/render.ts` that converts any `EigenClipboardContent`
to an HTML fragment. This is the same logic used by the content converters (Phase 2) but packaged as a single entry
point for generating the `htmlPreview` field during copy:

```typescript
function renderClipboardContentToHtml(content: EigenClipboardContent): string {
    switch (content.kind) {
        case 'cells':
            return renderCellsToHtmlTable(content);
        case 'richtext':
            return content.html; // already have it from Tiptap
        case 'slideobjects':
            return renderSlideObjectsToHtml(content.objects);
        case 'card':
            return renderCardsToHtml(content.cards);
        case 'vectorelements':
            return content.svg; // SVG is valid HTML
        case 'chart':
            return content.svg;
        // ...
    }
}
```

This ensures that the `text/html` clipboard representation is always high-quality, regardless of which app produced
the content. External apps that paste Eigen content get a reasonable visual result even without the structured data.

---

## Inbound Paste: External Content into Eigen

### Detection and Classification

When a paste event occurs, the handler should classify the incoming content:

```typescript
function classifyPasteContent(clipboardData: DataTransfer): PasteClassification {
    // 1. Check for eigen structured data (our own format)
    const eigenData = readEigenPayload(clipboardData);
    if (eigenData) return { type: 'eigen', data: eigenData };

    // 2. Check for known external app formats
    const html = clipboardData.getData('text/html');
    if (html) {
        if (html.includes('docs-internal-guid-'))
            return { type: 'google-docs', html };
        if (html.includes('urn:schemas-microsoft-com:office:excel'))
            return { type: 'excel', html };
        if (html.includes('urn:schemas-microsoft-com:office:word'))
            return { type: 'word', html };
        if (html.includes('data-block-id'))
            return { type: 'notion', html };
    }

    // 3. Check for images
    const imageFile = Array.from(clipboardData.files)
        .find(f => f.type.startsWith('image/'));
    if (imageFile) return { type: 'image', file: imageFile };

    // 4. Check for rich HTML (tables, formatted text)
    if (html) {
        const hasTable = /<table/i.test(html);
        const hasFormatting = /<(b|i|strong|em|h[1-6]|ul|ol)/i.test(html);
        if (hasTable) return { type: 'html-table', html };
        if (hasFormatting) return { type: 'html-rich', html };
        return { type: 'html-plain', html };
    }

    // 5. Check for plain text
    const text = clipboardData.getData('text/plain');
    if (text) {
        // Detect structured text patterns
        if (isMarkdown(text)) return { type: 'markdown', text };
        if (isTsv(text)) return { type: 'tsv', text };
        if (isUrl(text)) return { type: 'url', text };
        return { type: 'text', text };
    }

    return { type: 'empty' };
}
```

### App-Specific External Paste Behavior

**Docs**:
- Google Docs HTML: Strip Google-specific styles but preserve structure
- Excel/Word HTML: Clean up namespace cruft, preserve tables and formatting
- Notion: Map Notion blocks to Tiptap nodes
- Markdown: Parse and convert to Tiptap document nodes
- URL: Create a link (or embed if it is a YouTube/image URL)

**Sheets**:
- HTML tables: Parse into cell matrix (fortune-sheet already does this)
- TSV/CSV text: Parse into cells
- Markdown tables: Parse into cells
- Excel HTML: Preserve formulas if possible

**Slides**:
- HTML: Create a text box with the content
- Images: Create an image object
- URL: Create a text box with the link, or embed (for image URLs, create image object)

**Calendar**:
- iCalendar data: Parse and create event
- Text with date/time: Attempt to extract event details (title, date, time, location) using heuristics

**Stickies**:
- Rich text: Create card with description (strip to plain text or preserve simple formatting)
- Table/cells: Create one card per row (use first column as title)
- URL: Create card with URL as title

**Chat**:
- Any content: Paste as message text (with Markdown formatting if applicable)
- Images: Upload and attach
- URLs: Auto-preview with link unfurling

**Drive**:
- Files (from OS file manager): Upload dropped files
- Text/HTML: Not applicable (Drive is not an editor)
- Note: Drive's main clipboard use case is Ctrl+C/V for files between folders, which is a file-reference operation
  handled entirely via the `file` content type, not external paste

---

## Cut Operations and Cleanup

### Architecture

Cut is fundamentally different from copy because it requires a two-phase commit:

1. **Phase 1 (Cut)**: Copy data to clipboard, visually indicate "pending cut" (e.g., dashed border, dimmed content),
   do NOT delete yet
2. **Phase 2 (Paste)**: Target app successfully incorporates the content. Source app is notified and deletes the
   original.
3. **Cancellation**: If the user copies something else, or presses Escape, the cut is cancelled and the visual
   indication is removed.

### Implementation

```typescript
// In the source app's cut handler:
function handleCut(selectedContent: Content) {
    const payload = serializeToPayload(selectedContent, { isCut: true });
    const cutId = crypto.randomUUID();

    // Write to clipboard
    writeEigenClipboard(payload);

    // Register cut with the BroadcastChannel bus
    clipboardBus.registerCut(cutId, () => {
        // This runs when paste is confirmed
        deleteContent(selectedContent);
    });

    // Visual indication
    markContentAsPendingCut(selectedContent);

    // Listen for cancellation
    const cancelCut = () => {
        clipboardBus.cancelCut(cutId);
        unmarkPendingCut(selectedContent);
    };

    // Cancel on next copy or Escape
    document.addEventListener('copy', cancelCut, { once: true });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') cancelCut();
    }, { once: true });
}

// In the target app's paste handler:
function handlePaste(payload: EigenClipboardPayload) {
    if (payload.source.isCut && payload.source.cutId) {
        // Insert content
        insertContent(payload);
        // Notify source tab
        clipboardBus.confirmCut(payload.source.cutId);
    } else {
        insertContent(payload);
    }
}
```

### Cross-Tab Cut Timing

What if the source tab is closed before the paste happens? The cut data is on the system clipboard, so the paste still
works. But the source content is not deleted (the source tab is gone). This is acceptable -- it is the same behavior
as cutting a file in a file manager and then closing the file manager window. The content remains.

What if the paste happens in the same tab? The BroadcastChannel does not fire for messages sent to itself. For same-tab
cut/paste, call the cleanup function directly:

```typescript
if (payload.source.fileId === currentFileId) {
    // Same document -- call cleanup directly
    deleteContent(cutContent);
} else {
    // Different document/tab -- use BroadcastChannel
    clipboardBus.confirmCut(payload.source.cutId);
}
```

---

## Drag-and-Drop Integration

### Shared Infrastructure

The Clipboard API and the Drag-and-Drop API share the `DataTransfer` object. This means the same serialization logic
can be reused:

```typescript
// On drag start:
element.addEventListener('dragstart', (e: DragEvent) => {
    const payload = serializeToPayload(selectedContent, { isCut: true });
    e.dataTransfer!.setData('application/x-eigen', JSON.stringify(payload));
    e.dataTransfer!.setData('text/plain', payload.plainText);
    e.dataTransfer!.setData('text/html', payload.htmlPreview);
    e.dataTransfer!.effectAllowed = 'copyMove';
});

// On drop:
element.addEventListener('drop', (e: DragEvent) => {
    const eigenJson = e.dataTransfer!.getData('application/x-eigen');
    if (eigenJson) {
        const payload = JSON.parse(eigenJson) as EigenClipboardPayload;
        insertContent(payload);
        if (e.dataTransfer!.dropEffect === 'move') {
            // Notify source to delete
            clipboardBus.confirmCut(payload.source.cutId);
        }
    }
});
```

**Key difference from clipboard**: Drag-and-drop `DataTransfer` does NOT strip custom MIME types, because the data
never goes through the system clipboard. The `application/x-eigen` custom type survives the drag-drop round-trip within
the same browser, even across different tabs/iframes. This makes drag-and-drop strictly more capable than clipboard for
intra-Eigen transfers.

**Important limitation**: Cross-tab drag-and-drop (dragging from one browser tab to another) only works if both tabs
are visible (tiled/split-screen). In practice, most users switch tabs via keyboard, which interrupts the drag. The
main use case for cross-app drag is within a single Eigen page that has multiple panels (e.g., Drive sidebar + Docs
editor, or the Space app which may show multiple apps side by side). For cross-tab workflows, clipboard (Ctrl+C/V)
remains the primary mechanism.

**Desktop only**: HTML5 drag-and-drop does not work on mobile/touch browsers. See the Mobile section above.

### Cross-App Drag Scenarios

| Source | Target | Action |
|---|---|---|
| Drive file | Docs | Insert file link or embed (image file becomes inline image) |
| Drive file | Slides | Create image/file object on slide |
| Drive file | Chat | Send as file attachment |
| Drive file | Mail compose | Attach to email |
| Stickies card | Docs | Insert card as heading + description |
| Calendar event | Docs | Insert event block |
| Contact | Mail compose | Add to recipients |
| Contact | Calendar event | Add as attendee |
| Sheets cell range | Docs | Insert as table |
| Docs text selection | Slides | Create text box |

### Drag Preview

Use `e.dataTransfer.setDragImage()` with a custom-rendered preview that shows what is being dragged:

```typescript
const preview = renderDragPreview(selectedContent);
e.dataTransfer!.setDragImage(preview, 0, 0);
```

The `renderDragPreview` function would create a small DOM element showing a summary (e.g., "3 cells", "1 image",
"Contact: John Doe").

---

## Mobile and Touch Considerations

### The Mobile Clipboard Challenge

On mobile browsers (iOS Safari, Android Chrome), clipboard behavior differs significantly from desktop:

- **No `copy`/`cut`/`paste` keyboard events** in the traditional sense. Users trigger copy/paste via the native
  selection popup (long-press -> Copy/Paste menu) or system-level gestures.
- **`ClipboardEvent` fires normally** when the user taps "Copy" or "Paste" in the native popup, so event handlers
  still work.
- **`navigator.clipboard.write()` is restricted**. On iOS Safari, it only works inside a user gesture handler
  (click/tap). On Android Chrome, it requires the page to be focused and have `clipboard-write` permission.
- **`navigator.clipboard.read()` always shows a permission prompt** on iOS. On Android, it may silently fail.
- **Selection is different**. Mobile browsers manage text selection natively. ProseMirror/Tiptap selections map to
  native selections, but canvas-based apps (sheets, slides) need custom long-press handlers.

### Strategy

1. **Prefer event-based clipboard** (`ClipboardEvent.clipboardData`) over the async API. The event-based path works
   most reliably on mobile because it fires within the native copy/paste gesture.
2. **Avoid button-triggered clipboard writes** on mobile. The async `writeEigenClipboardAsync` path requires careful
   timing on iOS. If a toolbar "Copy" button is needed, make sure the `navigator.clipboard.write()` call happens
   synchronously inside the click handler (not after an `await`).
3. **Add long-press context menus** for slides and stickies. Since these apps use custom elements (not native text),
   mobile users have no way to access copy/paste without a custom gesture handler.
4. **Use `document.execCommand('copy')` as a last resort**. Although deprecated, it is the most reliable way to trigger
   a clipboard write on older mobile browsers. The native `copy` event fires and our handler runs.
5. **Share Sheet integration**: On mobile, consider adding a "Share" action alongside copy that uses the
   `navigator.share()` API. This lets users send content to other apps natively. A shared URL with a token could
   reference clipboard data stored server-side (similar to Figma's approach).

### Touch Drag-and-Drop

HTML5 drag-and-drop does NOT work on mobile browsers. Touch-based drag requires:

- **`@dnd-kit` with touch sensors** (stickies already uses dnd-kit for internal drag, which supports touch via
  `TouchSensor` and `PointerSensor`).
- **Cross-app drag on mobile is not possible** via the browser. Users would need to use copy-paste instead. This is
  consistent with how other web apps work.

---

## Edge Cases and Fallbacks

### 1. Large Payloads

**Problem**: Copying a 1000-row sheet selection produces a very large JSON payload.

**Solution**: For payloads over 100KB, use a hybrid approach:
- Write a lightweight token to the clipboard (source app ID, selection range, timestamp)
- Store the full payload in the EigenClipboardBus (in-memory, same origin)
- On paste, check the bus first. If the token matches, use the in-memory payload. If not (e.g., different browser
  session), fall back to the clipboard HTML.

```typescript
if (jsonPayload.length > 100_000) {
    clipboardBus.storePayload(token, payload);
    // Write only the token + HTML preview to clipboard
    writeTokenToClipboard(token, payload.htmlPreview, payload.plainText);
} else {
    writeFullPayload(payload);
}
```

### 2. Cross-Origin Iframes

**Problem**: If Eigen apps are ever loaded in iframes from different subdomains, BroadcastChannel and custom MIME types
will not work.

**Solution**: Use `postMessage` between iframes, or ensure all apps share the same origin.

### 3. Firefox and Safari Clipboard Restrictions

**Problem**: Firefox and Safari are stricter about clipboard permissions and do not support `web ` custom formats.

**Solution**: The HTML attribute embedding strategy is the primary transport. The `web ` custom format is a progressive
enhancement. Test for support:

```typescript
function supportsWebCustomFormats(): boolean {
    try {
        return ClipboardItem.supports('web text/plain');
    } catch {
        return false;
    }
}
```

### 4. Sanitized HTML

**Problem**: Some browsers sanitize `text/html` when reading from clipboard, potentially stripping data attributes.

**Solution**: Use multiple redundant encoding strategies:
- `data-eigen-clipboard` attribute on a `<span>` (primary)
- `data-eigen` attribute on the root element (backup)
- A `<meta name="eigen-clipboard">` tag (some browsers preserve this)
- If all structural markers are stripped, fall back to parsing the HTML as external content

### 5. Empty or Invalid Clipboard

**Problem**: `navigator.clipboard.read()` may throw `NotAllowedError` or return empty data.

**Solution**: Always handle clipboard reads inside try-catch. In paste event handlers, use `e.clipboardData` (which
does not need permission) rather than `navigator.clipboard.read()`.

### 6. Image Re-Upload Race Conditions

**Problem**: When pasting an image that needs re-upload (different document), the upload is async. If the user pastes
rapidly, uploads may overlap or fail.

**Solution**: Queue image re-uploads and use optimistic insertion (show placeholder while uploading):

```typescript
async function insertImageWithReUpload(image: EigenClipboardImage, target: Target) {
    // Insert placeholder immediately
    const placeholderId = insertPlaceholder(target);

    // Upload in background
    const result = await reUploadImage(image);
    if (result) {
        replacePlaceholder(placeholderId, result);
    } else {
        // Fallback: use original src (may be broken if cross-document)
        replacePlaceholder(placeholderId, { src: image.src });
    }
}
```

### 7. Undo After Paste

**Problem**: Pasting complex content (e.g., a table from Sheets into Docs) should be undoable as a single operation.

**Solution**: Wrap all paste-related DOM/model changes in a single transaction:
- Tiptap: Use `editor.chain()...run()` which creates a single undo entry
- Fortune-sheet: Wrap in a single `setContextWithProduce` call
- Slides: Wrap in a single Yjs transaction (`yDoc.transact(() => { ... })`)

### 8. Pasting Into Read-Only Documents

**Problem**: User may try to paste into a document they can only view.

**Solution**: All paste handlers should check `canWrite` permission before processing. Show a toast notification:
"Cannot paste into a read-only document."

### 9. Circular Cut-Paste

**Problem**: User cuts content from Doc A, pastes into Doc B, then cuts the same content from Doc B and pastes back
into Doc A.

**Solution**: Each cut generates a new `cutId`. The source tracking in the payload ensures that the cleanup is always
directed at the correct source. No special handling needed.

### 10. Mixed Content Paste

**Problem**: User selects a range in Sheets that includes both regular cells and images/charts.

**Solution**: The `EigenClipboardPayload.content` array can contain multiple items. The paste handler should process all
items in order:

```typescript
for (const content of payload.content) {
    switch (content.kind) {
        case 'cells': insertCells(content); break;
        case 'image': insertImage(content); break;
        // ...
    }
}
```

---

## Cross-Cutting Concerns

This section connects the clipboard system to other areas of the Eigen architecture covered by separate research docs.

### Vector App ([RESEARCH_VECTOR.md](RESEARCH_VECTOR.md))

The vector app shares fundamental concepts with slides: positioned elements in a 2D coordinate space with transforms.
Clipboard implications:

- **Slides and vector share element DNA**. If slides is eventually rebuilt on top of vector's element system (as
  RESEARCH_VECTOR.md proposes), the clipboard types should be designed to accommodate both from the start. A
  `vectorelements` content type with extensible element data covers both slide objects and vector shapes.
- **SVG as the interchange format for drawings**. When pasting vector content into docs, the SVG rendering is the
  natural representation. For slides, the raw element data can be reconstructed. For external apps, SVG or PNG.
- **Inline vector drawings in docs**. RESEARCH_VECTOR.md describes a `VectorDrawing` Tiptap node. When copying a doc
  that contains inline drawings, the clipboard must include both the vector element data AND a rendered SVG/PNG
  fallback, so pasting into a non-vector-aware context still produces a visible result.
- **Copy between vector and slides**. Position/size values need coordinate system translation. Vector uses an
  infinite canvas with viewport transforms; slides uses a fixed 1920x1080 space. The clipboard should store
  absolute positions and let the target app normalize.

### Charts and Graphs ([RESEARCH_GRAPHS.md](RESEARCH_GRAPHS.md))

Charts are cross-app objects that appear in sheets (bound to cell ranges), docs (inline), and slides (as objects).
Clipboard implications:

- **Chart copy carries both definition and render**. The `chart` content type includes the serializable chart definition
  (type, data, options) AND a rendered SVG/PNG. Apps that understand charts can reconstruct them; apps that do not get
  an image.
- **Live-linked vs embedded**. When copying a chart from sheets, the clipboard should include a `sourceRef` pointing
  back to the sheet and cell range. The target app can choose to create a live link (chart updates when sheet data
  changes) or embed a snapshot.
- **Chart data round-trip**. Copying a chart from docs and pasting back into sheets should ideally reconstruct the
  chart with its cell range binding. This requires the `sourceRef` to survive the clipboard round-trip.

### Previews ([RESEARCH_PREVIEWS.md](RESEARCH_PREVIEWS.md))

The preview system and clipboard interact in two ways:

- **Paste preview / "Paste Special"**. Before committing a paste, the user could see a preview of what will be pasted
  and choose the representation (e.g., "Paste as table", "Paste as image", "Paste as text"). The preview rendering
  pipeline from RESEARCH_PREVIEWS.md could power this preview.
- **Clipboard-driven thumbnails**. When a file is copied in Drive, the clipboard data could include a thumbnail from
  the preview system. This gives a richer drag preview than just a filename.

### Inline Editing ([RESEARCH_INLINE_EDITING.md](RESEARCH_INLINE_EDITING.md))

When editing `.md`, `.txt`, or `.docx` files inline in the docs editor:

- **The clipboard system must work identically** whether the user is editing an `.eigendoc` or an inline `.md` file.
  Since inline editing uses the same Tiptap editor, the same copy/paste handlers apply.
- **Format-aware paste**: When pasting rich content into a `.md` file being edited inline, the paste handler should
  be aware that the target format is Markdown and convert accordingly (strip unsupported formatting, convert tables
  to Markdown tables, etc.).

### Accessibility

- **Announce paste results** via ARIA live regions. When content is pasted, announce what was inserted (e.g., "Pasted
  table with 5 rows and 3 columns" or "Pasted 2 slide objects").
- **Clipboard indicator** should be visible to screen readers. The "Clipboard contains: ..." indicator mentioned in
  the BroadcastChannel section should use `role="status"` or `aria-live="polite"`.
- **Keyboard-only users** must be able to access all clipboard operations without a mouse. The Ctrl+C/V/X shortcuts
  are standard, but "Paste Special" and clipboard history should also have keyboard shortcuts.

---

## Implementation Phases

### Phase 0: Quick Win -- Fix Cross-Tab Consistency

**Goal**: Fix the existing inconsistency where Docs' sync-path clipboard data is lost cross-tab.

1. Update `writeEigenClipboard` (sync path) to also write `text/html` with the embedded JSON attribute, matching
   what the async path and sheets already do. This is a one-line change in `clipboard.ts`:
   ```typescript
   const encoded = encodeURIComponent(JSON.stringify(data));
   e.clipboardData?.setData('text/html', `<span data-eigen-clipboard="${encoded}"></span>`);
   ```
2. This immediately fixes cross-tab eigen clipboard for Docs without changing any data model.
3. Run `bun run typecheck` and `bun run test`.

**Deliverable**: Cross-tab copy-paste works consistently across all apps with zero data model changes.

### Phase 1: Foundation (Version 2 Protocol)

**Goal**: Establish the new data model and transport, migrate existing clipboard code.

1. Define `EigenClipboardPayload` types in `packages/lib/src/types/clipboard.ts`
2. Implement `writeEigenPayload()` and `readEigenPayload()` in `packages/lib/src/core/clipboard/`
   - Write: `text/plain` + `text/html` (with embedded JSON) + `web application/x-eigen` (if supported)
   - Read: Check `web application/x-eigen` first, then parse HTML attribute, then fall back
3. Implement the `EigenClipboardBus` (BroadcastChannel wrapper) in `packages/lib/src/core/clipboard/bus.ts`
4. Update Docs editor to serialize Tiptap JSON as `richtext` content (include the ProseMirror fragment JSON
   alongside the existing image extraction)
5. Update Slides editor to use the new payload format (currently closest to the target design)
6. Update Sheets to serialize cells as `cells` content with HTML table and TSV fallback
7. Run `bun run typecheck` and `bun run test` after each step

**Deliverable**: All three document apps (Docs, Sheets, Slides) produce and consume `EigenClipboardPayload` version 2.
Copy-paste within the same app is lossless. Cross-app paste uses HTML preview (same quality as before, but with the
structured data available for Phase 2).

### Phase 2: Cross-App Intelligence

**Goal**: Implement smart content conversion between apps.

1. Implement content converters in `packages/lib/src/core/clipboard/converters/`:
   - `cells-to-richtext.ts`: Convert sheet cells to a Tiptap table JSON node
   - `richtext-to-cells.ts`: Parse Tiptap table nodes into a cell matrix
   - `richtext-to-slideobjects.ts`: Convert rich text to slide text objects
   - `cells-to-slideobjects.ts`: Convert cells to a table-like slide layout
   - `slideobjects-to-richtext.ts`: Convert slide text/images to Tiptap nodes
2. Update each app's paste handler to use converters when pasting cross-app content
3. Add the external content classifier (`classifyPasteContent`)
4. Add smart external paste for Docs (Google Docs, Word, Notion detection)

**Deliverable**: Copying cells from Sheets and pasting into Docs creates a proper table. Copying rich text from Docs
and pasting into Slides creates a styled text box. External content is intelligently parsed.

### Phase 3: Cut, Drag-and-Drop, and Non-Document Apps

**Goal**: Complete clipboard support across all apps, add cut and drag-and-drop.

1. Implement cut coordination (BroadcastChannel-based, with visual pending-cut indicators)
2. Add clipboard support to Stickies (copy/paste cards). Stickies already has dnd-kit infrastructure for internal
   card/column reordering (`use-drag-and-drop.ts`), so the drag foundation exists. Add system clipboard
   integration for copy/paste of cards across tabs/apps.
3. Add clipboard support to Chat (copy messages, paste into other apps)
4. Add clipboard support to Calendar (copy events as iCal)
5. Add clipboard support to Contacts (copy as vCard)
6. Add clipboard support to Drive (Ctrl+C files, paste into folders or other apps)
7. Implement drag-and-drop with shared serialization (note: this only works on desktop browsers, not mobile)
8. Add Drive file drag-and-drop into document apps

**Deliverable**: Full clipboard support across all Eigen apps. Cut works across tabs. Drag-and-drop works for files and
cross-app content on desktop.

### Phase 4: Polish and Advanced Features

**Goal**: Refinements and power-user features.

1. "Paste Special" dialog (Ctrl+Shift+V opens a picker: "Paste as table", "Paste as text", "Paste as image")
2. Smart URL paste (detect image URLs, YouTube links, Eigen internal links, and render previews)
3. Screenshot fallback for complex content (render to canvas, include PNG)
4. Clipboard indicator in the status bar ("Clipboard: 3 cells from Sheets") -- powered by BroadcastChannel
5. Server-side clipboard buffer (for very large payloads or cross-device paste, like Figma's approach)

**Deliverable**: A polished clipboard system with smart paste and user feedback.

### Phase 5: Vector and Chart Integration

**Goal**: Clipboard support for vector drawings and charts once those apps ship.

1. Add `vectorelements` content type and integrate with the vector app's copy/paste
2. Add `chart` content type with both chart definition and SVG/PNG render
3. Implement vector-to-slides and slides-to-vector element conversion
4. Implement chart copy from sheets with `sourceRef` for live-linked charts
5. Clipboard history panel (accessible from toolbar, shows recent copies across all tabs)

**Deliverable**: Seamless clipboard integration across all Eigen apps including vector and charts.

---

## File Index

### Existing files (current clipboard implementation)

| File | Purpose |
|---|---|
| `packages/lib/src/types/clipboard.ts` | Current type definitions (`EigenClipboardData`, `EigenClipboardItem`) |
| `packages/lib/src/core/clipboard/clipboard.ts` | Read/write functions, `reUploadImage`, `needsReUpload` |
| `packages/lib/src/core/clipboard/index.ts` | Re-exports |
| `apps/docs/src/components/docs/editor.tsx` | Docs copy/paste handlers (sync path only, images + text) |
| `apps/slides/src/components/slides/editor.tsx` | Slides copy/paste handlers (sync + async, full object round-trip) |
| `packages/fortune-sheet/src/components/Workbook/index.tsx` | Sheets copy/paste handlers (HTML + eigen marker) |
| `packages/fortune-sheet/src/core/events/copy.ts` | Fortune-sheet internal copy logic |
| `packages/fortune-sheet/src/core/events/paste.ts` | Fortune-sheet internal paste logic |
| `packages/fortune-sheet/src/core/modules/clipboard.ts` | Fortune-sheet clipboard module |
| `packages/fortune-sheet/src/core/modules/selection.ts` | Generates `fortune-copy-action-table` HTML |
| `apps/stickies/src/components/stickies/hooks/use-drag-and-drop.ts` | Stickies dnd-kit drag (internal only) |

### New files (to be created)

| File | Purpose |
|---|---|
| `packages/lib/src/core/clipboard/bus.ts` | `EigenClipboardBus` (BroadcastChannel wrapper) |
| `packages/lib/src/core/clipboard/converters/` | Cross-app content converters |
| `packages/lib/src/core/clipboard/classify.ts` | External content classifier |
| `packages/lib/src/core/clipboard/render.ts` | Shared HTML rendering for clipboard content |
| `apps/stickies/src/components/stickies/board.tsx` | Stickies copy/paste handlers (Phase 3) |
| `apps/chat/` | Chat copy/paste handlers (Phase 3) |
