export { useSelection } from './hooks/use-selection';
export { useTool, VECTOR_TOOLS, type VectorTool } from './hooks/use-tool';
export type { NewVectorElement, VectorElementPatch } from './hooks/use-vector-doc';
export { useVectorDoc } from './hooks/use-vector-doc';
export {
    isVectorFontLoaded,
    loadVectorFont,
    measureVectorText,
    type TextDimensions,
    vectorFontString,
} from './text-measure';
export { VectorCanvas } from './vector-canvas';
export { VectorPropertiesPanel } from './vector-properties-panel';
