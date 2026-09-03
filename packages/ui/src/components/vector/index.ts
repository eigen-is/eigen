export { CanvasEditor, type CanvasImageInsert } from './canvas-editor';
export { CanvasPropertiesPanel } from './canvas-properties-panel';
export { useCanvasComments } from './hooks/use-canvas-comments';
export type { NewVectorElement, VectorElementPatch } from './hooks/use-canvas-doc';
export { useCanvasDoc } from './hooks/use-canvas-doc';
export { type PublishCursor, useCanvasPresence } from './hooks/use-canvas-presence';
export { useSelection } from './hooks/use-selection';
export { useTool, VECTOR_TOOLS, type VectorTool } from './hooks/use-tool';
export {
    isVectorFontLoaded,
    loadVectorFont,
    measureVectorText,
    type TextDimensions,
    vectorFontString,
} from './text-measure';
