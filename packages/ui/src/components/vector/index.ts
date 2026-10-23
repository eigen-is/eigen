export { CanvasDocumentShell } from './canvas-document-shell';
export { CanvasEditor, type CanvasHandle } from './canvas-editor';
export { CanvasPropertiesPanel } from './canvas-properties-panel';
export { CanvasToolbar } from './canvas-toolbar';
export { FrameThumbnail, FrameView } from './frame-view';
export { updateMetaInDoc } from './hooks/frame-writes';
export { useActiveFrame } from './hooks/use-active-frame';
export { useCanvasCommentHost } from './hooks/use-canvas-comment-host';
export { useCanvasDoc } from './hooks/use-canvas-doc';
export { useCanvasDocSearch } from './hooks/use-canvas-doc-search';
export { type PublishCursor, useCanvasPresence } from './hooks/use-canvas-presence';
export { useSelection } from './hooks/use-selection';
export { useTool, VECTOR_TOOLS, type VectorTool } from './hooks/use-tool';
export {
    isVectorFontLoaded,
    loadVectorFont,
    measureVectorText,
} from './text-measure';
