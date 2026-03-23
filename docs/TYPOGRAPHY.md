# Proposal: Unified Typography & Self-Hosted Fonts

> **TLDR**: Replace inconsistent OS-dependent font stacks with five self-hosted font families: Inter (UI + body),
> Source Serif 4 (documents), JetBrains Mono (code), Excalifont (hand-drawn/sketch), and Noto (CJK, on-demand).
> Add a unified type scale via CSS custom properties, a shared `FontPicker` component, and integrate into docs,
> slides, and sheets. Fonts are stored as Vite assets in `packages/ui/src/assets/fonts/` and loaded via
> `@font-face` declarations in a shared `fonts.css`. Estimated: ~3 phases, ~15 files.

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Current State](#2-current-state)
3. [Font Selection](#3-font-selection)
4. [Type Scale](#4-type-scale)
5. [Font Hosting & Loading](#5-font-hosting--loading)
6. [Font Picker Component](#6-font-picker-component)
7. [Integration: Docs](#7-integration-docs)
8. [Integration: Slides](#8-integration-slides)
9. [Integration: Sheets](#9-integration-sheets)
10. [Integration: Other Apps](#10-integration-other-apps)
11. [Concrete File Changes](#11-concrete-file-changes)
12. [Implementation Phases](#12-implementation-phases)
13. [Open Questions](#13-open-questions)

---

## 1. Problem Statement

Eigen is a self-hosted Google Workspace alternative. It must not depend on external CDNs for font loading. Currently:

- **No self-hosted fonts** — every app uses OS system font stacks. Typography varies across macOS, Windows, and
  Linux, breaking visual consistency.
- **No unified type scale** — heading sizes, weights, and line heights differ between the docs editor
  (`eigen-prose.css`: h1 = 1.75em/500) and the drive inline editor (`apps/drive/css/globals.css`: h1 = 2em/700).
- **No font picker** — `@tiptap/extension-font-family` is in `apps/docs/package.json` but not registered. Slides
  have no `fontFamily` on `TextObject`. Fortune-sheet's font dropdown lists system fonts (Arial, Helvetica, Verdana,
  Tahoma) that may not exist on all platforms.
- **Inconsistent code fonts** — `eigen-prose.css` uses `'SF Mono', 'Fira Code', 'Cascadia Code', Consolas` while
  drive uses `'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono'`. None are bundled.
- **No fonts for export** — server-side PDF export on headless Linux renders with fallback fonts. See
  `RESEARCH_DOC_IMPORT_EXPORT.md` section 9 for how export depends on this font system.

---

## 2. Current State

### Font Stacks in Use

| Location                                               | Font Stack                                                                                                                    | Context                  |
|--------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------|--------------------------|
| `packages/ui/src/styles/eigen-prose.css` (body)        | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`                                                           | Docs editor, previews    |
| `packages/ui/src/styles/eigen-prose.css` (code)        | `'SF Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace`                                                                | Inline code, code blocks |
| `packages/ui/src/components/layout/shadow-content.tsx` | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif` | Email HTML (Shadow DOM)  |
| `apps/drive/css/globals.css` (code)                    | `'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', monospace`                                                               | Drive inline editor code |
| Fortune-sheet locale files                             | `fontarray: ["Arial", "Helvetica", "Verdana", "Tahoma"]`                                                                      | Sheets font picker       |
| Tailwind defaults                                      | `ui-sans-serif, system-ui, sans-serif`                                                                                        | All UI elements          |

There are zero `@font-face` declarations and zero bundled font files anywhere in the repository.

### Heading Inconsistency

| App                      | h1                  | h2                 | h3                  |
|--------------------------|---------------------|--------------------|---------------------|
| Docs (`eigen-prose.css`) | 1.75em / weight 500 | 1.4em / weight 500 | 1.15em / weight 500 |
| Drive (`.tiptap` styles) | 2em / weight 700    | 1.5em / weight 600 | 1.25em / weight 600 |

The same content renders differently depending on which app displays it.

### Editor Font State

- **Docs**: `@tiptap/extension-font-family` in `package.json` but **not registered** in `editor.tsx`. `TextStyle`
  and `Color` extensions are registered. On paste, `transformPastedHTML` strips all `fontFamily` styles.
- **Slides**: `TextObject` type has `fontSize`, `fontWeight`, `fontStyle` but no `fontFamily`. All text inherits
  the browser default sans-serif.
- **Sheets**: Fortune-sheet's `fontList` is declared but initialized empty. Font application in `cell.ts` and
  `inline-string.ts` is partially commented out. `fontList` assignment in `Workbook/index.tsx` is commented out.

---

## 3. Font Selection

Five font families, all open-source (SIL Open Font License), selected for quality, language coverage, and distinct
aesthetic roles:

| Font                | Category   | License | Variable? | Size (woff2)   | Usage                                 |
|---------------------|------------|---------|-----------|----------------|---------------------------------------|
| **Inter**           | Sans-serif | OFL     | Yes       | ~100KB         | UI, body text, default document font  |
| **Source Serif 4**  | Serif      | OFL     | Yes       | ~80KB          | Documents, formal content, reading    |
| **JetBrains Mono**  | Monospace  | OFL     | Yes       | ~90KB          | Code blocks, inline code              |
| **Excalifont**      | Hand-drawn | OFL-1.1 | No        | ~60KB          | Stickies, whiteboard, sketch contexts |
| **Noto Sans/Serif** | Sans/Serif | OFL     | Yes       | ~200KB (Latin) | CJK fallback (on-demand, Phase 3)     |

### Why These Fonts

**Inter** is the de facto standard for UI design. Variable font with weights 100-900, excellent screen rendering,
extensive language support. Replaces the inconsistent system font stacks with a single cross-platform typeface.
Compared to alternatives:

- **Geist** (Vercel, 2024): Inspired by Inter, similar quality, but **lacks italic variants** — a dealbreaker for
  a document editor where italic text is fundamental.
- **DM Sans**: Good geometric sans-serif but narrower language coverage and less established ecosystem.
- **SF Pro**: Apple-only license, cannot be self-hosted.

**Source Serif 4** (Adobe) is designed for on-screen reading with optical sizes and a full weight range (200-900
variable). Pairs naturally with Inter — both have similar x-heights and design philosophy. Compared to alternatives:

- **Literata** (Google): Excellent for e-readers, designed from scratch for screens. Warmer, more old-style
  aesthetic that doesn't pair as cleanly with Inter's geometric clarity. Strong second choice.
- **Charter** (Bitstream): No variable font version, limited weight range. Classic but dated.
- **Newsreader**: Newer, less mature, smaller community.

**JetBrains Mono** has the best balance of readability, ligature support, and active maintenance among open-source
monospace fonts. Its taller x-height improves readability at small sizes. Compared to alternatives:

- **Fira Code**: Closest competitor. Slightly shorter x-height, less active maintenance since 2023.
- **Cascadia Code** (Microsoft): Similar quality but a different aesthetic (wider letterforms). Good alternative.
- **Geist Mono** (Vercel): Newer, less battle-tested. Viable future alternative.

**Excalifont** (Excalidraw, 2024) is the successor to the Virgil font. A hand-drawn typeface with Latin, Greek,
and Cyrillic support, released under OFL-1.1. It provides a genuinely distinct aesthetic category for informal
contexts — sticky notes, whiteboard elements, sketch annotations. Single weight (Regular only), no bold/italic
variants, which is appropriate for hand-drawn text. No other open-source hand-drawn font matches its combination
of legibility and character.
Download: `https://excalidraw.nyc3.cdn.digitaloceanspaces.com/fonts/Excalifont-Regular.woff2`

**Noto Sans/Serif** provide CJK (Chinese, Japanese, Korean) coverage. Full CJK files are ~16MB each, so they are
loaded on demand only when CJK content is detected. Phase 3 work.

### Why Not Plus Jakarta Sans

The original research proposed Plus Jakarta Sans as a "display/heading" font. This is dropped because:

- Inter at weights 600-800 covers display/heading use cases adequately at large sizes.
- Adding a second sans-serif font increases bundle size (~60KB) and font-loading complexity.
- In a productivity suite, the visual differentiation between two geometric sans-serif fonts is minimal.
- If a dedicated display font is needed in the future, it can be added to the font registry without architectural
  changes.

---

## 4. Type Scale

A modular scale based on a 1.25 ratio (Major Third), anchored at 16px body:

| Token            | Size             | Weight | Line Height | Letter Spacing | Usage                            |
|------------------|------------------|--------|-------------|----------------|----------------------------------|
| `--text-display` | 2.25rem (36px)   | 700    | 1.1         | -0.025em       | Slide titles, hero headings      |
| `--text-h1`      | 1.75rem (28px)   | 600    | 1.2         | -0.02em        | Document headings                |
| `--text-h2`      | 1.375rem (22px)  | 600    | 1.25        | -0.015em       | Section headings                 |
| `--text-h3`      | 1.125rem (18px)  | 600    | 1.3         | -0.01em        | Subsection headings              |
| `--text-h4`      | 1rem (16px)      | 600    | 1.4         | 0              | Minor headings                   |
| `--text-body`    | 0.9375rem (15px) | 400    | 1.7         | 0              | Body text (prose)                |
| `--text-ui`      | 0.875rem (14px)  | 400    | 1.5         | 0              | UI elements (Tailwind `text-sm`) |
| `--text-small`   | 0.75rem (12px)   | 400    | 1.5         | 0.01em         | Captions, metadata               |
| `--text-code`    | 0.875rem (14px)  | 400    | 1.6         | 0              | Code blocks, inline code         |

### CSS Custom Properties

Add to `packages/ui/src/styles/globals.css` inside `:root`:

```css
:root {
    --font-sans: 'Inter', ui-sans-serif, system-ui, sans-serif;
    --font-serif: 'Source Serif 4', Georgia, 'Times New Roman', serif;
    --font-mono: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
    --font-hand: 'Excalifont', 'Comic Sans MS', cursive;
}
```

### Tailwind Theme Extension

Add to the `@theme inline` block in `globals.css`:

```css
@theme inline {
    --font-sans: 'Inter', ui-sans-serif, system-ui, sans-serif;
    --font-serif: 'Source Serif 4', Georgia, 'Times New Roman', serif;
    --font-mono: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
    --font-hand: 'Excalifont', 'Comic Sans MS', cursive;
}
```

This enables Tailwind utilities: `font-sans`, `font-serif`, `font-mono`, `font-hand`.

### Update eigen-prose.css

```css
.eigen-prose {
    font-family: var(--font-sans);
    font-size: 15px;
    line-height: 1.7;
}

.eigen-prose h1, .eigen-prose h2, .eigen-prose h3 {
    font-weight: 600;
}

.eigen-prose h1 { font-size: 1.75rem; line-height: 1.2; letter-spacing: -0.02em; }
.eigen-prose h2 { font-size: 1.375rem; line-height: 1.25; letter-spacing: -0.015em; }
.eigen-prose h3 { font-size: 1.125rem; line-height: 1.3; letter-spacing: -0.01em; }

.eigen-prose code {
    font-family: var(--font-mono);
    font-size: 0.875rem;
}
```

This also fixes the heading weight inconsistency (current: 500, proposed: 600, matching drive's convention).

---

## 5. Font Hosting & Loading

### Directory Structure

```
packages/ui/src/assets/fonts/
├── inter/
│   ├── Inter-Variable.woff2
│   └── Inter-Variable-Italic.woff2
├── source-serif/
│   ├── SourceSerif4-Variable.woff2
│   └── SourceSerif4-Variable-Italic.woff2
├── jetbrains-mono/
│   └── JetBrainsMono-Variable.woff2
└── excalifont/
    └── Excalifont-Regular.woff2
```

Fonts are placed in `src/assets/` (not `public/`) and referenced with relative paths in CSS. Vite handles hashing,
caching, and bundling automatically. This avoids the multi-`publicDir` problem — Vite does not natively support
multiple `publicDir` values, and `vite.shared.config.ts` has no `publicDir` override.

### @font-face Declarations

Create `packages/ui/src/styles/fonts.css`:

```css
@font-face {
    font-family: 'Inter';
    src: url('../assets/fonts/inter/Inter-Variable.woff2') format('woff2-variations');
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
}

@font-face {
    font-family: 'Inter';
    src: url('../assets/fonts/inter/Inter-Variable-Italic.woff2') format('woff2-variations');
    font-weight: 100 900;
    font-style: italic;
    font-display: swap;
}

@font-face {
    font-family: 'Source Serif 4';
    src: url('../assets/fonts/source-serif/SourceSerif4-Variable.woff2') format('woff2-variations');
    font-weight: 200 900;
    font-style: normal;
    font-display: swap;
}

@font-face {
    font-family: 'Source Serif 4';
    src: url('../assets/fonts/source-serif/SourceSerif4-Variable-Italic.woff2') format('woff2-variations');
    font-weight: 200 900;
    font-style: italic;
    font-display: swap;
}

@font-face {
    font-family: 'JetBrains Mono';
    src: url('../assets/fonts/jetbrains-mono/JetBrainsMono-Variable.woff2') format('woff2-variations');
    font-weight: 100 800;
    font-style: normal;
    font-display: swap;
}

@font-face {
    font-family: 'Excalifont';
    src: url('../assets/fonts/excalifont/Excalifont-Regular.woff2') format('woff2');
    font-weight: 400;
    font-style: normal;
    font-display: swap;
}
```

### Import Chain

Update `packages/ui/src/styles/globals.css`:

```css
@import "tailwindcss";
@import "./fonts.css";
@import "./eigen-prose.css";
```

Since every app imports `@workspace/ui/globals.css`, all apps automatically get the font definitions.

### Loading Strategy

- **`font-display: swap`** — text visible immediately with fallback, swaps when custom font loads. FOUT is
  preferable to FOIT for a productivity app.
- **Preload Inter only** — add to each app's `index.html`:
  ```html
  <link rel="preload" href="/assets/fonts/inter/Inter-Variable.woff2" as="font" type="font/woff2" crossorigin>
  ```
  Serif, mono, and hand-drawn fonts load on demand when content uses them.
- **No external CDN** — all fonts served from the same origin.
- **Variable fonts** — a single file replaces 4-6 static weight files, reducing total download while enabling
  arbitrary weight values.

### Bundle Size Impact

| Asset                   | Size (woff2) | Loading   |
|-------------------------|--------------|-----------|
| Inter Variable          | ~100KB       | Preloaded |
| Inter Variable Italic   | ~100KB       | On demand |
| Source Serif 4 Variable | ~80KB        | On demand |
| Source Serif 4 Italic   | ~80KB        | On demand |
| JetBrains Mono Variable | ~90KB        | On demand |
| Excalifont Regular      | ~60KB        | On demand |

First-load cost: ~100KB (Inter only). Total if all fonts used: ~510KB. Comparable to a medium JS library.

---

## 6. Font Picker Component

### Font Registry

Create `packages/lib/src/constants/fonts.ts`:

```typescript
export type EigenFont = {
    name: string;
    family: string;
    category: 'sans-serif' | 'serif' | 'monospace' | 'hand-drawn';
    weights: number[];
}

export const EIGEN_FONTS: EigenFont[] = [
    {name: 'Inter', family: "'Inter', sans-serif", category: 'sans-serif', weights: [400, 500, 600, 700]},
    {name: 'Source Serif 4', family: "'Source Serif 4', serif", category: 'serif', weights: [400, 600, 700]},
    {name: 'JetBrains Mono', family: "'JetBrains Mono', monospace", category: 'monospace', weights: [400, 700]},
    {name: 'Excalifont', family: "'Excalifont', cursive", category: 'hand-drawn', weights: [400]},
];

export const DEFAULT_DOCUMENT_FONT = EIGEN_FONTS[0]; // Inter
export const DEFAULT_SLIDE_FONT = EIGEN_FONTS[0];    // Inter
export const DEFAULT_SHEET_FONT = EIGEN_FONTS[0];    // Inter

export function getFontFamily(fontName: string): string {
    const font = EIGEN_FONTS.find(f => f.name === fontName);
    return font?.family ?? `'${fontName}', sans-serif`;
}
```

### Component

Create `packages/ui/src/components/layout/media/font-picker.tsx`:

```tsx
import {EIGEN_FONTS} from '@workspace/lib/constants/fonts';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '../../select';

type FontPickerProps = {
    value: string;
    onChange: (fontName: string) => void;
    className?: string;
}

export function FontPicker({value, onChange, className}: FontPickerProps) {
    return (
        <Select value={value} onValueChange={onChange}>
            <SelectTrigger className={className ?? "h-8 w-[160px] text-xs"}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {EIGEN_FONTS.map((font) => (
                    <SelectItem key={font.name} value={font.name}>
                        <span style={{fontFamily: font.family}}>{font.name}</span>
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
```

Each font name renders in its own typeface for an immediate preview. Follows the same pattern as the existing
`ColorPicker` in `packages/ui/src/components/layout/media/color-picker.tsx`.

---

## 7. Integration: Docs

**Current state**: `@tiptap/extension-font-family` in `package.json` but not imported or registered. `TextStyle`
is already registered (required by `Color`), which is a prerequisite for `FontFamily`.

### Changes

1. **Register FontFamily extension** in `apps/docs/src/components/docs/editor.tsx`:
   ```typescript
   import FontFamily from '@tiptap/extension-font-family';
   // In extensions array:
   FontFamily,
   ```

2. **Add FontPicker to toolbar** in `editor-toolbar.tsx`, between the File menu and the heading selector:
   ```tsx
   <FontPicker
       value={editor.getAttributes('textStyle').fontFamily || 'Inter'}
       onChange={(f) => editor.chain().focus().setFontFamily(getFontFamily(f)).run()}
   />
   ```

3. **Update paste handling**: Currently `transformPastedHTML` strips all `fontFamily` styles. Instead, map
   external font names to the closest available Eigen font:
   ```typescript
   const fontMap: Record<string, string> = {
       'Times New Roman': 'Source Serif 4', 'Georgia': 'Source Serif 4', 'Palatino': 'Source Serif 4',
       'Courier New': 'JetBrains Mono', 'Consolas': 'JetBrains Mono',
       'Comic Sans MS': 'Excalifont',
   };
   // Anything not in the map -> strip (defaults to Inter via eigen-prose)
   ```

4. **Default font**: Set via `eigen-prose` class -> `var(--font-sans)` (Inter). Per-selection font changes are
   stored as `textStyle` marks in the Tiptap/Yjs document.

---

## 8. Integration: Slides

**Current state**: `TextObject` has no `fontFamily` field. All text inherits browser default sans-serif.

### Changes

1. **Add `fontFamily` to `TextObject`** in `apps/slides/src/components/slides/types.ts`:
   ```typescript
   export type TextObject = BaseObject & {
       type: 'text';
       text: string;
       fontFamily: string;
       fontSize: number;
       // ...
   }
   ```

2. **Add default** in `DEFAULT_TEXT_OBJECT`:
   ```typescript
   fontFamily: 'Inter',
   ```

3. **Apply in rendering** — update `getTextStyle()` in `slide-object.tsx`:
   ```typescript
   fontFamily: getFontFamily(obj.fontFamily),
   ```

4. **Add FontPicker to properties panel** in `slide-properties-panel.tsx`.

5. **Normalize existing data** — update `normalize-deck.ts` to provide default `fontFamily: 'Inter'` for
   text objects that lack the field. Per CLAUDE.md, data is throwaway during dev, so no migration needed.

---

## 9. Integration: Sheets

**Current state**: Fortune-sheet locale files list system fonts. Font application code is partially commented out.

### Changes

1. **Update `fontarray`** in all locale files (`en.ts`, `zh.ts`, `zh_tw.ts`, `ru.ts`, `hi.ts`, `es.ts`):
   ```typescript
   fontarray: ["Inter", "Source Serif 4", "JetBrains Mono", "Excalifont"],
   ```

2. **Update `fontjson`** mapping:
   ```typescript
   fontjson: {inter: 0, "source serif 4": 1, "jetbrains mono": 2, excalifont: 3},
   ```

3. **Uncomment font-family application** in `cell.ts` and `inline-string.ts`.

4. **Re-enable `fontList`** in `Workbook/index.tsx` (currently commented out).

5. **`.fortune-container { font-family: inherit !important; }`** in `apps/sheets/css/globals.css` correctly
   inherits the app-level Inter font as the default grid font. No change needed.

---

## 10. Integration: Other Apps

### Mail

- `ShadowContent` (`shadow-content.tsx`): Inject Inter `@font-face` rule into the Shadow DOM style, update
  the font stack to `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`. Keep system fallbacks
  since email content may reference fonts the reader doesn't have.
- Compose is plain text (`<Textarea>`), inherits app font. No change needed.

### Stickies

- Cards use Tailwind text classes. Once Inter is the `--font-sans` in the Tailwind theme, all text automatically
  uses it. No stickies-specific changes needed.
- Excalifont could be used for card titles/body to give stickies a hand-drawn feel — a future enhancement.

### Drive Preview

- Text/code previews render inside `.eigen-prose` containers. Updated automatically when `eigen-prose.css` uses
  `var(--font-sans)` and `var(--font-mono)`.
- The `.tiptap` styles in `apps/drive/css/globals.css` should be aligned with `eigen-prose` (same heading scale,
  same font tokens) or eliminated in favor of `eigen-prose` where possible.

### Export Pipeline

- Print works automatically since fonts are loaded via CSS.
- PDF export (Puppeteer): Font files referenced via `file://` paths in the HTML template. Uses `font-display: block`
  to ensure fonts are loaded before PDF generation. See `RESEARCH_DOC_IMPORT_EXPORT.md` section 9.
- DOCX export: References font names in `TextRun` properties. Enable `embedTrueTypeFonts` for portability.

---

## 11. Concrete File Changes

### Phase 1: Font Files + CSS + Type Scale

| File                                                   | Action                                                                                |
|--------------------------------------------------------|---------------------------------------------------------------------------------------|
| `packages/ui/src/assets/fonts/`                        | Create directory, add woff2 files (Inter, Source Serif 4, JetBrains Mono, Excalifont) |
| `packages/ui/src/styles/fonts.css`                     | Create with `@font-face` declarations                                                 |
| `packages/ui/src/styles/globals.css`                   | Import `fonts.css`, add `--font-*` tokens to `:root` and `@theme inline`              |
| `packages/ui/src/styles/eigen-prose.css`               | Use `var(--font-sans)`, `var(--font-mono)`, update heading weights to 600             |
| `apps/drive/css/globals.css`                           | Update `.tiptap` styles to use tokens, align heading scale with eigen-prose           |
| `packages/ui/src/components/layout/shadow-content.tsx` | Inject Inter `@font-face`, update font stack                                          |
| `apps/*/index.html`                                    | Add `<link rel="preload">` for Inter variable font                                    |
| `packages/lib/src/constants/fonts.ts`                  | Create font registry (`EIGEN_FONTS`, `getFontFamily()`)                               |

### Phase 2: Font Picker + App Integration

| File                                                             | Action                                       |
|------------------------------------------------------------------|----------------------------------------------|
| `packages/ui/src/components/layout/media/font-picker.tsx`        | Create font picker component                 |
| `apps/docs/src/components/docs/editor.tsx`                       | Register `FontFamily` extension              |
| `apps/docs/src/components/docs/editor-toolbar.tsx`               | Add `FontPicker` to toolbar                  |
| `apps/slides/src/components/slides/types.ts`                     | Add `fontFamily` to `TextObject` and default |
| `apps/slides/src/components/slides/slide-object.tsx`             | Apply `fontFamily` in `getTextStyle()`       |
| `apps/slides/src/components/slides/slide-properties-panel.tsx`   | Add `FontPicker`                             |
| `apps/slides/src/components/slides/normalize-deck.ts`            | Default `fontFamily` for existing objects    |
| `packages/fortune-sheet/src/core/locale/en.ts` (+ other locales) | Update `fontarray` and `fontjson`            |
| `packages/fortune-sheet/src/core/modules/cell.ts`                | Uncomment font-family CSS application        |
| `packages/fortune-sheet/src/core/modules/inline-string.ts`       | Uncomment font-family handling               |
| `packages/fortune-sheet/src/components/Workbook/index.tsx`       | Re-enable `fontList` setting                 |

### Phase 3: Polish + Extended

| File                                               | Action                                                 |
|----------------------------------------------------|--------------------------------------------------------|
| `apps/drive/src/components/editor/code-editor.tsx` | Set CodeMirror `fontFamily` to `var(--font-mono)`      |
| `packages/lib/src/constants/fonts.ts`              | Add font file path mapping for export use              |
| CJK fonts (Noto)                                   | Add woff2 files, on-demand loading via `unicode-range` |

---

## 12. Implementation Phases

### Phase 1: Font Files + CSS (1 week)

**Goal**: Self-hosted fonts rendering across all apps. Unified type scale.

**Tasks**:

1. Download and add woff2 font files to `packages/ui/src/assets/fonts/`
2. Create `fonts.css` with `@font-face` declarations
3. Update `globals.css` to import `fonts.css` and add font tokens
4. Update `eigen-prose.css` to use font tokens and fix heading weights
5. Update drive `.tiptap` styles to align with eigen-prose
6. Update `shadow-content.tsx` to inject Inter
7. Add preload links to app `index.html` files
8. Create font registry in `packages/lib/src/constants/fonts.ts`

**Exit criteria**: All apps render with Inter. Code blocks use JetBrains Mono. Headings are consistent between
docs and drive. No visual regressions.

### Phase 2: Font Picker (1-2 weeks)

**Goal**: Shared font picker integrated into docs, slides, and sheets.

**Tasks**:

1. Create `FontPicker` component
2. Register `FontFamily` extension in docs editor
3. Add font picker to docs toolbar
4. Update paste handling to map external fonts
5. Add `fontFamily` to slides `TextObject` + normalize + properties panel
6. Update Fortune-sheet locale files and re-enable font application

**Exit criteria**: Users can select fonts in docs, slides, and sheets. Font changes persist in collaborative
editing. Pasted content maps to available fonts.

### Phase 3: Polish + CJK (1 week)

**Goal**: Extended integration, CJK support.

**Tasks**:

1. Set CodeMirror font in drive code editor
2. Add font file path mapping for export pipeline
3. Add Noto Sans/Serif woff2 files for CJK support (on-demand loading)
4. Test across macOS, Windows, Linux for rendering consistency

**Exit criteria**: All apps use self-hosted fonts consistently. CJK content renders correctly.

---

## 13. Open Questions

### Variable Fonts vs. Static Fonts

**Decision: Variable fonts.** A single variable woff2 (~80-100KB) replaces 4-6 static weight files (~200KB total).
Smaller download, enables arbitrary weight values. All modern browsers support variable fonts.

### Font Subsetting

Variable woff2 files for Latin scripts are already small (~80-100KB). Do not subset further — the savings are
minimal and maintenance cost is not worth it. For CJK fonts (Phase 3), use `unicode-range` in `@font-face` to
split into smaller chunks loaded on demand.

### Custom Font Upload

**Not in scope.** Custom font upload introduces storage, security (malicious font files), real-time collab
(font availability across clients), and export (embedding) complexity. A future enhancement could allow org
admins to upload fonts via the admin panel, making `EIGEN_FONTS` dynamic (fetched at app startup).

### Fonts in Exported Documents

- **Print**: Works automatically (fonts loaded via CSS).
- **PDF** (Puppeteer): Fonts referenced via `file://` URLs in the HTML template. See
  `RESEARCH_DOC_IMPORT_EXPORT.md` section 9.
- **DOCX**: Font names referenced in `TextRun` properties. Enable `embedTrueTypeFonts` for portability. All Eigen
  fonts are OFL-licensed, so embedding is permitted.

### Rendering Consistency

Self-hosted fonts ensure the same typeface across platforms. Platform-level rendering differences (subpixel
antialiasing, hinting) still exist but Inter is designed to render well across all platforms.

### Relationship to Theme System

Font tokens (`--font-sans`, `--font-serif`, etc.) integrate with the existing theme token system. In the future,
themes could override font families by reassigning these CSS custom properties.
