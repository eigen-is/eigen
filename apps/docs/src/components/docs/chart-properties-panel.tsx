// The Docs panel and Edit data for the selected chart node: the shared chart sections over its spec and look, then its
// layout and caption. Each write is one undo step, and a spec edit is a change applied onto the spec the node stores.

import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import {
    applyChartSpecChange,
    CHART_DEFAULT_SIZE,
    isInlineSketchCapped,
    readChartLook,
    readChartSpec,
} from '@workspace/lib/charts';
import type { ChartAttrs } from '@workspace/lib/docs/eigendoc';
import { readChartAttrs } from '@workspace/lib/docs/eigendoc';
import type { ChartSpecChange, StoredChartSpec } from '@workspace/lib/types/chart';
import { ChartSections, InlineChartDataDialog } from '@workspace/ui/components/charts';
import {
    holdCapture,
    PropertiesPanel,
    PropertyGestureContext,
    PropertyHistoryContext,
    PropertySection,
    sealed,
} from '@workspace/ui/components/properties-panel';
import { useCallback, useMemo } from 'react';
import type * as Y from 'yjs';
import { widthWithinLayout } from './extensions/figure-frame';
import { FigureField, FigureLayoutSection } from './figure-properties-panel';

// The selected chart's attributes. useEditor re-renders on no transaction, and a write that keeps the chart selected
// fires no selectionUpdate.
function useSelectedChart(editor: Editor) {
    const { spec, ...rest } = useEditorState({
        editor,
        selector: ({ editor: e }) => {
            const attrs = readChartAttrs(e.getAttributes('chart'));
            return {
                spec: attrs.spec,
                layout: attrs.layout || 'block',
                alignment: attrs.alignment || 'center',
                caption: attrs.caption || '',
                width: attrs.width ?? CHART_DEFAULT_SIZE.width,
                height: attrs.height ?? CHART_DEFAULT_SIZE.height,
                look: readChartLook(attrs),
            };
        },
    });
    return { ...useMemo(() => readChartSpec(spec ?? ''), [spec]), ...rest };
}

// Each write one undo step, sealed from the typing around it; a typed title holds its step until the field is left.
function writeChart(editor: Editor, undoManager: Y.UndoManager, attributes: ChartAttrs) {
    sealed(undoManager, () => editor.commands.updateChart(attributes));
}

// Applied onto the spec the node stores as last rendered, so a key this build doesn't know stays.
const specWrite = (stored: StoredChartSpec, change: ChartSpecChange): ChartAttrs => ({
    spec: JSON.stringify(applyChartSpecChange(stored, change)),
});

type ChartPropertiesPanelProps = {
    editor: Editor;
    undoManager: Y.UndoManager;
    onEditData: () => void;
};

export function ChartPropertiesPanel({ editor, undoManager, onEditData }: ChartPropertiesPanelProps) {
    const { stored, spec, layout, alignment, caption, width, height, look } = useSelectedChart(editor);
    const beginGesture = useCallback(() => holdCapture(undoManager), [undoManager]);
    // A field that writes as the user types keeps the caret out of the editor's keymap, so it hands ⌘Z to the doc.
    const history = useMemo(
        () => ({ undo: () => editor.commands.undo(), redo: () => editor.commands.redo() }),
        [editor],
    );
    const write = (attributes: ChartAttrs) => writeChart(editor, undoManager, attributes);

    return (
        <PropertyGestureContext.Provider value={beginGesture}>
            <PropertyHistoryContext.Provider value={history}>
                <PropertiesPanel title="Chart">
                    {spec && (
                        <ChartSections
                            spec={spec}
                            stored={stored}
                            onChange={(change) => write(specWrite(stored, change))}
                            look={look}
                            onLookChange={write}
                            sketchCapped={isInlineSketchCapped(spec)}
                            onEditData={onEditData}
                        />
                    )}
                    <FigureLayoutSection
                        layout={layout}
                        alignment={alignment}
                        onChange={(attributes) => {
                            // A chart shrunk to a wrap keeps its shape.
                            const fitted = widthWithinLayout(editor.view.dom, attributes.layout, width);
                            write(
                                fitted === undefined
                                    ? attributes
                                    : { ...attributes, width: fitted, height: Math.round((height * fitted) / width) },
                            );
                        }}
                    />
                    <PropertySection title="Caption">
                        <FigureField
                            value={caption}
                            placeholder="Caption"
                            onCommit={(value) => write({ caption: value || null })}
                        />
                    </PropertySection>
                </PropertiesPanel>
            </PropertyHistoryContext.Provider>
        </PropertyGestureContext.Provider>
    );
}

type ChartDataEditorProps = {
    editor: Editor;
    undoManager: Y.UndoManager;
    onClose: () => void;
};

// Edit data for the selected chart, which the panel's button and a double-click on the chart open; mounted only while
// open, as it reads the selection on every transaction, so Save applies onto the node as it is then. Save is one
// write.
export function ChartDataEditor({ editor, undoManager, onClose }: ChartDataEditorProps) {
    const { stored, spec } = useSelectedChart(editor);
    return (
        <InlineChartDataDialog
            spec={spec}
            stored={stored}
            onSave={(change) => writeChart(editor, undoManager, specWrite(stored, change))}
            onClose={onClose}
        />
    );
}
