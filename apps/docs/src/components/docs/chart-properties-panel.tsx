import { type Editor, useEditorState } from '@tiptap/react';
import { CHART_DEFAULT_SIZE, isSketchCapped, parseChartSpec, readChartLook } from '@workspace/lib/charts';
import { type ChartAttrs, readChartAttrs } from '@workspace/lib/docs/eigendoc';
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
    return { spec: useMemo(() => parseChartSpec(spec ?? ''), [spec]), ...rest };
}

// Each write one undo step, sealed from the typing around it; a typed title holds its step until the field is left.
function writeChart(editor: Editor, undoManager: Y.UndoManager, attributes: ChartAttrs) {
    sealed(undoManager, () => editor.commands.updateChart(attributes));
}

type ChartPropertiesPanelProps = {
    editor: Editor;
    undoManager: Y.UndoManager;
    onEditData: () => void;
};

export function ChartPropertiesPanel({ editor, undoManager, onEditData }: ChartPropertiesPanelProps) {
    const { spec, layout, alignment, caption, width, height, look } = useSelectedChart(editor);
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
                            onChange={(next) => write({ spec: JSON.stringify(next) })}
                            look={look}
                            onLookChange={write}
                            sketchCapped={spec.data.source === 'inline' && isSketchCapped(spec, spec.data)}
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
// open, as it reads the selection on every transaction. Save is one write.
export function ChartDataEditor({ editor, undoManager, onClose }: ChartDataEditorProps) {
    const { spec } = useSelectedChart(editor);
    return (
        <InlineChartDataDialog
            spec={spec}
            onSave={(next) => writeChart(editor, undoManager, { spec: JSON.stringify(next) })}
            onClose={onClose}
        />
    );
}
