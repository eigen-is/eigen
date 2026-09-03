// Shared type contracts for the export render pipeline (HTML + PDF + preview).
// `FigureImgSrcResolver` is a doc/eigendoc concern: a TipTap figure node can carry a
// mediaName, an external `src`, or both. Canvas documents resolve media through
// `MediaResolver` (packages/lib), so they need nothing here.
// (The former RenderMode toggle is gone: every preview generator slices its own
// input, and sheets previews go through renderSheetsPreviewHtml's budget.)

export type FigureImgSrcResolver = (mediaName: string | null, src: string | null) => string | null;
