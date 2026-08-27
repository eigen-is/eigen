# Proposal: eigen|vector> — an Eigen-native drawing & diagramming app

> **TLDR**: Build a collaborative drawing app with Excalidraw's look and tool set — hand-drawn roughjs rendering, our existing Excalifont hand font, the same shapes/arrows/freedraw/text — as an **Eigen-native engine written from scratch**, not by embedding `@excalidraw/excalidraw` and not by forking it. The scene model, geometry, fractional-index z-order, and a pure `sceneToSvg()` renderer live in a React-free `packages/lib/src/vector/` subpath (the `packages/lib/src/sheets/` precedent), shared verbatim by the frontend, previews, and the server transform Worker. The interactive editor lives in `packages/ui/src/components/vector/` built entirely from Eigen's shadcn toolbars, dialogs, and properties panels, and a **new shared `ObjectTransform` selection/resize/rotate primitive** extracted from slides — a standing goal of ours, one component across docs/slides/sheets/vector. Collab is Eigen's Yjs `CollabDocument` backend with a per-element `Y.Map` for field-level merge. Storage is a `.eigenvector` container; drawings embed in docs/slides/sheets as **nested `.eigenvector` sub-resources** under a `drawings/` folder, exactly like comment threads nest `.eigenchat` containers today. We adopt Excalidraw's proven internals — element field shape, fractional indexing, roughjs, perfect-freehand, their binding/hit-testing math — as studied reference and small vendored MIT pieces, not as a dependency graph. This is a multi-month program; the phase estimates below are honest, not optimistic.

## Goals

1. **A real drawing app in the suite.** Shapes (rectangle, diamond, ellipse), lines, arrows, freehand, text, and images on an infinite canvas, collaboratively editable — the Google Drawings / Excalidraw whiteboarding gap in Eigen today.
2. **Excalidraw's aesthetic and feel, on our engine.** The sketchy roughjs stroke, a handwriting font, the same tool palette and shortcuts — achieved with Eigen's chrome (shadcn toolbars, dialogs, properties panels), not Excalidraw's fixed UI.
3. **One shared transform primitive.** Extract the selection/resize/rotate interaction and chrome into `packages/ui` so vector, slides, docs, and sheets stop each carrying their own. This is a pre-existing objective, not a side effect.
4. **Embeddable everywhere collab lives.** A drawing dropped into a doc, slide, or sheet is a first-class collaborative sub-resource of that host, sharing its ACL, copied when the host is duplicated, and hidden from Drive as a standalone file.
5. **Full pipeline parity.** Drive previews, HTML/PNG/PDF/SVG export, and search extraction, all through Eigen's existing worker pipeline — no browser runtime, no headless canvas.

## Non-goals

- **Embedding or forking Excalidraw.** Decided below (§ Decision). We study and vendor small pieces; we do not take the package or the repo.
- **Frames, embeddable iframes, and mermaid-to-diagram import.** Excalidraw ships these (`element/src/types.ts:206` — `frame`, `magicframe`, `iframe`, `embeddable`); they are out of scope for v1. Mermaid pulls in the full CodeMirror 6 stack in Excalidraw's own build — not a dependency we take on.
- **Re-rendering slides on the vector engine.** The old proposal's "Phase 7" astronautics. Slides works on DOM rendering; users want shapes *in* slides, delivered by embedding drawings, not by rewriting a working renderer. Marked **maybe-never**, as before. Sharing only the *renderer* is a different and much cheaper proposition — see § Native shape objects in slides.
- **A new top-level workspace package.** The engine is a `packages/lib` subpath and the editor is a `packages/ui` component. `packages/sheet` is a fork special-case, not a precedent (AGENTS.md); the lib+ui split is the norm and lets docs/slides/sheets consume the editor with no new workspace dependency.
- **Point-level collaborative editing of freehand strokes.** Strokes commit once; their points are a serialized payload, not per-point CRDT state (§ Yjs data model).

## Current state — what the codebase already gives us

The evidence below is why an own engine is *feasible here*, not a rewrite of Figma. Eigen already carries the hard scaffolding; the drawing surface is the new part.

- **Registering a new collaborative document type is a well-worn path.** Two source-of-truth registries — `EIGEN_DOC_TYPE_INFO` and `EIGEN_DOC_ICONS` in `packages/lib/src/types/drive.ts` + `packages/lib/src/core/eigendoc-icons.ts` — are `satisfies Record<EigenDocType, …>`, so TypeScript *forces* the new entry and auto-propagates it to the New menu, command palette, drive icons/colors, and validation schema. The remaining touchpoints are hardcoded but enumerable (§ `.eigenvector` registration). Creation itself is already generic: `Drive.create(mountId, parentId, name, type, user)` (`apps/api/src/lib/drive/drive.ts:274`) derives the extension from `DRIVE_EXTENSIONS[type]` and the mime from `EIGEN_DOC_TYPE_INFO[type].mime`, then calls `CollabDocument.create(...)`. No new create route is needed.
- **The collab backend is depth- and type-agnostic.** `CollabRegistry` (`apps/api/src/lib/drive/collab-registry.ts`) keys open docs on `${ownerId}.${mountId}.${pathId}` and throws 404 only when `!isCollabType(path.type)`. A `.eigenvector` container is addressable at `/ws/collab/:ownerId/:mountId/:pathId` exactly like any doc, at any nesting depth. `CollabDocument.create` (`apps/api/src/lib/collab/collabDocument.ts:166`) provisions `data.db` + `comments.db` + `media/` + `chat/` for every collab container.
- **Nested collab containers already ship in production.** A comment thread is a full `.eigenchat` container living at `mydoc.eigendoc/chat/comment-1.eigenchat/` with its own `data.db` and `media/` (`docs/COMMENTS.md`; `packages/lib/src/core/comments/hooks/use-create-comment-card.ts:64`). `docContainerDescendantIds` (`apps/api/src/lib/mount/helpers.ts:38`) is a recursive CTE that hides every container descendant from Drive listings and search. So a nested drawing is invisible as a standalone file — exactly the embed behaviour we want — and its ACL is inherited because `canRead/canWrite` walk the full breadcrumb (`drive.ts:1038/1046`). Container copy is type-generic, so duplicating a host doc copies its drawings for free.
- **The slides editor is the template.** `apps/slides/src/components/slides/hooks/use-deck.ts` is the pattern to imitate: three Yjs roots (`doc.getMap('slides')`, `doc.getMap('objects')`, `doc.getArray('slideOrder')`, matching `EIGEN_DOC_TYPE_INFO.slides.yjsRoots`), each object a nested `Y.Map` normalized through a fixed `OBJECT_FIELDS` allow-list (`use-deck.ts:11`), `new Y.UndoManager([...roots])` (line 110), every edit wrapped in `doc.transact(...)`, and a `WebsocketProvider(wsUrl, '', doc, { resyncInterval: 5000 })` (lines 112–117). This is 60–70% of a drawing app's plumbing, already debugged.
- **Selection chrome exists but is per-app.** `apps/slides/src/components/slides/slide-selection-chrome.tsx` is the richest implementation — an `.eigen-selection-ring` overlay (line 48) with `.eigen-selection-handle` resize grips (line 61) and a separate rotate grip. The shared classes live in `packages/ui/src/styles/globals.css:621`. `packages/ui/src/components/media/image-resize-handles.tsx` reuses the same classes for docs images. Nobody owns the *interaction*; each app re-derives drag/resize math. This is the extraction opportunity in Goal 3.
- **The transform pipeline is generic over document type.** `apps/api/src/lib/document/transform/` runs one Worker at a time behind a per-*kind* limits table (`TRANSFORM_LIMITS` in `runner.ts`: preview 30s kill / 15s admission, export 120s / 30s) — a new *type* adds no row, it plugs into existing kinds. eigenslides preview is proof of the shape we need: `readDeckFromDoc(doc)` → `renderDeckHtml()` → DOMPurify → `{ body }` HTML string, **no image, no browser** (`apps/api/src/lib/preview/eigenslides-render.ts`). jsdom already runs *inside* a Worker (`apps/api/src/lib/import/doc/from-docx.ts:51`), and `sharp` (main-thread) rasterizes SVG→PNG, WeasyPrint (main-thread subprocess) turns HTML→PDF.
- **The `packages/lib/src/sheets/` subpath is the exact precedent for a React-free shared engine.** `packages/lib/package.json` exports `"./sheets": "./src/sheets/index.ts"` and `"./sheets/*"`, and `src/sheets/index.ts` re-exports pure snapshot codecs + types with no React import — importable by both the frontend and `apps/api` Workers. `packages/lib/src/vector/` gets the same treatment.

## Decision — build from scratch, adopt the internals

**We build an Eigen-native engine. We do not embed `@excalidraw/excalidraw`, and we do not fork the repo.** The look and functionality come from adopting Excalidraw's proven internals (element model, fractional indexing, roughjs, perfect-freehand, their geometry/binding math) as studied reference and small vendored MIT pieces — not from taking on their runtime.

### Why not embed `@excalidraw/excalidraw`

- **The chrome is fixed without a fork, and Eigen's whole identity is its shared chrome.** The toolbar and tool palette (`components/Actions.tsx`, `ShapesSwitcher`), the properties panel (`SelectedShapeActions`), keyboard shortcuts (per-action in `actions/`), and i18n (module-private locale table, no injection API) are **not customizable through props** — only colors via CSS variables, the menus/footer/sidebar slots, and `tools.image` toggle are. "Exactly Excalidraw's look" via the embed means accepting *Excalidraw's UI*, which is the opposite of what we need: Eigen's shadcn toolbars, our dialogs, our properties panels, our shortcuts, our shared `ObjectTransform`. There is no path from the embed to those without forking.
- **Embedding buys no collaboration.** Excalidraw's sync/collab code is in the **unpublished `excalidraw-app/`**, not the npm package. There is no first-party Yjs binding (a grep for `yjs|y-websocket|Y.Doc` across the repo returns nothing). Embedding means writing the entire Yjs bridge ourselves against an *uncontrolled* scene (there is no `elements` prop; `onChange` hands you the full array ~60×/sec, `App.tsx:4272`) — and then owning a translation layer between Excalidraw's per-element LWW and our CRDT for the life of the app.
- **Server-side previews are risky.** Excalidraw's `exportToSvg` builds a real DOM SVG tree and is browser/React-coupled; under jsdom, canvas text metrics are stubbed to 0, so text elements would lay out broken without a `measureText` shim. Our own engine sidesteps this entirely: `sceneToSvg()` is a pure string function that trusts client-measured text dimensions, so it needs no DOM at all.
- **The version cadence is a trap.** npm releases are ~16 months apart (0.17.0 → 0.18.0), and the delta APIs a clean bridge would want — `onIncrement`, `applyDeltas` — exist **only on master**, likely not in any published version. We would build against APIs we cannot install.

### Why not fork

A fork means carrying ~121,700 LOC of `@excalidraw/excalidraw` plus `element`, `common`, `math`, and the dependency stack — jotai, the full CodeMirror 6 set, mermaid, pica, pako — to reach a drawing surface whose collab we would still replace and whose UI we would still gut. Upstream security fixes then need cherry-picking into a divergent tree forever. The subset Eigen actually needs is far smaller than the maintenance surface a fork imposes.

### What we adopt from Excalidraw (as reference and small vendored pieces)

The engineering here is *proven*; there is no reason to re-derive it. We take, as studied reference and — where MIT-licensed and small — vendored source:

- **The element field shape** (`_ExcalidrawElementBase`, `element/src/types.ts:40`): `x, y, width, height, angle, strokeColor, backgroundColor, fillStyle, strokeWidth, strokeStyle, roughness, opacity, seed, groupIds, boundElements, locked, index`. This is a well-tuned, JSON-serializable, sync-friendly model.
- **Fractional-index z-order** — vendor `@excalidraw/fractional-indexing` (their fork of rocicorp's, MIT, ~320 LOC) or rocicorp's original. A reorder touches one element's `index` string; no order array, no reindex storm. This is the single best fit between their model and a CRDT.
- **roughjs** (`4.6.x`, MIT) for the hand-drawn rendering. Its `RoughGenerator` produces path data as pure JS with no DOM; `rough.svg()` needs only `createElementNS`, but we use the generator's path output directly to build SVG strings. A per-element `seed` + `roughness` field makes the sketchiness deterministic across renders and peers (their exact approach, `element/src/shape.ts:119`).
- **perfect-freehand** (MIT, ~3KB) for freedraw strokes, as they do.
- **Their geometry, hit-testing, and arrow-binding math** as reference (`packages/math`, `element/src/binding.ts`, `element/src/fractionalIndex.ts`) — connection points on rotated shapes, `syncMovedIndices`/`syncInvalidIndices` index repair. We reimplement in our own module, guided by their solutions.
- **The handwriting look** — Excalifont is already one of the four Eigen fonts, shipped and export-wired (§ Fonts).

The result is "exactly Excalidraw's look and functionality" — roughjs strokes, handwriting text, the same tools — rendered by our engine, wrapped in our chrome, synced by our Yjs.

## Design

### Code layout

Three homes, respecting the one-way dependency rule (lib imports no React; ui → lib; the API imports lib only via React-free subpaths):

```
packages/lib/src/vector/              # React-free shared core — BE-safe subpath (the sheets/ precedent)
  index.ts                            # barrel: types, defaults, geometry, sceneToSvg
  types.ts                            # VectorElement union, ELEMENT_FIELDS, defaults
  geometry.ts                         # point math, bounds (union/intersection), hit-testing
  fractional-index.ts                 # vendored fractional-indexing + move/invalid repair
  scene-to-svg.ts                     # sceneToSvg(scene, opts) -> string  (roughjs generator, no DOM)
  roughjs/                            # vendored roughjs generator path (or dep, see Risks)
  read-vector.ts                      # readVectorFromDoc(Y.Doc) -> SceneData  (Worker-safe)

packages/ui/src/components/vector/    # the interactive editor — Eigen/shadcn chrome
  vector-editor.tsx                   # full editor layout (toolbar + canvas + panels)
  vector-canvas.tsx                   # interactive SVG surface + overlays
  vector-renderer.tsx                 # read-only SVG (wraps sceneToSvg) for embeds/thumbnails
  text-overlay.tsx                    # HTML overlay for text editing (NOT foreignObject)
  freehand-overlay.tsx                # canvas layer for active freehand input
  cursor-layer.tsx                    # remote awareness cursors/selections
  toolbar.tsx  properties-panel.tsx   # shadcn TooltipButton / Dialog / shared primitives
  tools/                              # select, shape, draw, line, arrow, text, eraser, pan
  hooks/
    use-vector-doc.ts                 # Yjs doc (mirrors slides use-deck.ts)
    use-viewport.ts  use-selection.ts  use-tool.ts  use-snap.ts

packages/ui/src/components/transform/ # NEW shared ObjectTransform primitive (Goal 3)
  object-transform.tsx                # selection ring + 8 grips + rotate handle + interaction

apps/vector/                          # thin app shell — mirrors apps/slides
  src/main.tsx  src/routes/…  (VECTOR_CONFIG, port 3014, Caddy, env URLs)
```

The critical piece is `packages/lib/src/vector/scene-to-svg.ts`: **one pure `sceneToSvg(scene, opts): string` function used by both the frontend (previews, embeds, thumbnails, export) and the API transform Worker.** roughjs's generator yields path `d` strings without any DOM; text elements carry client-measured `width`/`height` (Excalidraw's trick — `restoreElements` runs without `refreshDimensions` on the SVG path, so stored dimensions are trusted), so the renderer never measures text and needs no canvas. This is the design decision that makes server-side rendering trivial where Excalidraw's is fragile.

`packages/lib/package.json` gains `"./vector": "./src/vector/index.ts"` and `"./vector/*": "./src/vector/*.ts"`, mirroring the `sheets` entries. The Worker imports `@workspace/lib/vector/scene-to-svg` and `@workspace/lib/vector/read-vector` directly — React-free leaves, never a `core/` barrel.

**No new workspace package.** The editor is a `packages/ui` component so docs/slides/sheets embed it without adding a dependency, and the standalone app consumes it like any other UI. This is a deliberate correction of the old proposal, which put everything in a `packages/vector/` workspace — that conflicts with the ui/lib split the codebase actually uses and would have forced React into a package the BE imports.

### The shared `ObjectTransform` primitive (explicit deliverable)

We extract the selection/resize/rotate *interaction and chrome* into `packages/ui/src/components/transform/object-transform.tsx`, seeded from `slide-selection-chrome.tsx` (the richest — 8 grips + rotate handle over `.eigen-selection-ring`/`.eigen-selection-handle`). It owns: the selection ring, eight resize grips with aspect-lock (Shift), the rotate handle with angle snapping (15°), and the pointer math that today each app re-derives. Vector and slides adopt it in this program; docs' `ImageResizeHandles` and sheets' image grips migrate afterward.

**Known pitfall to design around:** slides' rotate grip is a bespoke element — `rounded-full bg-background border border-selection-handle cursor-grab` (`slide-selection-chrome.tsx:72`) — deliberately *not* using the square `.eigen-selection-handle` resize-grip style. An unlayered shared handle class that forces the square style onto every grip would break the rotate handle's round shape. The shared component must **own its chrome classes properly** — resize grips and rotate grip are distinct, and the component ships both rather than leaning on a single global class. This fulfils our standing goal of one scale/rotate/position component across docs/slides/sheets/vector.

### Yjs data model

Match the slides conventions, improve on the old proposal:

```
Y.Map  "elements"  ->  elementId -> Y.Map  (per-element map over the ELEMENT_FIELDS whitelist)
Y.Map  "meta"      ->  { background, gridSize }
```

- **Per-element `Y.Map`, not whole-element LWW.** Each element is a nested `Y.Map` keyed over a fixed `ELEMENT_FIELDS` allow-list (the slides `OBJECT_FIELDS` pattern, `use-deck.ts:11`). This gives **field-level concurrent merge**: peer A drags an element while peer B recolors it, and both survive. Excalidraw's own model is whole-element last-writer-wins (`reconcile.ts` `shouldDiscardRemoteElement`) because their transport is not a CRDT — but a Yjs map *is* a CRDT, so the field-level merge is free and strictly better, and it is consistent with every other Eigen collab app. We diverge from Excalidraw here for a good reason, stated plainly.
- **Z-order is a fractional `index` string field on each element** — adopted directly from Excalidraw. A reorder rewrites one element's `index`; there is no order array and no reindex storm. Repair helpers (`syncMovedIndices`/`syncInvalidIndices`) run on load to heal any index collisions from concurrent inserts.
- **Deletion is `elements.delete(id)`.** No tombstones. Excalidraw needs `isDeleted:true` tombstones because their LWW reconciliation must see the deletion to propagate it; a Yjs map deletes CRDT-correctly on its own. We explicitly do *not* carry Excalidraw's tombstone machinery — it exists to solve a problem Yjs already solves.
- **Point payloads are serialized strings.** Freehand `points` are `JSON.stringify`'d once on stroke completion (never edited point-by-point). Line/arrow control points likewise, unless point-level collab editing proves worth the cost later. This keeps the doc small and matches the old proposal's correct instinct.
- **`yjsRoots: { elements: 'map', meta: 'map' }`** is declared in `EIGEN_DOC_TYPE_INFO.vector`, consumed by the version-restore walker (`restoreYjsDoc` via `CollabDocument.applySnapshotState`).
- **Undo via `new Y.UndoManager([elementsMap, metaMap])`**; every edit is a `doc.transact(...)` so one undo step is one transaction and one broadcast.
- **Awareness** carries remote cursors and selections, rendered by `cursor-layer.tsx` (the slides awareness pattern).

### Element model

Adopt Excalidraw's field shape where it fits, with Eigen adjustments:

| Field | Notes |
|---|---|
| `id, type, x, y, width, height, angle` | `angle` in degrees, consistent with slides `rotation` |
| `strokeColor, backgroundColor, fillStyle, strokeWidth, strokeStyle` | fill/stroke styling |
| `roughness, seed` | deterministic roughjs sketchiness (stored per element) |
| `opacity, locked, groupIds, index` | `index` = fractional-index string (z-order) |
| `boundElements` / bindings | arrows only (Phase 3) |
| `mediaName` (images) | **the Eigen adjustment** — filename in the container's `media/` folder, resolved by `MediaResolverProvider`; **never** a dataURL. Excalidraw stores base64 dataURLs in a `BinaryFiles` map; we do not put binaries in Yjs, so images reference `media/` exactly like doc figures store `mediaName`. |

Element types phase in: **rectangle, diamond, ellipse, line, arrow, freedraw, text, image** first. Frames, embeddables, and mermaid are non-goals.

Text elements store client-measured `width`/`height` and `fontSize` so `sceneToSvg` emits `<text>` with no server-side measurement — the load-bearing invariant for jsdom-free rendering.

### `.eigenvector` type registration

The registration touchpoints. The two `satisfies Record<EigenDocType, …>` registries are compile-enforced (TypeScript blocks the build until they are filled); the rest are hardcoded and silent.

**Compile-enforced (TS forces them):** `EIGEN_DOC_TYPE_INFO` + `DRIVE_EXTENSIONS` (`packages/lib/src/types/drive.ts`), `EIGEN_DOC_ICONS` (`packages/lib/src/core/eigendoc-icons.ts`, e.g. `PenTool`/`Shapes`), `EIGENDOC_MIME` (`writes.ts`), `LABELS` (`drive-create-eigendoc.tsx`), `OPEN_LABELS` (`file-menu.tsx`). Adding `'vector'` to the `EIGEN_DOC_TYPES` tuple lights all of these up.

**Hardcoded (enumerate and check each):**
- `isCollabType()` + `DriveCollabType` (`drive.ts`) — the WS gate; miss it and the route 404s.
- `packages/lib/src/core/api.ts` — `VECTOR_APP_URL` + `getVectorAppUrl`, `getVectorUrl`, and the central `getDocumentUrl()` dispatch (adds `if (path.type === DRIVE_TYPE_VECTOR)`).
- `packages/lib/src/core/apps.ts` launcher grid + `app-sidebar.tsx` `FilterApp`/`FILTER_ENTRIES`/`isFilterApp`/`SHARING_NOUN`.
- `apps/api/src/routes/shared-schemas.ts` — `eigenDocTypeSchema` and `attachmentReferenceSchema.driveType` are manual `t.Literal` unions (kept BE-side deliberately so Elysia stays out of `packages/lib`), but both carry compile-time guards that fail `tsc` the moment `'vector'` joins `EIGEN_DOC_TYPES`, so they can't be silently missed.
- `apps/api/src/lib/document/collab-types.ts` `COLLAB_DOCUMENT_TYPES` — `[DRIVE_MIME_VECTOR, 'eigenvector']`.
- Transform protocol unions + Worker switches + preview-cache gate + export if-chain + extract switches (§ Server pipeline).
- `packages/lib/src/constants/preview.ts` `TextPreviewMode` + `getTextPreviewMode()`.
- `apps/api/src/lib/core/mail-template.ts` share-notification deep-link case.
- `packages/ui/src/styles/globals.css` — `--app-vector-color` + `--app-vector-color-soft`, light and dark.
- `Caddyfile` + `docker/static/Caddyfile` (`import app vector`), `vite.shared.config.ts` `APP_PORTS` (`vector: 3014`), `.env.development`, `scripts/generate-env.sh`.

**Do not touch:** the v6 migration backfill in `apps/api/src/lib/mount/db-config.ts` lists the historical eigen types as frozen literals on purpose — the one-time migration must never shift. New `vector` rows get their dirty bits through the normal write path, not that backfill.

Creation stays generic via `Drive.create(..., 'vector', user)` and the existing `POST /drive/:ownerId/:mountId/folder/:pathId/create/:type` route. No new create endpoint.

### Embedding in docs, slides, and sheets — the sub-resource model

**An embedded drawing is a full `.eigenvector` container nested inside the host, under a `drawings/` folder** (a sibling of `media/` and `chat/`, created lazily on first insert since existing containers predate it). This is the same mechanism comment threads already use — nested `.eigenchat` containers under `chat/` — validated in production:

- `CollabRegistry` keys purely on `pathId` and only checks `isCollabType`, so a nested `.eigenvector` gets its own `data.db` and its own Y.Doc, addressable like any collab doc.
- `docContainerDescendantIds` hides it from Drive listings and search automatically — it is not a standalone file.
- ACL inherits from the host breadcrumb; revoking the host's share cascades to the drawing.
- Container copy is type-generic, so **duplicating the host doc copies its drawings for free.**

**Display mode is static SVG.** The host renders the drawing from a fetched snapshot (or the server text-preview body) through the shared `sceneToSvg` — **no live WebSocket per embed.** N drawings in a doc do not open N sockets.

**Edit mode holds the one live connection.** Double-click opens a dialog / full-screen `VectorEditor` that opens a single `WebsocketProvider` to the nested drawing's `pathId`, edits collaboratively, and closes on dismiss. The host stores only a reference:
- **Docs:** a Tiptap atom node stores the drawing's folder-name/`pathId`, exactly as the `figure` node stores `mediaName` (`apps/docs/src/components/docs/extensions/figure.tsx`). The read-only view renders `VectorRenderer`; double-click opens the editor dialog.
- **Slides:** a new `drawing` slide-object type storing the drawing `pathId`, rendered as an SVG image, transformed by the shared `ObjectTransform`.
- **Sheets:** embedded like a floating image, referencing the drawing `pathId`.

**Reuse rule:** inserting an *existing standalone* `.eigenvector` into a host **copies it into the host's `drawings/` folder**, keeping the one-container-one-ACL invariant intact. A host never points at a drawing it does not own a copy of.

**Rejected alternative — an inline "drawing block" in the host's own Y.Doc.** Storing element data directly in the host document's Yjs was considered and rejected: it produces no standalone file, allows no reuse, bloats the host doc's update log with every stroke, and mixes two element models in one doc. The sub-resource model gives a real file, free reuse via copy, isolated update logs, and ACL/copy semantics that already work.

### Native shape objects in slides — share the renderer, not the model

**Idea, not scheduled.** Distinct from both the sub-resource embed above and the inline-block alternative it rejects: rather than putting a *whole drawing* into a slide, give slides its own `rectangle`/`diamond`/`ellipse` object types and paint them with vector's renderer. Each app keeps the text engine it is good at — slides its rich HTML prose, vector its measured SVG text — and they share one shape-and-image renderer. This is the cheap middle between the "re-render slides on the vector engine" non-goal and a full drawing embed, and it does not compete with either: a whole diagram you want to edit as a unit is still a `drawings/` sub-resource.

It works because `elementToSvg` is already a per-element renderer and the live vector canvas already goes through it (`packages/ui/src/components/vector/vector-canvas.tsx:207` — `dangerouslySetInnerHTML={{ __html: elementToSvg(el, { resolveMedia }) }}`), so editor and export output are byte-identical by construction. Slides' `ReadOnlySlideObject` already switches on `obj.type` and already injects HTML for its text branch, so a shape branch sits directly beside it. `renderShape` emits only roughjs `<path>` inside a `<g transform>` — no `foreignObject`, no filters — which DOMPurify keeps under its default profile.

The work: extend the `SlideObject` union; grow `OBJECT_FIELDS` by the shape scalars (`strokeColor`, `backgroundColor`, `fillStyle`, `strokeWidth`, `strokeStyle`, `roughness`, `seed`, `roundness` — all scalars, so no `Y.Array` normalization); a near-pass-through `SlideShapeObject → VectorShapeElement` adapter (the geometry names already match since U2a); a render branch in `slide-object.tsx` and `export/slides/render.ts`; reuse vector's existing shape controls in the properties panel. `seed` is load-bearing — it is what makes roughjs output deterministic across renders and peers, so the editor and the PDF agree.

Two decisions to get right:

- **Per-object `<svg>`, not one slide-wide SVG layer.** `elementToSvg` bakes `translate(x y) rotate(angle …)` into its `<g>`, but slides already positions each object with its own absolutely-positioned div (`getObjectPositionStyle`), so the adapter zeroes `x`/`y`/`angle` and lets the div keep doing that. A single 1920×1080 SVG layer per slide would preserve `elementToSvg` verbatim but force *all* shapes above or below *all* text, breaking the z-order interleaving slides gets from `objectIds` order.
- **Roughjs strokes paint outside the element box.** Hand-drawn wobble plus `strokeWidth` overflows `0 0 w h` — which is why `sceneToSvg` carries `DEFAULT_PADDING = 10`. A per-object `viewBox="0 0 w h"` clips the stroke edges, so the wrapper needs padding plus `overflow: visible`, or the same shape looks subtly shaved next to its vector twin.

**Verify first:** a WeasyPrint golden with roughjs paths across a few stroke widths and roughness values. PDF is where SVG support is least certain and the one place the fidelity claim could quietly fail.

### Gradient fills in vector

**Idea, not scheduled.** Slides fills take the shared `BackgroundFill` union (`solid | gradient | image`, `packages/lib/src/types/background.ts`) through the shared `BackgroundFillBlock` picker, which already has an `allowedTypes` prop (slides passes `['solid', 'gradient']`). Vector's `backgroundColor` is a bare color string, so unifying is mostly adopting the type and the picker. `meta.background` can take the same treatment, making the vector canvas background symmetric with a slide background.

Rendering is small: fill reaches SVG at exactly two presentation attributes in `drawableToSvg` (`fill=` for `fillPath`, `stroke=` for `fillSketch`'s hatch lines), and because we serialize roughjs ourselves rather than using `RoughSVG`, its `Options.fill` string is never parsed — pass `url(#id)` straight through and emit the `<defs><linearGradient>` inside the element's own `<g>` so the fragment stays self-contained. Hachure fills get gradient-tinted hatching for free.

Three caveats: **SVG gradients do not interpolate the way the CSS ones do**, so the same `{from, to, angle}` needs stop sampling to match slides (and CSS's angle convention needs converting to an SVG gradient vector); **gradient ids must be unique per page**, since one page can hold many fragments — derive them from the element id; and **`restrictToDataRefs` tolerates `url(#…)` only by accident** (it scans the `style` attribute and `<style>` text, not presentation attributes), so a later hardening would silently kill gradients in exports — allow same-document fragment refs explicitly, as a fragment is not fetchable and carries no SSRF risk. Scope solid + gradient first; image fill needs `<pattern>` and clipping.

**Open product question:** Excalidraw deliberately has no gradients and vector's look is hand-drawn roughjs, so this may read as off-style even though it unifies cleanly.

### Canvas performance — what scales with element count and what doesn't

The per-element `Y.Map` earns its keep: **what crosses the wire is independent of how many objects the canvas holds.** Moving one object writes two keys on one nested map, an add writes that element's ≤23 fields, a delete removes one key from the top-level map, and a group op over k elements is one transact. Nothing is proportional to n. Writes are also **one transact per completed gesture, not per frame** (`vector-canvas.tsx` — drag/resize/rotate previews are local React state), so dragging 100 objects across the canvas is a single update on pointerup. The trade-off is that peers see the jump, not the motion; awareness carries cursors and selection, not in-flight geometry.

| Layer | Cost of changing one object |
|---|---|
| Yjs update payload, undo entry, `data.db` append | O(1) — only the changed fields |
| Server snapshot (`Y.encodeStateAsUpdate`) | O(n), amortized every 100 updates / 1 MB |
| `readVectorFromDoc` re-materialization + index sort/heal | **O(n log n)**, once per gesture and per remote update |
| `ElementNode` memo comparison | O(n), cheap |
| `elementToSvg` / roughjs path generation | **O(changed)** — the expensive part, correctly bounded |

Two things are easy to get wrong when reading this code:

- **roughjs runs on every render that passes the memo, not once at mount.** Geometry is generated at local origin (`gen.rectangle(0, 0, width, height, …)`) and placement is baked into the `<g transform>`, so a move or rotate regenerates *byte-identical* path data purely because `x`/`y`/`angle` changed. `seed` is what makes that regeneration deterministic. A resize genuinely needs it; move, rotate and opacity do not.
- **There is no viewport culling.** Every element sits in the SVG DOM regardless of visibility; pan/zoom is one `transform` on the parent `<g>`, and off-screen content is clipped by the container's `overflow-hidden`. That is deliberate — culling would trade a cheap constant walk for mount/unmount churn plus roughjs re-runs on every element scrolling back into view. Off-screen elements cost DOM size and style recalc, not rasterization.

Panning is consequently the cheapest case: the `ordered`-keyed memos all stay cached, the comparator returns true for every element, no roughjs runs, and React patches a single attribute.

**Shipped:** an identity fast-path in `sameElement`. `renderEl` returns the bare element object for anything without a live preview, so pan and drag frames were running the full ~23-field loop against two references to one object.

**Idea, not scheduled — imperative move/rotate.** Mutate the element's `<g transform>` directly during the gesture and commit one transact on pointerup, skipping roughjs entirely. It fits the DOM shape: the transform lives inside the `dangerouslySetInnerHTML` fragment, so React never touches it while the memo holds. Three traps. `previews` must stay in React state regardless (the `ObjectTransform` chrome, selection ring and snap lines all read it), so this removes the roughjs work, not the re-render. Cancel paths break silently — Escape/pointercancel/blur clear previews but the element object never changed, so the memo returns true, the fragment is not rebuilt, and the imperative transform sticks. And a remote edit mid-drag flips the memo to false, replaces the fragment, and drops the transform, so the shape jumps out from under the cursor. Resize is excluded outright: width/height feed the generator, and hachure spacing and stroke width do not survive a scale transform.

**Idea, not scheduled — CSS-transform pan.** Drive the viewport with a CSS transform on a layer-promoted wrapper instead of React state, so a pan moves an already-rasterized layer on the GPU. This targets the browser repaint, which an SVG `<g transform>` change cannot avoid — it is a paint-level invalidation, not a composited one. Three traps. An `<svg>` clips to its own viewport, so translating it reveals nothing past its original bounds; set `overflow: visible` on the `<svg>` and let the container's existing `overflow-hidden` clip instead. Zoom by CSS scale is a scaled bitmap, so it wants CSS during the gesture and one real re-render on commit. And every chrome overlay — `ObjectTransform`, selection rings, marquee, `CursorLayer` — is a sibling `<div>` *outside* the SVG positioned in container pixels by `boxToStyle`, so it detaches unless it moves in lockstep, is updated imperatively, or is hidden for the duration of the pan gesture.

**Verify first:** both ideas are unmeasured, and they target different bottlenecks — the React walk versus the browser repaint. Profile a pan and an object drag on a seeded scene of a few thousand elements before building either; the answer decides which one is worth the risk, and neither is worth doing speculatively.

### Server pipeline

Mirror the eigenslides worker modules. All Worker-imported modules stay pure (no `core/` barrel, no `sharp` in the Worker):

- `apps/api/src/lib/document/vector.ts` — `readVectorFromDoc(doc)` materializer (mirrors `document/slides.ts`), or reuse `@workspace/lib/vector/read-vector`.
- `apps/api/src/lib/preview/eigenvector-render.ts` — `renderEigenvectorPreviewBody(doc)` returns an HTML body embedding the `sceneToSvg` output (mirrors `eigenslides-render.ts`); FE renders it in the `eigen-prose` container. No image produced — the eigen-native preview convention.
- `apps/api/src/lib/export/vector/{render,transform}.ts` — the Worker emits the **SVG string** as the base artifact.
- `apps/api/src/lib/search/extract-render.ts` — `case 'eigenvector'` concatenates the text of all text elements (empty string is valid for a drawing with no text).

**Export envelopes** derive all formats from the one Worker-produced SVG, mirroring how sheets/slides derive PDF from Worker HTML:
| Format | How |
|---|---|
| `svg` | returned as-is |
| `png` | **main-thread** `sharp(Buffer.from(svg)).png()` — mirrors WeasyPrint's main-thread pattern; keeps `sharp` out of the Worker bundle |
| `pdf` | wrap SVG in an HTML doc → main-thread WeasyPrint `htmlToPdf()` |

**Limits:** `sceneToSvg` is string building — comfortably inside the `preview` kind's 30s kill deadline, unlike a rasterization step that could be killed on large scenes (the bug that once stopped sheets recalc in previews). The export-menu format branch goes in `drive-item-menu.tsx` (`vector → ['svg','png','pdf']`).

**Verification item:** the deployed Docker libvips must be built with librsvg for `sharp` SVG input — confirmed on dev, unconfirmed against `docker/api/Dockerfile`.

### Fonts

Already solved — no new assets. The four Eigen fonts (`EIGEN_FONTS` in `packages/lib/src/constants/fonts.ts`: Inter, Source Serif 4, JetBrains Mono, and **Excalifont** as the `hand-drawn` category) ship in `packages/ui/src/assets/fonts/` with `@font-face` declarations in `packages/ui/src/styles/fonts.css` and the `--font-hand` token in `globals.css`. Text elements carry a font field constrained to `EIGEN_FONTS`, with Excalifont as the drawing default — the same picker model docs and sheets use. Export is covered by existing machinery too: `getFontCSS()` (`apps/api/src/lib/export/fonts.ts`) inlines all four faces as base64 `data:` URIs, so the SVG/PDF export wraps its output in that CSS and renders correctly in external viewers. Excalidraw's fetch + wasm font-subsetting pipeline is unnecessary — our four-font set is small enough to inline whole, and that is already what every other export does.

## New and modified files

### New files (representative — the full list follows the layout above)

| File | Purpose |
|---|---|
| `packages/lib/src/vector/index.ts` | barrel (types, defaults, geometry, `sceneToSvg`) |
| `packages/lib/src/vector/types.ts` | `VectorElement` union, `ELEMENT_FIELDS`, defaults |
| `packages/lib/src/vector/geometry.ts` | point math, bounds, hit-testing |
| `packages/lib/src/vector/fractional-index.ts` | vendored fractional indexing + repair helpers |
| `packages/lib/src/vector/scene-to-svg.ts` | pure `sceneToSvg(scene, opts) -> string` |
| `packages/lib/src/vector/read-vector.ts` | `readVectorFromDoc(Y.Doc)` (Worker-safe) |
| `packages/ui/src/components/transform/object-transform.tsx` | **shared** selection/resize/rotate primitive |
| `packages/ui/src/components/vector/vector-editor.tsx` | full editor layout |
| `packages/ui/src/components/vector/vector-canvas.tsx` | interactive SVG surface + overlays |
| `packages/ui/src/components/vector/vector-renderer.tsx` | read-only SVG (embeds/thumbnails) |
| `packages/ui/src/components/vector/text-overlay.tsx` | HTML text-editing overlay |
| `packages/ui/src/components/vector/tools/*.ts` | select/shape/draw/line/arrow/text/eraser/pan |
| `packages/ui/src/components/vector/hooks/use-vector-doc.ts` | Yjs doc (mirrors `use-deck.ts`) |
| `packages/ui/src/components/vector/hooks/{use-viewport,use-selection,use-tool,use-snap}.ts` | interaction state |
| `apps/vector/…` | standalone app shell (mirrors `apps/slides`) |
| `apps/api/src/lib/document/vector.ts` | doc materializer |
| `apps/api/src/lib/preview/eigenvector-render.ts` | preview body renderer |
| `apps/api/src/lib/export/vector/{render,transform}.ts` | export renderer |
| `apps/docs/src/components/docs/extensions/vector-drawing.tsx` | Tiptap node for embeds |

### Modified files

| File | Change |
|---|---|
| `packages/lib/package.json` | add `"./vector"` + `"./vector/*"` exports |
| `packages/lib/src/types/drive.ts` | `DRIVE_TYPE_VECTOR`, `DRIVE_MIME_VECTOR`, unions, `EIGEN_DOC_TYPE_INFO.vector` (+ `yjsRoots`), `DRIVE_EXTENSIONS`, `isCollabType` |
| `packages/lib/src/core/eigendoc-icons.ts` | `vector:` icon |
| `packages/lib/src/core/api.ts` | app-URL plumbing + `getDocumentUrl()` dispatch |
| `packages/lib/src/core/apps.ts` | launcher entry |
| `packages/lib/src/constants/preview.ts` | `TextPreviewMode` + `getTextPreviewMode()` |
| `packages/ui/src/components/layout/sidebar/app-sidebar.tsx` | `FilterApp`/`FILTER_ENTRIES`/`isFilterApp`/`SHARING_NOUN` |
| `packages/ui/src/components/drive/{drive-create-eigendoc,eigendoc-config}.tsx/.ts` | `LABELS`, `VECTOR_CONFIG` |
| `packages/ui/src/components/drive/drive-item-menu.tsx` | export-format branch |
| `packages/ui/src/styles/globals.css` | `--app-vector-color(-soft)` light + dark |
| `apps/slides/src/components/slides/slide-selection-chrome.tsx` | adopt shared `ObjectTransform` |
| `apps/api/src/lib/document/collab-types.ts` | `COLLAB_DOCUMENT_TYPES` entry |
| `apps/api/src/lib/document/transform/protocol.ts` | `'eigenvector'` union arms |
| `apps/api/src/lib/document/transform/worker.ts` | `case 'eigenvector'` in preview/export |
| `apps/api/src/lib/preview/preview-cache.ts` | include `vector`; bump `TEXT_FORMAT` |
| `apps/api/src/lib/export/export-document.ts` | `DRIVE_MIME_VECTOR` branch + `svg`/`png` envelopes |
| `apps/api/src/lib/search/{extract-text,extract-render}.ts` | mime case + Worker arm |
| `apps/api/src/lib/core/mail-template.ts` | share deep-link case |
| `vite.shared.config.ts`, `Caddyfile`, `docker/static/Caddyfile`, `.env.development`, `scripts/generate-env.sh` | port 3014, `import app vector`, env URLs |

## Phased plan

Honest estimates — this is a multi-month program. The first 80% (model, shapes, select/move/resize) moves fast because slides paved it; the last 20% (rotation, rubber-band, arrow bindings, text-editing overlay) takes disproportionately long. Budget roughly 2× any figure that feels quick.

| Phase | Scope | Ships |
|---|---|---|
| **0 — Core model + renderer** (2–3 wk) | `packages/lib/src/vector/` subpath: `VectorElement` union, defaults, geometry/bounds/hit-testing, fractional-index helpers, and `sceneToSvg()` with roughjs. Unit tests (geometry, index repair, SVG snapshot). Read-only `VectorRenderer`. | A drawing can be rendered from data, FE and BE, with tests. |
| **1 — Standalone app + core interaction** (3–4 wk) | `apps/vector/` + full `.eigenvector` registration. `VectorCanvas`, pan/zoom viewport, select/move/**resize/rotate via the new shared `ObjectTransform`**, shape + text tools (HTML overlay editing), `use-vector-doc` Yjs, properties panel, snap lines, `Y.UndoManager`, rubber-band multi-select, shortcuts. | Usable single-user + collab drawing of shapes and text. |
| **2 — Freehand + styles + awareness** (2–3 wk) | perfect-freehand draw tool (canvas overlay input, RDP simplify before commit), line + eraser tools, stroke/fill styles, remote awareness cursors/selections. | Whiteboarding feel; multi-user cursors. |
| **3 — Arrows + bindings** (3–4 wk) | Arrow tool, snap-to-element connection points, reactive endpoint recalculation on bound-element move/resize/delete, arrow labels. **Straight arrows only.** | Diagramming. Flagged rabbit-hole (see Risks). |
| **4 — Pipeline** (2 wk) | Preview (`eigenvector-render`), export (svg/png/pdf), search extraction — the full server checklist. | Drive previews, export, search parity. |
| **5 — Docs embedding** (2–3 wk) | `drawings/` sub-resource creation, Tiptap `vectorDrawing` node, static `VectorRenderer` display, modal editor holding the one WS. | Drawings inside documents. |
| **6 — Slides + sheets embedding + `ObjectTransform` adoption** (2–3 wk) | `drawing` slide-object type + sheet floating embed, both via the shared transform; migrate docs `ImageResizeHandles` and sheets image grips onto `ObjectTransform`. | Drawings everywhere; one transform component across the suite. |
| **7 — Polish backlog** (ongoing) | Grouping/ungrouping, minimap, elbowed arrow routing, SVG import (simple shapes only), library/flowchart shapes, touch/stylus tuning. | Incremental. |

**Explicitly out (maybe-never):** re-rendering slides on the vector engine. Shapes reach slides via embedding (Phases 5–6), not by rewriting a working renderer.

## Risks and caveats

- **Interaction engineering is underestimated by nature.** Rotation with angle snapping, aspect-locked resize, unified multi-select transform, and rubber-band selection are each a day or two of careful work that slides only partially covers. Accept 2× the estimates. The shared `ObjectTransform` concentrates this cost in one place — worth it, but front-loaded.
- **Arrow bindings are a rabbit hole.** Connection points on rotated shapes, updating bindings on resize (not just move), surviving undo/redo — Excalidraw spent months here. Straight arrows only in Phase 3; elbowed routing is Phase 7 or never.
- **Text editing is an HTML overlay, not `foreignObject`.** `<textarea>` in `<foreignObject>` behaves differently for focus/blur, key propagation, and cursor position across Chrome/Firefox/Safari. Render text as SVG `<text>` for display; edit via an absolutely-positioned HTML overlay aligned in JS (the Excalidraw/tldraw approach; the slides app sidesteps SVG entirely with DOM text).
- **The jsdom-free rendering assumption must be pressure-tested.** Everything in `sceneToSvg` must render from *stored* dimensions — the moment a code path measures text at render time, the server breaks. Text width/height are client-measured and stored; the Worker never measures. Verify with a golden-SVG test that runs under the Worker environment.
- **roughjs determinism.** Sketchiness must be reproducible across renders and peers or an embed's static SVG won't match the live editor. Pin the roughjs version; store `seed` + `roughness` per element (their exact mechanism). A version bump that changes roughjs output invalidates cached previews — bump `TEXT_FORMAT` when it happens.
- **Docker libvips SVG support.** `sharp` PNG rasterization needs librsvg-built libvips in production; confirmed on dev only. Verify against `docker/api/Dockerfile` before relying on PNG export.
- **Freehand payload size.** A complex stroke is hundreds of points; multiple users drawing grows the doc fast. Ramer–Douglas–Peucker simplify to ~20–50 points before the Yjs commit (the old proposal's correct call).
- **Embed snapshot staleness.** A static SVG embed must learn when its drawing changed. Proposed: the host re-renders an embed when the `drawings/` child's `updatedAt` bumps, driven off a drive SSE — but the exact signal (does editing a nested collab doc emit a drive file-update event the host is subscribed to?) is unverified. Marked open.
- **Bundle size.** The engine is our own code plus perfect-freehand (~3KB) and roughjs (small). `vector-renderer` (read-only) is tree-shakeable from the interaction code, so doc embeds don't pull in tools.

## Open questions

1. **Vendor vs depend on roughjs and fractional-indexing?** Both are MIT and small. Vendoring pins behaviour and avoids a moving dependency (important for render determinism); depending is less code to own. Lean vendor for roughjs's generator path (determinism-critical), dependency is fine for fractional-indexing. Decide at Phase 0.
2. **Embed-staleness signal.** How exactly does a host document learn a nested drawing changed — a drive `file-history-updated`/file-update SSE on the `drawings/` child, polled `updatedAt`, or a dedicated event? Needs a spike against the collab→drive event path.
3. **Does `.eigenvector` need export at all in v1?** Preview + search-extract are the minimum for Drive parity. If export slips, skip `export/vector/*` and the `ExportTransformJob` arm until Phase 4 proper.
4. **Point-level collab for line/arrow control points.** Serialized-string points are fine until two users edit the same polyline's vertices concurrently. Revisit only if that proves a real workflow.

## Reference

- Old proposal (superseded by this document): the prior `PROPOSAL_VECTOR.md` — its honest risk framing and element sketches are carried forward; its `packages/vector/` workspace layout and embed recommendation are replaced.
- Excalidraw source study — element model, versioning fields, reconciliation, export internals, customization limits: `excalidraw/excalidraw` at `master@e160ff7` (2026-08-16, well ahead of npm `0.18.0`); file paths cited inline above are relative to that repo.
- In-repo precedents: `apps/slides/src/components/slides/hooks/use-deck.ts` (Yjs editor), `apps/slides/src/components/slides/slide-selection-chrome.tsx` (transform chrome to extract), `packages/lib/src/sheets/` (React-free shared subpath), `docs/COMMENTS.md` (nested `.eigenchat` sub-resource precedent), `docs/DOCUMENT-TRANSFORMS.md` + `docs/PREVIEWS.md` + `docs/EXPORT.md` (the pipeline).
