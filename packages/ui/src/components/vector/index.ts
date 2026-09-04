export { CanvasDocumentShell } from './canvas-document-shell';
export { CanvasEditor, type CanvasImageInsert } from './canvas-editor';
export { CanvasPropertiesPanel } from './canvas-properties-panel';
export { CanvasToolbar } from './canvas-toolbar';
export { FrameThumbnail, FrameView } from './frame-view';
export { newElementId } from './hooks/element-writes';
export { newFrameId, writeFrameInDoc } from './hooks/frame-writes';
export { useActiveFrame } from './hooks/use-active-frame';
export { useCanvasCommentHost } from './hooks/use-canvas-comment-host';
export { useCanvasComments } from './hooks/use-canvas-comments';
export type { NewVectorElement, VectorElementPatch } from './hooks/use-canvas-doc';
export { useCanvasDoc } from './hooks/use-canvas-doc';
export { useCanvasDocSearch } from './hooks/use-canvas-doc-search';
export { type PublishCursor, useCanvasPresence } from './hooks/use-canvas-presence';
export { useSelection } from './hooks/use-selection';
export { useTool, VECTOR_TOOLS, type VectorTool, type VectorToolEntry } from './hooks/use-tool';
export {
    isVectorFontLoaded,
    loadVectorFont,
    measureVectorText,
    type TextDimensions,
    vectorFontString,
} from './text-measure';
export { EDIT_TOOLS, INSERT_TOOLS, ToolButtons, ToolMenuItems } from './toolbar-tools';
