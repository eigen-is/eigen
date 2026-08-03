// Shared type contracts for the export render pipeline (HTML + PDF + preview).
// `ImgSrcResolver` is split per surface because slides and doc/eigendoc figures
// have different source models: slides reference media by name only, while
// TipTap figure nodes can carry a mediaName, an external `src`, or both.
// (The former RenderMode toggle is gone: every preview generator slices its own
// input, and sheets previews go through renderSheetsPreviewHtml's budget.)

export type SizeUnit = (px: number, axis: 'x' | 'y') => string;

export type SlideImgSrcResolver = (mediaName: string) => string | null;

export type FigureImgSrcResolver = (mediaName: string | null, src: string | null) => string | null;
