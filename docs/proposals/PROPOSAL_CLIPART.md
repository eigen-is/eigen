# Proposal: Clipart and Path Shapes

This proposal adds a bundled library of 2000s-era vector clipart to Eigen's canvas engine (`apps/vector` and `apps/slides`), built on the general-purpose `path` canvas element kind, so that every clipart asset can be restyled as a single canvas element and unpacked ("ungrouped") into native, individually editable canvas primitives.

**Status:** the `path` kind is built, and [CANVAS.md § A path is stored in its unit box](../CANVAS.md#a-path-is-stored-in-its-unit-box) describes it. This page designs the rest, none of it built: the clipart catalog, the `clipart` kind, its Convert to shapes and the picker (Phases 2 to 4).

> **TLDR**: Eigen's canvas engine draws rectangles, diamonds, ellipses, pies, lines, arrows, freehand strokes, paths, rich text, images and charts. It has no bundled illustration library. This proposal adds one thing that fits the exact architecture charts established: a **`clipart` element kind** (`VectorClipartElement`) backed by a curated, offline, zero-AI-slop catalog of nostalgic 2000s Microsoft Office–style vector illustrations. On the canvas, a clipart element responds to the standard Fill, Stroke, Sketch (Architect / Artist / Cartoonist) and Opacity controls, re-stylizing the entire illustration in one click while allowing per-slot color overrides in its panel section. Selecting **Convert to shapes** (the same `toShapes` / `replaceElementInDoc` seam charts use) unpacks a clipart element in place into its constituent `path`, `ellipse`, `rectangle`, `pie` and `line` elements, each with a deterministic seed so not a single hatch line or rough stroke jumps on unpack.

## Goals

1. **Nostalgic, AI-slop-free illustration library**: Ship a curated, searchable, categorized catalog of ~150–300 human-crafted vector illustrations inspired by 2000s Microsoft Office Clip Organizer (Screen Beans, isometric office equipment, expressive metaphors, banners, badges and stickers), bundled locally with zero external network requests.
2. **First-class canvas styling on every clipart**: A clipart on a slide or drawing is not a dead `<image>` or opaque SVG blob. Changing its Sketch style (Architect `roughness: 0`, Artist `1`, Cartoonist `2`), Fill style (`solid`, `hachure`, `cross-hatch`, `zigzag`), Stroke width/style/color, or palette re-renders the clipart through the canvas engine's `roughjs` pipeline.
3. **One-click unpack into native canvas primitives**: "Convert to shapes" (and `⌘⇧G` / Ungroup) replaces a clipart element with its native constituent canvas elements in one sealed undo step, using the exact `KindSpec.toShapes` and `replaceElementInDoc` mechanism introduced for charts.
4. **Identical rendering everywhere**: Live canvas, slide thumbnails, present mode, server previews, standalone SVG download, HTML, PDF (WeasyPrint) and PPTX export all render from the same pure, DOM-free layout and painter.

## Non-goals

- **Generative AI or external clipart APIs**: No prompts, no runtime fetches to third-party icon/clipart services, no raster clip art. Every asset is a deterministic vector definition checked into the repository under a permissive license.
- **Nested group trees in the Yjs model**: The canvas engine deliberately avoids nested group hierarchies (`no groupId in packages/lib/src/vector/types.ts`). Like charts, a clipart is a single composite element while whole, and unpacks flat into its z-order slot when broken apart.
- **Full arbitrary SVG 2 filter/mask/scripting support**: The `path` kind models geometric vector paths (`M`, `L`, `C`, `Q`, `Z`), not SVG `<filter>`, `<feGaussianBlur>`, CSS animations or embedded bitmaps.
- **In-canvas Bézier node-editing tool**: `path` elements are created by unpacking clipart (or from a shape picker) and transform via `ObjectTransform` (move, resize, rotate, flip). A pen tool / vertex-handle editor for `path` control points is an optional later phase.

## Current state

**How `chart` solved the composite-element problem.** The chart code is on the branch: `chartKind` (`packages/lib/src/vector/kinds/chart.ts`) established the pattern for a compound element in the canvas engine:
- `layoutChart` (`packages/lib/src/charts/layout.ts`) is a pure, synchronous function that decomposes a chart into an ordered array of real `VectorElement` records (`rectangle`, `line`, `ellipse`, `pie`) in the element's local coordinate frame (`0..width`, `0..height`), each with a deterministic id `${chart.id}:${key}` and a deterministic seed `seedOf(chart.seed, key)`.
- `renderChartSvg` (`packages/lib/src/vector/kinds/chart-render.ts`) renders the chart by iterating those child shapes and calling each shape kind's own `render(shape, {})` inside `${elementGroupOpen(shape)}${body}</g>`.
- `KindSpec` (`packages/lib/src/vector/kinds/kind.ts`) has `toShapes?(el: T): VectorElement[]`, exposed via `convertToShapes(el)` in `kinds/index.ts`.
- `CanvasObjectMenu` (`packages/ui/src/components/context-menu/object-context-menu.tsx`) and `ChartPanelSection` (`packages/ui/src/components/vector/kinds/chart.tsx`) offer **Convert to shapes**, which calls `convertElementToShapes` → `replaceElementInDoc` (`packages/ui/src/components/vector/hooks/element-writes.ts`). That transaction deletes the composite element and writes the unpacked elements into its exact fractional-index z-slot, keeping their seeds so the drawing does not shift by a single pixel.
- `eigenslidesToPptx` (`apps/api/src/lib/export/slides/to-pptx.ts`) exports a `chart` by calling `convertToShapes(el).map((shape) => elementXml(shape, slide)).join('')`.

**Export sanitizer constraints.** `sanitizeExportHtml` (`apps/api/src/lib/export/sanitize.ts`) strips external references and `clip-rule`, and WeasyPrint 68.1 has known quirks with `<mask>` on groups and `clip-rule="evenodd"` ([EXPORT.md](../EXPORT.md), [CANVAS.md](../CANVAS.md#the-label-cuts-a-hole-in-the-shaft)). Non-zero winding (`fill-rule="nonzero"`, the SVG default) with oppositely wound inner subpaths works in every browser, in `roughjs`'s `pointsOnPath` hatch filler, in WeasyPrint and in DrawingML `<a:custGeom>`.

## The 2000s Microsoft Clipart Aesthetic

What made Office 97 / 2000 / XP clipart (`.wmf` / `.emf` vector metafile art) iconic, joyful and immediately distinct from modern corporate Memphis or AI-generated imagery:

1. **Three signature visual idioms**:
   - **Screen Beans**: Expressive, ink-black silhouette figures with oversized rubber-hose hands and feet, interacting with crisp colored props (holding a giant magnet, puzzling over a question mark, sprinting with a briefcase, celebrating at a finish line).
   - **Warm Isometric Office & Tech**: Slightlytilted 3/4 perspective objects—CRT monitors, beige towers, 3.5" floppy disks, rotary and mobile phones, filing cabinets, manila folders, coffee mugs, pushpins, clipboards, globes and trophies—drawn with bold outer contours and stepped 2–3 tone cel shading.
   - **Graphic Badges, Ribbons & Callouts**: Starbursts ("NEW!"), curled scroll banners, wax seals, checkmarks, warning triangles, directional hands, puzzle pieces and lightbulb/gear metaphors.
2. **Flat cel-shaded fills + stepped highlights, not complex meshes**: Because WMF/EMF predated SVG filters and mesh gradients, artists created depth by layering 2 to 4 discrete filled polygons (base color, shadow shape, highlight crescent) under a darker ink outline. This maps 1:1 to a stack of canvas primitives!
3. **Structured 3–5 slot palettes**: Each illustration uses a small number of semantic color roles (`ink`, `primary`, `secondary`, `accent`, `highlight`/`surface`). That makes recoloring or applying a fill hatch across a whole clipart predictable and clean.
4. **Host-aware personality**:
   - Dropped onto **Vector** (`VECTOR_STYLE_DEFAULTS`: `roughness: 1`, `cross-hatch` fill), a 2000s clipart renders as a charming hand-inked, hatched notebook illustration.
   - Dropped onto **Slides** (`SLIDES_STYLE_DEFAULTS`: `roughness: 0`, `solid` fill), the exact same clipart renders with crisp, classic Office 2000 flat/cel-shaded vector precision—until the user cranks Sketch up to Artist or Cartoonist.

## Design

### 1. Clipart catalog & asset representation (`packages/lib/src/clipart/`)

Clipart definitions live in a new React-free subpath `@workspace/lib/clipart`, registered as BE-safe alongside `vector` and `charts` ([ARCHITECTURE.md § Backend imports of lib](../ARCHITECTURE.md#backend-imports-of-lib)).

Each catalog entry is a `ClipartAsset` compiled at build time from clean source SVGs via an offline script (`bun scripts/build-clipart.ts`), just as `chart-text-widths.ts` compiles font metrics:

```typescript
export type ClipartColorSlot = 'primary' | 'secondary' | 'accent' | 'surface' | 'ink';

export type ClipartPart =
    | {
          kind: 'path';
          key: string;
          box: { x: number; y: number; width: number; height: number; angle?: number }; // in [0, 1] × [0, 1] asset space
          path: string; // normalized [0, 1] × [0, 1] within `box`
          closed: boolean;
          fillSlot?: ClipartColorSlot | null; // null = no fill
          strokeSlot?: ClipartColorSlot | null; // null = no stroke
          strokeWeight?: number; // multiplier on element.strokeWidth (default 1)
           hatchable?: boolean; // true for primary/secondary/accent fills; false for tiny eyes/highlights
      }
    | {
          kind: 'ellipse' | 'rectangle' | 'diamond' | 'pie' | 'line';
          key: string;
          box: { x: number; y: number; width: number; height: number; angle?: number };
          // shape-specific normalized parameters (corners, startAngle/sweepAngle, points)
          fillSlot?: ClipartColorSlot | null;
          strokeSlot?: ClipartColorSlot | null;
          strokeWeight?: number;
          hatchable?: boolean;
      };

export type ClipartAsset = {
    id: string; // e.g. 'bean-idea', 'retro-pc', 'floppy-disk', 'trophy-gold', 'banner-scroll'
    title: string;
    category: 'beans' | 'office' | 'tech' | 'metaphors' | 'badges' | 'arrows-callouts';
    keywords: readonly string[]; // feeds picker search and canvas ⌘F searchText
    aspectRatio: number; // default width / height
    defaultSlots: Partial<Record<ClipartColorSlot, string>>; // nostalgic 2000s default hex colors
    parts: readonly ClipartPart[];
};
```

**Why each part carries its own sub-box (`box`) inside the asset.** If a coffee mug has a circular rim (`ellipse`), a rectangular label (`rectangle`) and a curved handle (`path`), storing each part in its own tight local sub-box means that when the user clicks **Convert to shapes**, the rim unpacks as a true `ellipse` bounded tightly around the rim, the label unpacks as a `rectangle` bounded tightly around the label, and the handle unpacks as a `path` bounded tightly around the handle—never 15 overlapping full-canvas bounding boxes!

### 2. The `clipart` canvas element kind (`VectorClipartElement`)

```typescript
export type VectorClipartElement = VectorElementBase &
    Fillable & {
        type: 'clipart';
        clipartId: string; // key in CLIPART_CATALOG
        // Optional JSON map of slot color overrides: `{"primary":"#e03131","secondary":"#fab005"}` or ''
        colors: string;
        // 'original' uses the asset's nostalgic multi-color palette (+ any `colors` overrides) with `fill.style`
        // for hatches; 'monotone' paints the primary/secondary slots with the element's `fill` paint (solid or gradient!).
        colorMode: 'palette' | 'fill';
    };
```

**How standard canvas controls map onto a `clipart` element (`layoutClipart`):**

| Canvas Control / Field | Effect on `VectorClipartElement` |
|---|---|
| **Fill → Style** (`solid`, `hachure`, `cross-hatch`, `zigzag`) | Applies the hatch style to every `hatchable` filled part of the clipart. In Vector, new clipart starts hatched; in Slides, solid. |
| **Fill → Color / Gradient** | In `'palette'` mode (default), setting a Fill color/gradient sets the `primary` slot (and switches to `'fill'` mode if a gradient is chosen); in the Clipart panel section, each used color slot (`primary`, `secondary`, `accent`, `surface`) has its own color swatch plus a **Reset to original colors** button. |
| **Stroke → Color / Width / Style** | Controls the ink outline (`ink` slot) across all parts: `strokeColor` colors the outlines, `strokeWidth` scales every part's stroke (`part.strokeWeight * el.strokeWidth`), and `strokeStyle` (`solid`, `dashed`, `dotted`) dashes the outlines. Setting Stroke to `None` (`strokeOptional: true`) hides the ink outlines for a flat lineless look. |
| **Sketch → Style** (`Architect` 0, `Artist` 1, `Cartoonist` 2) | Sets `el.roughness` on every constituent shape. At `0`, the clipart looks like classic crisp Office 2000 WMF art; at `1` or `2`, roughjs jitter and double-strokes give it an unmistakable hand-drawn Excalidraw feel. |
| **Appearance → Opacity** | Applied once on the element's layer, just like charts and shapes. |
| **Resize / Rotate** (`ObjectTransform`) | `useAspectLock` starts locked (`true`) for clipart (like `image`), and can be unlocked in the Transform panel to stretch or squash. |

**Deterministic seeds (`seedOf(el.seed, part.key)`).** Just like `layoutChart`, `layoutClipart(el)` turns the `VectorClipartElement` into an ordered array of concrete `VectorElement` primitives (`path`, `ellipse`, `rectangle`, `diamond`, `pie`, `line`) in the clipart's local `0..width × 0..height` frame, with `id: "${el.id}:${part.key}"` and `seed: seedOf(el.seed, part.key)`. `renderClipartSvg(el)` renders each primitive through its own kind's `render`.

If `el.clipartId` is not in `CLIPART_CATALOG` (e.g. a peer on a newer version placed an asset this build lacks), `clipartKind.read` preserves `clipartId` as stored and `renderClipartSvg` draws the standard dashed `PLACEHOLDER_STROKE` box, matching `chartKind`'s forward-compatibility rule.

### 3. Ungrouping / "Convert to shapes"

Because `layoutClipart(el)` produces real `VectorElement` records that `renderClipartSvg` draws directly:
- `clipartKind` implements `toShapes: clipartToElements` on `KindSpec`.
- `clipartToElements(el)` takes `layoutClipart(el)`, rotates each part's local box center around the clipart's center by `el.angle`, adds `el.angle` to the part's angle, multiplies `opacity`, and stamps `frameId: el.frameId`.
- Because `convertToShapes(el)` (`packages/lib/src/vector/kinds/index.ts`) delegates to `ELEMENT_KINDS[el.type].toShapes(el)`, **every existing Convert to shapes surface works automatically**:
  - Right-click context menu → **Convert to shapes** (`CanvasObjectMenu`)
  - Properties panel → **Convert to shapes** button in `ClipartPanelSection`
  - Keyboard shortcut: bind `⌘⇧G` (`Ctrl+Shift+G`) to run `convertElementToShapes` when a single unpackable element (`selectionShapes(selectedIds, byId).length > 0`) is selected, matching user expectations for "Ungroup" in vector tools.
  - PPTX export (`to-pptx.ts`): `case 'clipart'` calls `convertToShapes(el).map((shape) => elementXml(shape, slide)).join('')`, turning every clipart into native, editable PowerPoint shapes in exported `.pptx` decks!
- Because each unpacked element keeps its `seedOf(el.seed, part.key)` seed and exact geometry, **unpacking a clipart produces zero visual change on screen**—the single selection box simply splits into the individual shapes, all selected, ready to be dragged apart, deleted, recolored or bound with arrows. One `⌘Z` restores the single clipart element.

### 4. UI: Inserting and customizing Clipart

1. **Toolbar & Insert Menu (`CanvasToolbar`)**:
   - In `Insert`, add **Clipart…** (icon: `Sparkles` or `Sticker`, below `Image` and `Chart`).
   - Clicking opens a lightweight **Clipart Picker Dialog** (or popover) with:
     - Search input matching `title`, `category` and `keywords` (e.g. "computer", "bean", "floppy", "idea", "trophy").
     - Category tabs: *All*, *Screen Beans*, *Office & Business*, *Retro Tech*, *Metaphors*, *Badges & Banners*, *Callouts*.
     - A preview toggle in the corner (**Classic flat** vs **Hand-drawn**) or automatic preview in the host's style (`VECTOR_STYLE_DEFAULTS` in Vector, `SLIDES_STYLE_DEFAULTS` in Slides).
     - Clicking an item calls `canvasRef.current?.insertClipart(asset.id)`, placing it at the viewport center at a sensible default size (e.g. `240 × 240` scaled by `aspectRatio` on infinite canvas, `360 × 360` on a slide) and selecting it.
2. **Properties Panel (`ClipartPanelSection`)**:
   - Shown when one or more `clipart` elements are selected.
   - **Colors**: Swatches for each color slot present in the selected clipart (`Primary`, `Secondary`, `Accent`, `Surface`), plus a **Reset colors** action to restore the 2000s defaults.
   - **Swap clipart…** button (when 1 selected) to switch the illustration while keeping its box, angle and sketch style.
   - **Convert to shapes** button (`<Shapes /> Convert to shapes`), identical to `ChartPanelSection`.

### 5. Curating and building the 2000s Clipart Catalog (No AI Slop)

To guarantee an authentic, cohesive 2000s aesthetic with zero AI artifacts (no stray floating blobs, no auto-traced 5,000-node splines, no inconsistent perspectives):
1. **Strict geometry budget per asset** enforced by `scripts/build-clipart.ts` and a unit test:
   - At most **32 parts** per clipart asset (`MAX_CLIPART_PARTS = 32`).
   - At most **64 path commands** per `path` part.
   - Every hole must use opposite winding so `fill-rule="nonzero"` works in roughjs, browsers, WeasyPrint and PowerPoint alike.
   - Prefer native `ellipse`, `rectangle`, `diamond`, `pie` and `line` parts wherever a sub-shape is geometric, reserving `path` for true Bézier contours. This makes **Convert to shapes** yield clean ellipses and rectangles for wheels, screens, buttons and papers!
2. **Initial ~60-asset starter pack across 6 categories**:
   - *Screen Beans (12)*: Idea (lightbulb overhead), Confused (`?`), Sprinting with briefcase, Lifting heavy weight, Celebrating/Trophy, Presenting at board, Magnifying glass detective, Tightrope walker, Juggling, Crossroad sign, Megaphone announcer, Teamwork handshake.
   - *Retro Tech (12)*: Beige CRT monitor, 3.5" floppy disk, CD-ROM with rainbow glint, Dot-matrix printer, Flip phone, Classic mouse, Server rack, Dial-up modem / globe-on-wire, Keyboard, Cassette tape, Battery, Retro laptop.
   - *Office & Desk (12)*: Rolodex, Red swingline stapler, Coffee mug ("#1"), Manila folder, Clipboard with checklist, Filing cabinet, Calculator, Pushpin, Paperclip (non-trademarked loop), Desk lamp, Hourglass, Briefcase.
   - *Metaphors & Targets (10)*: Bullseye with dart, Key & padlock, Magnet pulling coins, Puzzle pieces locking, Lightbulb, Gear pair, Trophy cup, Rocket launch, Anchor, Compass.
   - *Badges & Banners (8)*: 3D ribbon scroll, Starburst ("NEW"), Wax seal with ribbons, Checkmark shield, Warning triangle, Gold medal, Price tag, Certificate frame.
   - *Callouts & Pointers (6)*: Comic speech cloud, Jagged shout burst, Pointing manicule hand, Curved 3D-style block arrow, Question/Exclamation pair, Sticky note with tape.

## Security, Limits and Validation

- `clipartId` is validated against ` /^[a-z0-9-]{1,64}$/`. Unknown IDs render the bounded placeholder and do not throw.
- `colors` JSON is capped at 1 KiB and parsed through `isColorToken` (`#rrggbb` / `#rrggbbaa` / `transparent`); any invalid slot key or color token is dropped on read, so no CSS `url(...)` paint-server injection is possible.
- Preview budget: like `chart`, a `clipart` element counts as 1 element in the Y.Doc, and `MAX_CLIPART_PARTS = 32` bounds the `roughjs` work per clipart in `preview-scene.ts`.

## Decisions to approve

1. **Add `clipart` (`VectorClipartElement`) as a composite canvas kind** following the `chart` architecture: pure `layoutClipart` → `VectorElement[]` in local space, painted through the shape kinds' own renderers, and unpacked via `KindSpec.toShapes` ("Convert to shapes" + `⌘⇧G`).
2. **Color model for `clipart`**: keep the asset's multi-slot 2000s palette (`primary`, `secondary`, `accent`, `surface`, `ink`) with per-slot overrides in the panel, while wiring the standard **Fill** block (hatch style + primary/monotone fill), **Stroke** block (ink color, width, dash, optional off) and **Sketch** block (`roughness`) directly to the element's base fields.
3. **Ship an initial ~60-asset curated library** in `@workspace/lib/clipart`, compiled and budget-checked at build time with zero external network dependencies.

## Phasing

Each phase is self-contained and verifiable with `bun run check`.

2. **Phase 2: Clipart model, `clipart` kind and Convert to shapes (M).**
   - Create `packages/lib/src/clipart/` (`@workspace/lib/clipart` BE-safe subpath) with `ClipartAsset` types, `layoutClipart`, `parseClipartColors` and the first 12 reference assets (2 per category).
   - Implement `packages/lib/src/vector/kinds/clipart.ts`, `clipart-render.ts` and `clipart-convert.ts` (`toShapes: clipartToElements`), plus `case 'clipart'` in `to-pptx.ts`.
   - Wire `⌘⇧G` (`Ctrl+Shift+G`) in `use-canvas-keyboard.ts` to `convertElementToShapes` for any single selected unpackable element (works for both `chart` and `clipart`).
   - Unit tests for paint parity (clipart vs unpacked shapes are byte-identical up to element IDs), seed determinism, undo/redo of Convert to shapes, and placeholder fallback for unknown `clipartId`.
3. **Phase 3: Clipart Picker UI & Properties Panel (S–M).**
   - Add `ClipartPanelSection` in `packages/ui/src/components/vector/kinds/clipart.tsx` (slot color swatches, Reset colors, Swap clipart, Convert to shapes).
   - Add the Clipart Picker dialog and `Insert → Clipart…` in `CanvasToolbar` + `CanvasHandle.insertClipart`.
   - Update `useAspectLock` so `clipart` defaults to aspect-locked on resize like `image`.
4. **Phase 4: Full 2000s Clipart Catalog & Docs (M).**
   - Expand the catalog to ~60+ assets across the 6 nostalgic categories, validated by `scripts/build-clipart.ts` (part count, command count, winding order, native primitive preference).
   - Update `docs/CANVAS.md`, `docs/SLIDES.md`, `docs/EXPORT.md` and the help center articles (`apps/index/src/data/support/`).

## Testing

1. **Unpack paint parity**: For every asset in `CLIPART_CATALOG`, rendering the `clipart` element and rendering the scene produced by `convertToShapes(el)` produce identical SVG paths and roughjs seeds.
2. **Style responsiveness**: Changing `roughness` (0 → 1 → 2), `fill` hatch style (`solid` → `hachure` → `cross-hatch` → `zigzag`), `strokeWidth`, `strokeStyle`, `strokeColor` (including `transparent`) and slot colors updates the rendered SVG deterministically in both browser and API Worker.
3. **Arrow binding before and after unpack**: An arrow bound to a `clipart` docks to its box; after **Convert to shapes**, a new arrow binds to any unpacked `path`, `ellipse` or `rectangle` and docks onto its true contour (`outline.ts`).
4. **Export & preview formats**: Verify live canvas, server preview (`preview-scene.ts`), standalone `.svg` download, `.html`, `.pdf` (WeasyPrint non-zero winding and gradients) and `.pptx` (`<a:custGeom>` shapes in PowerPoint, Keynote and LibreOffice).
5. **Untrusted input bounds**: An unknown `clipartId` and malformed `colors` JSON degrade safely at `readVectorFromDoc` without throwing.

## Evidence

- Canvas element model & registry: `packages/lib/src/vector/types.ts`, `packages/lib/src/vector/kinds/kind.ts` (`KindSpec`, `toShapes`), `packages/lib/src/vector/kinds/index.ts` (`ELEMENT_KINDS`, `convertToShapes`), `packages/lib/src/vector/kinds/render-utils.ts` (`renderRoughShape`, `shapeDrawable`, `baseRoughOptions`, `fillDefs`).
- Chart composite-element & Convert-to-shapes precedent (the chart code in `packages/lib/src/charts` and the `chart` kind under `packages/lib/src/vector/kinds`): `packages/lib/src/vector/kinds/chart.ts`, `packages/lib/src/vector/kinds/chart-render.ts`, `packages/lib/src/vector/kinds/chart-convert.ts`, `packages/lib/src/vector/kinds/pie.ts`, `packages/ui/src/components/vector/hooks/element-writes.ts` (`replaceElementInDoc`), `packages/ui/src/components/vector/hooks/selection-ops.ts` (`convertElementToShapes`), `packages/ui/src/components/context-menu/object-context-menu.tsx`.
- Outlines & arrow docking: `packages/lib/src/vector/outline.ts` (`OutlineShape`, `outlinePath`, `outlineHits`), `packages/lib/src/vector/geometry.ts`.
- Exports & sanitization: `apps/api/src/lib/export/slides/to-pptx.ts` (`elementXml`, `customXml`), `apps/api/src/lib/export/sanitize.ts` (`sanitizeExportHtml`).
