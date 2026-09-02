# Typography & Self-Hosted Fonts

> **TLDR**: Four self-hosted variable font families (Inter, Source Serif 4, JetBrains Mono, Excalifont) served as
> Vite assets via `@font-face` declarations. A shared `EIGEN_FONTS` registry and `FontPicker` component provide
> font selection in docs, slides, and sheets. No external CDNs.

## Font Families

| Font               | Category   | Variable? | Weight Range | Usage                            |
|--------------------|------------|-----------|--------------|----------------------------------|
| **Inter**          | Sans-serif | Yes       | 100-900      | UI, body text, default font      |
| **Source Serif 4** | Serif      | Yes       | 200-900      | Documents, formal content        |
| **JetBrains Mono** | Monospace  | Yes       | 100-800      | Code blocks, inline code         |
| **Excalifont**     | Hand-drawn | No        | 400 only     | Stickies, whiteboard, sketch     |

All fonts are OFL-licensed. Inter includes an italic variant; Source Serif 4 includes an italic variant.

## CSS Architecture

Font files live in `packages/ui/src/assets/fonts/` as Vite assets (hashed, cached automatically).
`fonts.css` declares all `@font-face` rules and is imported by `globals.css`, which every app consumes.

Tailwind theme tokens in `globals.css`:

```css
--font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
--font-serif: "Source Serif 4", Georgia, "Times New Roman", serif;
--font-mono: "JetBrains Mono", "Fira Code", ui-monospace, monospace;
--font-hand: "Excalifont", "Comic Sans MS", cursive;
```

These enable Tailwind utilities: `font-sans`, `font-serif`, `font-mono`, `font-hand`.

`eigen-prose.css` uses `var(--font-sans)` for body text and `var(--font-mono)` for code. All fonts use
`font-display: swap` (text visible immediately with fallback, swaps when loaded).

## Font Registry

`EIGEN_FONTS` in `packages/lib/src/constants/fonts.ts` is the single source of truth for available fonts.
Each entry has `name`, `family` (CSS value with fallbacks), `category`, and `weights`. Inter is first in
the array; there is no exported default-font constant.

`getFontFamily(fontName)` resolves a font name to its CSS `font-family` value, falling back to
sans-serif for unknown names.

## FontPicker Component

`packages/ui/src/components/media/font-picker.tsx` renders a dropdown menu of all `EIGEN_FONTS`.
Each item previews in its own typeface. Props: `value` (font name), `onChange` (callback with font name).

Used in:
- **Docs** (`apps/docs/src/components/docs/editor-toolbar.tsx`) -- via Tiptap `FontFamily` extension
- **Slides** (`apps/slides/src/components/slides/slide-properties-panel.tsx`) -- via `fontFamily` on `TextObject`
- **Sheets** (`packages/sheet/src/components/MenuBar/format-toolbar.tsx`) -- the same `FontPicker`, straight
  in the engine's toolbar. The engine's own font lists are derived, not hand-written:
  `packages/sheet/src/state/modules/fonts.ts` builds `FONT_ARRAY` and `FONT_INDEX_BY_NAME` from `EIGEN_FONTS`
  (`FONT_INDEX_BY_NAME` maps lowercased name → index, because a cell's `ff` may be stored as an index into `FONT_ARRAY`)

## Adding a New Font

1. Add the `.woff2` file(s) to `packages/ui/src/assets/fonts/<font-name>/`
2. Add `@font-face` declaration(s) to `packages/ui/src/styles/fonts.css`
3. Add an entry to `EIGEN_FONTS` in `packages/lib/src/constants/fonts.ts`
4. (Optional) Add a `--font-*` token to `globals.css` if the font fills a new category
5. Nothing to do for sheets -- it picks the font up automatically from `EIGEN_FONTS`

The `FontPicker` automatically picks up new entries from `EIGEN_FONTS`.

## Key Files

| File                                                          | Purpose                              |
|---------------------------------------------------------------|--------------------------------------|
| `packages/ui/src/assets/fonts/`                               | Self-hosted woff2 font files         |
| `packages/ui/src/styles/fonts.css`                            | `@font-face` declarations            |
| `packages/ui/src/styles/globals.css`                          | `--font-*` Tailwind theme tokens     |
| `packages/ui/src/styles/eigen-prose.css`                      | Prose typography (body, headings)     |
| `packages/lib/src/constants/fonts.ts`                         | `EIGEN_FONTS` registry, `getFontFamily()` |
| `packages/ui/src/components/media/font-picker.tsx`     | Shared font picker component         |
| `packages/sheet/src/state/modules/fonts.ts`                    | Sheets font list, derived from `EIGEN_FONTS` |

## Future: CJK Support

Noto Sans/Serif fonts for Chinese, Japanese, and Korean are not yet bundled. Full CJK font files are ~16MB each,
so they will require on-demand loading via `unicode-range` splitting in `@font-face` declarations.
