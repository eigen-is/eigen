// Shared type contracts for the export render pipeline (HTML + PDF + preview).
// `ImgSrcResolver` is split per surface because slides and doc/eigendoc figures
// have different source models: slides reference media by name only, while
// TipTap figure nodes can carry a mediaName, an external `src`, or both.

// Global render toggle threaded through the render pipeline. `preview` produces
// compact output for the in-app quick-look (e.g. sheets renders only the first
// sheet); `export` produces the full document for download. Passed as a parameter
// rather than module state so concurrent requests stay isolated. Only the sheets
// renderer acts on it today — other renderers treat both modes identically.
export type RenderMode = 'export' | 'preview';

export type SizeUnit = (px: number, axis: 'x' | 'y') => string;

export type SlideImgSrcResolver = (mediaName: string) => string | null;

export type FigureImgSrcResolver = (mediaName: string | null, src: string | null) => string | null;
