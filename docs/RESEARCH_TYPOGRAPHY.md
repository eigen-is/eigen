# Research: Unified Typography & Self-Hosted Fonts

> **TLDR**: Eigen currently uses OS system font stacks with no self-hosted fonts and no unified type scale. Each app
> defines typography ad-hoc. This document proposes: (1) a centralized set of self-hosted fonts stored in
> `packages/ui/public/fonts/`, (2) a type scale defined as CSS custom properties in`packages/ui/src/styles/globals.css`,
> (3) a shared `FontPicker` component for docs/slides/sheets, and (4) per-app integration plans. Six font families
> cover all use cases: Inter (UI + body), Source Serif 4 (documents), JetBrains Mono (code), Plus Jakarta Sans
> (headings/display), and Noto Sans/Serif as CJK fallbacks.

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Current State Analysis](#2-current-state-analysis)
3. [Proposed Typography Scale](#3-proposed-typography-scale)
4. [Proposed Font System](#4-proposed-font-system)
5. [Integration Points](#5-integration-points)
6. [Implementation Plan](#6-implementation-plan)
7. [Open Questions & Trade-offs](#7-open-questions--trade-offs)

---

## 1. Problem Statement

Eigen is a self-hosted Google Workspace alternative. As a self-hosted product, it must not depend on external CDNs
(Google Fonts, Adobe Fonts) for font loading. Currently, Eigen has:

- **No self-hosted fonts** -- every app relies on OS system font stacks (`-apple-system, BlinkMacSystemFont, 'Segoe UI',
  Roboto, sans-serif`). This means typography varies across macOS, Windows, and Linux, breaking visual consistency.
- **No unified type scale** -- heading sizes, line heights, and font weights are defined independently in each app's
  CSS, leading to inconsistencies between the docs editor, text previews, the drive inline editor, and the landing page.
- **No font picker** -- the docs editor (Tiptap) has the `@tiptap/extension-font-family` package installed but does not
  expose it in the toolbar. Slides have no font selection at all (the `TextObject` type lacks a `fontFamily` field).
  Fortune-sheet has a font dropdown (`fontarray`) but it lists system fonts (Arial, Helvetica, Verdana, Tahoma) that may
  not be available on all platforms.
- **Inconsistent code font stacks** -- `eigen-prose.css` uses `'SF Mono', 'Fira Code', 'Cascadia Code', Consolas,
  monospace` while the drive inline editor uses `'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', monospace`.
  SF Mono is macOS-only, and none of these are bundled.
- **No document fonts for export** -- when exporting or printing documents, the rendered output depends on whatever
  the user's OS provides. A self-hosted deployment on a headless Linux server would render with fallback fonts.

**Goal**: A single typography system where every app shares the same self-hosted fonts, the same type scale, and users
can pick from a curated set of fonts in content editors (docs, slides, sheets).

---

## 2. Current State Analysis

### 2.1 Font Stacks in Use

| Location                                               | Font Stack                                                                                                                    | Context                                         |
|--------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------|
| `packages/ui/src/styles/eigen-prose.css` (body)        | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`                                                           | Docs editor, text previews, drive inline editor |
| `packages/ui/src/styles/eigen-prose.css` (code)        | `'SF Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace`                                                                | Inline code, code blocks                        |
| `packages/ui/src/components/layout/shadow-content.tsx` | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif` | Email HTML rendering (Shadow DOM)               |
| `apps/drive/css/globals.css` (code)                    | `'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', monospace`                                                               | Drive inline editor code                        |
| `apps/index/public/eigen-space-logo.svg`               | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif` | Landing page logo SVG                           |
| `packages/fortune-sheet` locale files                  | `fontarray: ["Arial", "Helvetica", "Verdana", "Tahoma"]`                                                                      | Sheets font picker dropdown                     |
| `apps/sheets/css/globals.css`                          | `font-family: inherit !important`                                                                                             | Fortune-sheet container inherits app font       |
| Tailwind defaults (no override)                        | `ui-sans-serif, system-ui, sans-serif, ...`                                                                                   | All UI elements, sidebars, toolbars, buttons    |

**Key observation**: There are zero `@font-face` declarations and zero bundled font files (`.woff2`, `.ttf`, `.otf`)
anywhere in the repository. The single `.woff2` file found is test data inside `data-test/`.

### 2.2 Heading Styles by App

| App                     | h1                               | h2                  | h3                   | Source                                   |
|-------------------------|----------------------------------|---------------------|----------------------|------------------------------------------|
| **Docs** (eigen-prose)  | `1.75em`, weight 500             | `1.4em`, weight 500 | `1.15em`, weight 500 | `packages/ui/src/styles/eigen-prose.css` |
| **Drive inline editor** | `2em`, weight 700                | `1.5em`, weight 600 | `1.25em`, weight 600 | `apps/drive/css/globals.css` (.tiptap)   |
| **Shadow DOM (mail)**   | N/A (generic `font-weight: 600`) | Same                | Same                 | `shadow-content.tsx` inline styles       |
| **Slides**              | N/A (no heading concept)         | N/A                 | N/A                  | Font size per-object, default 48px       |

The docs editor and drive inline editor have **different** heading scales and weights for the same content type. This is
a concrete inconsistency: a markdown file rendered in the drive preview looks different from the same content opened in
the docs Tiptap editor.

### 2.3 How Each App Handles Fonts Today

**Docs (Tiptap)**

- Has `@tiptap/extension-font-family` in `package.json` but does **not** register it as an editor extension in
  `editor.tsx`. The extension is unused.
- Uses `TextStyle` and `Color` extensions for inline text styling.
- On paste, the editor **strips** all `fontFamily` styles via `transformPastedHTML` (line 217 of `editor.tsx`):
  `(el as HTMLElement).style.fontFamily = ''`.
- The editor content gets the `eigen-prose` class, so all text uses the system sans-serif stack.
- The toolbar has heading level selection (Normal, H1, H2, H3) but no font family selector.

**Slides**

- The `TextObject` type in `types.ts` defines `fontSize`, `fontWeight`, `fontStyle`, `textDecoration`, `textAlign`,
  `letterSpacing`, `lineHeight` -- but no `fontFamily` property.
- The `getTextStyle()` helper in `slide-object.tsx` builds a `React.CSSProperties` object that includes `fontSize`,
  `fontWeight`, `fontStyle`, etc. but no `fontFamily`.
- The `SlidePropertiesPanel` has text styling controls (size, bold, italic, alignment, color) but no font selector.
- All slide text inherits the browser/OS default sans-serif.

**Sheets (Fortune-Sheet)**

- The forked `packages/fortune-sheet` has a `fontarray` in each locale file (e.g., `en.ts`):
  `["Arial", "Helvetica", "Verdana", "Tahoma"]`.
- The toolbar renders a font dropdown (`name === "font"`) that maps these names to the `ff` cell property.
- The `fontList` property in `context.ts` is declared (`fontList: any[]`) and initialized as empty (`fontList: []`).
  The line `draftCtx.fontList = mergedSettings.fontList` is **commented out** in `Workbook/index.tsx` (line 505).
- Font family application to cells is also partially commented out in `cell.ts` (lines 1283-1291) and
  `inline-string.ts` (lines 93-100).
- The `apps/sheets/css/globals.css` sets `.fortune-container { font-family: inherit !important; }`, meaning the
  sheet grid inherits the app-level font (which is the Tailwind system default).

**Mail**

- Compose uses a plain `<Textarea>` (no rich text editor). The draft form is plain text only.
- Email display uses `ShadowContent` (Shadow DOM) with its own hardcoded system font stack.
- No font selection is offered for composing or reading.

**Stickies**

- Card rendering (`card.tsx`) uses standard Tailwind text classes (`text-sm`, `text-xs`).
- No custom font declarations. Inherits the app-wide Tailwind default.

**Drive Preview**

- Text/code previews render inside `.eigen-prose` containers.
- The native file editor uses both the `.eigen-prose` class (for markdown view mode) and its own `.tiptap` styles
  (for edit mode, defined in `apps/drive/css/globals.css`).

### 2.4 CSS Architecture

Every app follows the same pattern in `main.tsx`:

```typescript
import '@workspace/ui/globals.css';  // Shared: Tailwind + eigen-prose.css + theme tokens
import './../css/globals.css';       // App-specific: .bg-app color + app-specific styles
```

`globals.css` in `packages/ui/src/styles/` imports `eigen-prose.css` and defines all theme tokens (colors, radii, etc.)
but defines **no font family tokens**. Tailwind 4 is used via `@tailwindcss/vite` plugin with `@tailwindcss/postcss` for
processing. There is no `tailwind.config.ts` -- configuration is done via CSS `@theme` blocks in `globals.css`.

---

## 3. Proposed Typography Scale

### 3.1 Type Scale Definition

A modular scale based on a 1.25 ratio (Major Third), anchored at 16px body:

| Token            | Size             | Weight | Line Height | Letter Spacing | Usage                                    |
|------------------|------------------|--------|-------------|----------------|------------------------------------------|
| `--text-display` | 36px / 2.25rem   | 700    | 1.1         | -0.025em       | Slide titles, hero headings              |
| `--text-h1`      | 28px / 1.75rem   | 600    | 1.2         | -0.02em        | Document headings                        |
| `--text-h2`      | 22px / 1.375rem  | 600    | 1.25        | -0.015em       | Section headings                         |
| `--text-h3`      | 18px / 1.125rem  | 600    | 1.3         | -0.01em        | Subsection headings                      |
| `--text-h4`      | 16px / 1rem      | 600    | 1.4         | 0              | Minor headings                           |
| `--text-body`    | 15px / 0.9375rem | 400    | 1.7         | 0              | Body text (prose)                        |
| `--text-ui`      | 14px / 0.875rem  | 400    | 1.5         | 0              | UI elements (default Tailwind `text-sm`) |
| `--text-small`   | 12px / 0.75rem   | 400    | 1.5         | 0.01em         | Captions, metadata                       |
| `--text-code`    | 14px / 0.875rem  | 400    | 1.6         | 0              | Code blocks, inline code                 |

### 3.2 CSS Custom Properties

Add to `packages/ui/src/styles/globals.css` inside the `:root` block:

```css
:root {
    /* Font families */
    --font-sans: 'Inter', ui-sans-serif, system-ui, sans-serif;
    --font-serif: 'Source Serif 4', Georgia, 'Times New Roman', serif;
    --font-mono: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
    --font-display: 'Plus Jakarta Sans', 'Inter', ui-sans-serif, system-ui, sans-serif;

    /* Type scale */
    --text-display: 2.25rem;
    --text-h1: 1.75rem;
    --text-h2: 1.375rem;
    --text-h3: 1.125rem;
    --text-h4: 1rem;
    --text-body: 0.9375rem;
    --text-ui: 0.875rem;
    --text-small: 0.75rem;
    --text-code: 0.875rem;
}
```

### 3.3 Tailwind Theme Extension

Since Eigen uses Tailwind 4 with CSS-based configuration (`@theme inline` block in `globals.css`), extend the theme:

```css
@theme inline {
    /* Font families */
    --font-sans: 'Inter', ui-sans-serif, system-ui, sans-serif;
    --font-serif: 'Source Serif 4', Georgia, 'Times New Roman', serif;
    --font-mono: 'JetBrains Mono', 'Fira Code', ui-monospace, monospace;
    --font-display: 'Plus Jakarta Sans', 'Inter', ui-sans-serif, system-ui, sans-serif;
}
```

This enables Tailwind utility classes: `font-sans`, `font-serif`, `font-mono`, `font-display`.

### 3.4 Mapping to eigen-prose

Update `packages/ui/src/styles/eigen-prose.css` to use the new tokens:

```css
.eigen-prose {
    font-family: var(--font-sans);
    font-size: var(--text-body);
    line-height: 1.7;
}

.eigen-prose h1 {
    font-size: var(--text-h1);
    font-weight: 600;
    line-height: 1.2;
    letter-spacing: -0.02em;
}

.eigen-prose h2 {
    font-size: var(--text-h2);
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: -0.015em;
}

.eigen-prose h3 {
    font-size: var(--text-h3);
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: -0.01em;
}

.eigen-prose code {
    font-family: var(--font-mono);
    font-size: var(--text-code);
}
```

### 3.5 Consistency with Drive Inline Editor

The `.tiptap` styles in `apps/drive/css/globals.css` should be updated to match the `eigen-prose` scale. Currently
they differ (h1 is `2em`/700 in drive vs `1.75em`/500 in eigen-prose). After this change, the `.tiptap` styles in
drive should reference the same tokens or be eliminated in favor of the shared `eigen-prose` styles where possible.

---

## 4. Proposed Font System

### 4.1 Font Selection

Six font families, all open-source (SIL Open Font License or Apache 2.0), selected for quality, language coverage,
and complementary aesthetics:

| Font                  | Category               | License | Weights            | Variable? | Size (woff2)          | Usage                                     |
|-----------------------|------------------------|---------|--------------------|-----------|-----------------------|-------------------------------------------|
| **Inter**             | Sans-serif             | OFL     | 400, 500, 600, 700 | Yes       | ~100KB (variable)     | UI, body text, default document font      |
| **Source Serif 4**    | Serif                  | OFL     | 400, 600, 700      | Yes       | ~80KB (variable)      | Documents, formal content, reading        |
| **JetBrains Mono**    | Monospace              | OFL     | 400, 700           | Yes       | ~90KB (variable)      | Code blocks, inline code, terminal        |
| **Plus Jakarta Sans** | Sans-serif (geometric) | OFL     | 500, 600, 700, 800 | Yes       | ~60KB (variable)      | Display headings, slides, presentations   |
| **Noto Sans**         | Sans-serif             | OFL     | 400, 700           | Yes       | ~200KB (Latin subset) | CJK fallback (optional, loaded on demand) |
| **Noto Serif**        | Serif                  | OFL     | 400, 700           | Yes       | ~200KB (Latin subset) | CJK serif fallback (optional)             |

**Why these fonts:**

- **Inter** is the de facto standard for UI design. It has excellent screen rendering, extensive language support, and
  a variable font version that keeps file size small. It replaces the current system sans-serif stack with a consistent
  cross-platform experience.
- **Source Serif 4** (by Adobe) is a high-quality serif typeface designed for reading on screen. It pairs well with
  Inter and provides a clear visual distinction for "document" vs. "UI" contexts.
- **JetBrains Mono** is a monospace font designed for code readability, with ligature support. It replaces the current
  inconsistent code font stacks (SF Mono, Fira Code, Cascadia Code, Roboto Mono) with a single self-hosted font.
- **Plus Jakarta Sans** is a geometric sans-serif that works well at large sizes. It adds personality for slide
  titles and display headings without clashing with Inter.
- **Noto Sans/Serif** provide CJK (Chinese, Japanese, Korean) coverage. They are loaded on demand only when CJK
  characters are detected, to avoid bloating initial page load.

### 4.2 Font Hosting & Loading

#### Directory Structure

```
packages/ui/public/fonts/
├── inter/
│   ├── Inter-Variable.woff2              # Latin + Latin Extended
│   └── Inter-Variable-Italic.woff2
├── source-serif/
│   ├── SourceSerif4-Variable.woff2
│   └── SourceSerif4-Variable-Italic.woff2
├── jetbrains-mono/
│   └── JetBrainsMono-Variable.woff2
├── plus-jakarta-sans/
│   └── PlusJakartaSans-Variable.woff2
└── noto/                                  # Optional CJK (Phase 3+)
    ├── NotoSansSC-Variable.woff2
    └── NotoSerifSC-Variable.woff2
```

**Why `packages/ui/public/fonts/`**: All apps import `@workspace/ui/globals.css` as their base stylesheet. Placing
fonts in the `packages/ui/public/` directory means they are accessible to all apps during development (via Vite's
`publicDir` resolution) and in production builds. Each app's Vite build copies the UI package's public assets into
its dist output.

**Alternative**: Store fonts in a shared `public/fonts/` at the repo root and configure each app's Vite config to
reference it. This would require modifying `vite.shared.config.ts` to add a `publicDir` alias. The
`packages/ui/public/` approach is simpler since the UI package is already a dependency of every app.

#### @font-face Declarations

Create `packages/ui/src/styles/fonts.css`:

```css
/* Inter — UI and body sans-serif */
@font-face {
    font-family: 'Inter';
    src: url('/fonts/inter/Inter-Variable.woff2') format('woff2-variations');
    font-weight: 100 900;
    font-style: normal;
    font-display: swap;
}

@font-face {
    font-family: 'Inter';
    src: url('/fonts/inter/Inter-Variable-Italic.woff2') format('woff2-variations');
    font-weight: 100 900;
    font-style: italic;
    font-display: swap;
}

/* Source Serif 4 — Document serif */
@font-face {
    font-family: 'Source Serif 4';
    src: url('/fonts/source-serif/SourceSerif4-Variable.woff2') format('woff2-variations');
    font-weight: 200 900;
    font-style: normal;
    font-display: swap;
}

@font-face {
    font-family: 'Source Serif 4';
    src: url('/fonts/source-serif/SourceSerif4-Variable-Italic.woff2') format('woff2-variations');
    font-weight: 200 900;
    font-style: italic;
    font-display: swap;
}

/* JetBrains Mono — Code */
@font-face {
    font-family: 'JetBrains Mono';
    src: url('/fonts/jetbrains-mono/JetBrainsMono-Variable.woff2') format('woff2-variations');
    font-weight: 100 800;
    font-style: normal;
    font-display: swap;
}

/* Plus Jakarta Sans — Display headings */
@font-face {
    font-family: 'Plus Jakarta Sans';
    src: url('/fonts/plus-jakarta-sans/PlusJakartaSans-Variable.woff2') format('woff2-variations');
    font-weight: 200 800;
    font-style: normal;
    font-display: swap;
}
```

#### Font Loading Strategy

- **`font-display: swap`** for all fonts. This ensures text is visible immediately with a fallback, then swaps to
  the custom font once loaded. For a self-hosted productivity app, FOUT (Flash of Unstyled Text) is preferable to
  FOIT (Flash of Invisible Text).
- **Preload critical fonts** in each app's `index.html`:
  ```html
  <link rel="preload" href="/fonts/inter/Inter-Variable.woff2" as="font" type="font/woff2" crossorigin>
  ```
  Only Inter (the UI font) needs preloading. Serif and monospace fonts load on demand when content requires them.
- **No external CDN dependencies**. All font files are served from the same origin as the app.
- **Variable fonts** instead of static weight files. A single variable woff2 file replaces multiple static files
  (e.g., Inter-Regular.woff2 + Inter-Medium.woff2 + Inter-SemiBold.woff2 + Inter-Bold.woff2), reducing both file
  count and total size while enabling arbitrary weight values.

#### Import Chain

Update `packages/ui/src/styles/globals.css`:

```css
@import "tailwindcss";
@import "./fonts.css";
@import "./eigen-prose.css";
```

Since every app imports `@workspace/ui/globals.css`, all apps automatically get the font definitions.

#### Production Build Considerations

In production, the API server serves the built frontend assets. The font files need to be included in the build
output. Two approaches:

1. **Vite publicDir**: Each app's Vite config resolves public assets. If fonts are in `packages/ui/public/fonts/`,
   modify `vite.shared.config.ts` to add this as a `publicDir`:
   ```typescript
   import { fileURLToPath } from 'url';

   publicDir: [
       path.resolve(process.cwd(), 'public'),
       path.resolve(process.cwd(), '../../packages/ui/public'),
   ],
   ```
   Note: Vite does not natively support multiple `publicDir` values. Use `vite-plugin-static-copy` or a symlink.

2. **CSS `url()` with Vite asset handling**: Place fonts in `packages/ui/src/assets/fonts/` (not `public/`) and
   reference them with relative paths in `fonts.css`. Vite will hash and bundle them. This is the more standard Vite
   approach and avoids the multi-publicDir issue. The `@font-face` declarations would use:
   ```css
   src: url('../assets/fonts/inter/Inter-Variable.woff2') format('woff2-variations');
   ```

Recommendation: **Option 2** (asset-based) is simpler and requires no config changes to `vite.shared.config.ts`.
Vite handles hashing, caching, and bundling automatically.

### 4.3 Font Picker Component

#### Registry

Create `packages/lib/src/constants/fonts.ts`:

```typescript
export type EigenFont = {
    name: string;
    family: string;
    category: 'sans-serif' | 'serif' | 'monospace' | 'display';
    weights: number[];
}

export const EIGEN_FONTS: EigenFont[] = [
    {name: 'Inter', family: "'Inter', sans-serif", category: 'sans-serif', weights: [400, 500, 600, 700]},
    {name: 'Source Serif 4', family: "'Source Serif 4', serif", category: 'serif', weights: [400, 600, 700]},
    {name: 'JetBrains Mono', family: "'JetBrains Mono', monospace", category: 'monospace', weights: [400, 700]},
    {
        name: 'Plus Jakarta Sans',
        family: "'Plus Jakarta Sans', sans-serif",
        category: 'display',
        weights: [500, 600, 700, 800]
    },
];

export const DEFAULT_DOCUMENT_FONT = EIGEN_FONTS[0]; // Inter
export const DEFAULT_SLIDE_FONT = EIGEN_FONTS[3];    // Plus Jakarta Sans
export const DEFAULT_SHEET_FONT = EIGEN_FONTS[0];    // Inter

export function getFontFamily(fontName: string): string {
    const font = EIGEN_FONTS.find(f => f.name === fontName);
    return font?.family ?? `'${fontName}', sans-serif`;
}
```

#### Component

Create `packages/ui/src/components/layout/media/font-picker.tsx`:

```tsx
import {EIGEN_FONTS, type EigenFont} from '@workspace/lib/constants/fonts';
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
                <SelectValue/>
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

The font picker renders each font name in its own typeface, giving users an immediate preview of what the font
looks like. This follows the same pattern as the `ColorPicker` component in
`packages/ui/src/components/layout/media/color-picker.tsx`.

---

## 5. Integration Points

### 5.1 Docs (Tiptap)

**Current state**: `@tiptap/extension-font-family` is listed in `apps/docs/package.json` but not imported or registered
in `editor.tsx`. The `TextStyle` extension is already registered (required by `Color`), which is a prerequisite for
`FontFamily`.

**Changes needed**:

1. **Register the FontFamily extension** in `apps/docs/src/components/docs/editor.tsx`:
   ```typescript
   import FontFamily from '@tiptap/extension-font-family';

   // In extensions array:
   FontFamily,
   ```

2. **Add font selector to toolbar** in `apps/docs/src/components/docs/editor-toolbar.tsx`:
    - Add a `FontPicker` component between the File menu and the heading selector.
    - Wire it to `editor.chain().focus().setFontFamily(getFontFamily(fontName)).run()`.
    - Read the current font via `editor.getAttributes('textStyle').fontFamily`.

3. **Update paste handling** in `editor.tsx`:
    - Currently, `transformPastedHTML` strips all `fontFamily` styles. Instead, map external font names to the
      closest available Eigen font, falling back to the default document font.

4. **Default document font**:
    - Set via the `eigen-prose` class (which will reference `var(--font-sans)`, i.e., Inter).
    - Users can change per-selection via the toolbar font picker. The font family is stored in the Tiptap/Yjs
      document as inline `textStyle` marks.

5. **Export/print font handling**:
    - The `printDocument()` function clones the `[data-document]` DOM node. Since fonts are loaded via CSS, they
      will be available in the print view as long as the `@font-face` rules are included.
    - For future PDF/DOCX export (see `RESEARCH_DOC_IMPORT_EXPORT.md`), the export pipeline will need to embed
      font files in the output. The font registry (`EIGEN_FONTS`) provides the mapping from font name to file path.

### 5.2 Slides

**Current state**: `TextObject` type has no `fontFamily` field. All text renders in the browser default sans-serif.

**Changes needed**:

1. **Add `fontFamily` to `TextObject`** in `apps/slides/src/components/slides/types.ts`:
   ```typescript
   export type TextObject = BaseObject & {
       type: 'text';
       text: string;
       fontFamily: string;  // New field
       fontSize: number;
       // ...
   }
   ```

2. **Add default** in `DEFAULT_TEXT_OBJECT`:
   ```typescript
   fontFamily: 'Plus Jakarta Sans',
   ```

3. **Apply font in rendering** -- update `getTextStyle()` in `slide-object.tsx`:
   ```typescript
   export function getTextStyle(obj: SlideObject & { type: 'text' }): React.CSSProperties {
       return {
           fontFamily: getFontFamily(obj.fontFamily),
           fontSize: pxToPercentHeight(obj.fontSize),
           // ...
       };
   }
   ```

4. **Add font selector to properties panel** -- update `TextProperties` in `slide-properties-panel.tsx`:
   ```tsx
   <PropertyRow label="Font">
       <FontPicker
           value={fontFamily === MIXED ? '' : (fontFamily ?? 'Plus Jakarta Sans')}
           onChange={(f) => onUpdate({ fontFamily: f })}
       />
   </PropertyRow>
   ```

5. **Presentation mode**: Font files are already loaded globally via CSS, so presentation mode will render correctly
   without any additional work.

6. **Yjs migration**: Since there are no backward compatibility requirements (per CLAUDE.md: "data is throwaway
   during dev"), the new `fontFamily` field can be added directly. The `normalize-deck.ts` should provide a
   default value for objects that lack the field.

### 5.3 Sheets (Fortune-Sheet)

**Current state**: The locale `fontarray` lists system fonts (Arial, Helvetica, Verdana, Tahoma). The font dropdown
in the toolbar iterates over this array. Font application to cells is partially commented out.

**Changes needed**:

1. **Update `fontarray`** in `packages/fortune-sheet/src/core/locale/en.ts` (and other locale files):
   ```typescript
   fontarray: ["Inter", "Source Serif 4", "JetBrains Mono", "Plus Jakarta Sans"],
   ```

2. **Update `fontjson`** mapping:
   ```typescript
   fontjson: { inter: 0, "source serif 4": 1, "jetbrains mono": 2, "plus jakarta sans": 3 },
   ```

3. **Uncomment font-family application** in `cell.ts` and `inline-string.ts` to actually apply the `ff` cell
   property as a CSS `font-family`.

4. **Re-enable `fontList`** in `Workbook/index.tsx` (line 505, currently commented out).

5. **Ensure `.fortune-container` inherits correctly**: The current `font-family: inherit !important` in
   `apps/sheets/css/globals.css` will correctly inherit the app-level Inter font as the default grid font.

### 5.4 Mail

**Current state**: Mail compose is plain text (`<Textarea>`). Email display uses Shadow DOM with a hardcoded system
font stack.

**Changes needed**:

1. **Update `ShadowContent`** in `packages/ui/src/components/layout/shadow-content.tsx`:
    - Inject `@font-face` rules into the Shadow DOM's `<style>` element so that email content can use the self-hosted
      fonts.
    - Alternatively, keep the system font stack for email display (since emails may reference fonts that the sender's
      system has but the reader's does not). The Shadow DOM approach intentionally isolates email styles.
    - Recommended approach: use `var(--font-sans)` as the base but keep fallback system fonts. Inject the Inter
      `@font-face` rule into the shadow root:
      ```javascript
      styleElement.textContent = `
        @font-face {
          font-family: 'Inter';
          src: url('/fonts/inter/Inter-Variable.woff2') format('woff2-variations');
          font-weight: 100 900;
          font-style: normal;
          font-display: swap;
        }
        .shadow-content-container {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          ...
        }
      `;
      ```

2. **Future rich text compose**: If a rich text compose editor is added (likely Tiptap-based), it should use the same
   `FontPicker` component as docs.

### 5.5 Stickies

**Current state**: Cards use Tailwind text classes (`text-sm`, `text-xs`). No custom font declarations.

**Changes needed**: Minimal. Once Inter is set as the `--font-sans` in the Tailwind theme, all Tailwind text classes
automatically use it. No stickies-specific changes needed.

The one consideration is the card dialog (`card-dialog.tsx`) which allows editing card descriptions. If a rich text
editor is added for descriptions in the future, it should use `eigen-prose` styles for consistency.

### 5.6 Drive Preview

**Current state**: Text previews render inside `.eigen-prose` containers. Code previews use the prose code font stack.

**Changes needed**: Once `eigen-prose.css` is updated to use `var(--font-sans)` and `var(--font-mono)`, all drive
previews automatically use the new fonts. No file-specific changes needed.

The inline editor (`native-file-editor.tsx`) renders in two modes:

- **View mode**: Uses `.eigen-prose` styles (updated via the shared CSS changes).
- **Edit mode**: Uses Tiptap (for markdown) or CodeMirror (for code). The Tiptap instance will inherit
  `eigen-prose` styles. CodeMirror has its own font handling -- set its `fontFamily` option to `var(--font-mono)`.

---

## 6. Implementation Plan

### Phase 1: Font Files + @font-face + Type Scale CSS

**Goal**: Self-hosted fonts loaded and rendering across all apps. Unified type scale.

| File                                                   | Action                                                                   |
|--------------------------------------------------------|--------------------------------------------------------------------------|
| `packages/ui/src/assets/fonts/`                        | Create directory, add woff2 variable font files                          |
| `packages/ui/src/styles/fonts.css`                     | Create with `@font-face` declarations                                    |
| `packages/ui/src/styles/globals.css`                   | Import `fonts.css`, add `--font-*` tokens to `:root` and `@theme inline` |
| `packages/ui/src/styles/eigen-prose.css`               | Update to use `var(--font-sans)`, `var(--font-mono)`, type scale tokens  |
| `apps/drive/css/globals.css`                           | Update `.tiptap` styles to use tokens, reconcile with eigen-prose        |
| `packages/ui/src/components/layout/shadow-content.tsx` | Inject `@font-face` for Inter, update font stack                         |
| `apps/*/index.html`                                    | Add `<link rel="preload">` for Inter variable font                       |
| `packages/lib/src/constants/fonts.ts`                  | Create font registry (`EIGEN_FONTS`, `getFontFamily()`)                  |

**Estimated scope**: ~10 files modified/created, no logic changes, pure CSS + asset additions.

### Phase 2: Font Picker Component

**Goal**: Shared font picker, integrated into docs, slides, and sheets.

| File                                                             | Action                                                  |
|------------------------------------------------------------------|---------------------------------------------------------|
| `packages/ui/src/components/layout/media/font-picker.tsx`        | Create font picker component                            |
| `apps/docs/src/components/docs/editor.tsx`                       | Register `FontFamily` extension                         |
| `apps/docs/src/components/docs/editor-toolbar.tsx`               | Add `FontPicker` to toolbar                             |
| `apps/slides/src/components/slides/types.ts`                     | Add `fontFamily` to `TextObject`, `DEFAULT_TEXT_OBJECT` |
| `apps/slides/src/components/slides/slide-object.tsx`             | Apply `fontFamily` in `getTextStyle()`                  |
| `apps/slides/src/components/slides/slide-properties-panel.tsx`   | Add `FontPicker` to text properties                     |
| `apps/slides/src/components/slides/normalize-deck.ts`            | Default `fontFamily` for objects missing it             |
| `packages/fortune-sheet/src/core/locale/en.ts` (+ other locales) | Update `fontarray` to Eigen fonts                       |
| `packages/fortune-sheet/src/core/locale/en.ts` (+ other locales) | Update `fontjson` mapping                               |
| `packages/fortune-sheet/src/core/modules/cell.ts`                | Uncomment font-family CSS application                   |
| `packages/fortune-sheet/src/core/modules/inline-string.ts`       | Uncomment font-family handling                          |
| `packages/fortune-sheet/src/components/Workbook/index.tsx`       | Re-enable `fontList` setting                            |

**Estimated scope**: ~15 files modified/created. Requires testing in docs, slides, and sheets apps.

### Phase 3: Polish & Extended Integration

**Goal**: Full integration with mail, code editors, and export pipeline.

| File                                               | Action                                                              |
|----------------------------------------------------|---------------------------------------------------------------------|
| `apps/drive/src/components/editor/code-editor.tsx` | Set CodeMirror `fontFamily` to `var(--font-mono)`                   |
| `apps/mail/`                                       | If/when rich text compose is added, integrate `FontPicker`          |
| `docs/RESEARCH_DOC_IMPORT_EXPORT.md`               | Update export pipeline to reference font files for PDF embedding    |
| `packages/lib/src/constants/fonts.ts`              | Add font file path mapping for export use                           |
| CJK fonts                                          | Add Noto Sans/Serif woff2 files for CJK support (on-demand loading) |

---

## 7. Open Questions & Trade-offs

### Variable Fonts vs. Static Fonts

**Recommendation: Variable fonts.** A single variable woff2 file (~80-100KB) replaces 4-6 static weight files
(~40KB each = ~200KB total). The total download is smaller, and variable fonts enable arbitrary weight values
(e.g., `font-weight: 550`) for fine-tuned typography. All modern browsers support variable fonts.

### How Many Font Weights to Include

For variable fonts, this is not a file size question (the variable file includes all weights). However, it is a
design question. The type scale above uses only 400, 500, 600, and 700. Limiting the UI to these weights prevents
visual chaos from too many weight variations.

For the font picker in content editors (docs, slides, sheets), users should be able to select any weight supported
by the chosen font. The `EigenFont.weights` array defines the recommended/exposed weights.

### Font Subsetting

Variable woff2 files for Latin-script fonts are already small (~80-100KB). For the initial implementation,
full Latin + Latin Extended subsets are sufficient. Do not subset further -- the savings are minimal and the
complexity of maintaining subsets is not worth it.

For CJK fonts (Noto Sans/Serif), subsetting is critical. A full Noto Sans CJK file is ~16MB. Options:

- **On-demand loading**: Detect CJK characters in content and load the CJK font file only when needed.
- **Unicode-range subsetting**: Use `unicode-range` in `@font-face` to split the CJK font into smaller chunks
  that browsers load on demand. Google Fonts uses this approach, splitting CJK fonts into ~100 chunks of ~50KB each.
- **Phase this as future work** (recommended). CJK support is important but can be added after the Latin font
  system is solid.

### Should Users Be Able to Add Custom Fonts?

**Not in the initial implementation.** Custom font upload introduces complexity:

- Storage: Where do custom fonts live? Per-user? Per-org? In the drive?
- Security: Font files can contain malicious content.
- Rendering: Custom fonts need to be available on all clients in real-time collab.
- Export: Custom fonts need to be embedded in exported documents.

A future enhancement could allow org admins to upload custom fonts via the admin panel, stored in the org's data
directory, with a server route to serve them. The `EIGEN_FONTS` registry would then be dynamic (fetched from the
server at app startup) rather than static.

### Fonts in Exported/Printed Documents

- **Print**: Works automatically since fonts are loaded via CSS in the app.
- **PDF export** (future, see `RESEARCH_DOC_IMPORT_EXPORT.md`): The export pipeline needs access to the raw font
  files. The `EIGEN_FONTS` registry should include a `filePath` property pointing to the woff2 file. PDF generators
  like `pdfkit` can embed font subsets directly. Puppeteer-based PDF generation gets fonts for free since it renders
  in a browser context.
- **DOCX export** (future): DOCX files reference font names; the font files are not embedded. The exported document
  will render correctly only if the reader has the fonts installed. Since all Eigen fonts are open-source, include
  a note in the export suggesting users install them, or embed them as DOCX embedded fonts (supported by the `docx`
  npm package).

### How the API Serves Font Files

In development, each app's Vite dev server serves its own assets. In production, the API server (or a reverse proxy)
serves the built frontend bundles. Font files are part of these bundles (as hashed assets if using the asset-based
approach, or as static files if using the publicDir approach).

No special API route is needed for fonts. They are static assets served alongside JS, CSS, and images. The existing
production deployment pipeline (see `DOCKER.md`) handles static asset serving.

### Font Rendering Consistency

One benefit of self-hosted fonts over system font stacks is **rendering consistency**. With system fonts:

- macOS renders with SF Pro (AAT hinting)
- Windows renders with Segoe UI (ClearType hinting)
- Linux renders with whatever is installed (often DejaVu Sans or Liberation Sans)

With self-hosted Inter, all platforms render the same typeface. However, platform-level text rendering differences
(subpixel antialiasing, hinting algorithms) still exist. Inter is designed with these differences in mind and renders
well across all platforms.

### Impact on Bundle Size

Per-app impact of adding self-hosted fonts:

| Asset                      | Size (woff2, gzip) | Loading              |
|----------------------------|--------------------|----------------------|
| Inter Variable             | ~100KB             | Preloaded (critical) |
| Inter Variable Italic      | ~100KB             | On demand            |
| Source Serif 4 Variable    | ~80KB              | On demand            |
| JetBrains Mono Variable    | ~90KB              | On demand            |
| Plus Jakarta Sans Variable | ~60KB              | On demand            |

Only Inter (~100KB) is preloaded. Total additional first-load cost: ~100KB. Subsequent fonts load on demand when
content references them. This is comparable to loading a medium-sized JavaScript library and is well within
acceptable limits for a productivity app.

### Relationship to Theme System

The font system uses CSS custom properties (`--font-sans`, `--font-serif`, etc.) that integrate with the existing
theme token system in `globals.css`. In the future, if Eigen adds user-selectable themes or white-labeling, the
font families could be overridden per-theme by reassigning these custom properties.

---

## Files Reference

| File                                                           | Current State                                   | Proposed Change                            |
|----------------------------------------------------------------|-------------------------------------------------|--------------------------------------------|
| `packages/ui/src/styles/globals.css`                           | Theme tokens, no font vars                      | Add `--font-*` tokens, import `fonts.css`  |
| `packages/ui/src/styles/eigen-prose.css`                       | Hardcoded system font stacks                    | Use `var(--font-sans)`, `var(--font-mono)` |
| `packages/ui/src/styles/fonts.css`                             | Does not exist                                  | Create with `@font-face` declarations      |
| `packages/ui/src/assets/fonts/`                                | Does not exist                                  | Create, add woff2 files                    |
| `packages/ui/src/components/layout/shadow-content.tsx`         | Hardcoded system font stack                     | Inject `@font-face`, use Inter             |
| `packages/ui/src/components/layout/media/font-picker.tsx`      | Does not exist                                  | Create font picker component               |
| `packages/lib/src/constants/fonts.ts`                          | Does not exist                                  | Create font registry                       |
| `apps/docs/src/components/docs/editor.tsx`                     | FontFamily extension not registered             | Register it                                |
| `apps/docs/src/components/docs/editor-toolbar.tsx`             | No font selector                                | Add FontPicker                             |
| `apps/slides/src/components/slides/types.ts`                   | No `fontFamily` on TextObject                   | Add field                                  |
| `apps/slides/src/components/slides/slide-object.tsx`           | No fontFamily in style                          | Apply it                                   |
| `apps/slides/src/components/slides/slide-properties-panel.tsx` | No font control                                 | Add FontPicker                             |
| `apps/drive/css/globals.css`                                   | Inconsistent heading scale, hardcoded code font | Align with eigen-prose                     |
| `packages/fortune-sheet/src/core/locale/en.ts`                 | System fonts in `fontarray`                     | Update to Eigen fonts                      |
| `packages/fortune-sheet/src/core/modules/cell.ts`              | Font-family CSS commented out                   | Uncomment                                  |
| `apps/*/index.html`                                            | No font preloading                              | Add `<link rel="preload">` for Inter       |
