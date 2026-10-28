// The Docs panel and Edit data for the selected chart node: its size, its layout and caption, then the shared chart
// sections over its spec and look. Each write is one undo step, and a spec edit is a change applied onto the parts the
// node stores, written as the part attributes it changed.

import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import {
    CHART_DEFAULT_SIZE,
    chartSpecWrites,
    isInlineSketchCapped,
    readChartLook,
    readChartSpec,
} from '@workspace/lib/charts';
import type { ChartAttrs } from '@workspace/lib/docs/eigendoc';
import { figurePlacement, readChartAttrs } from '@workspace/lib/docs/eigendoc';
import { CHART_SPEC_PART_KEYS } from '@workspace/lib/types/chart';
import { ChartSections, InlineChartDataDialog } from '@workspace/ui/components/charts';
import {
    holdCapture,
    PropertiesPanel,
    PropertyGestureContext,
    PropertyHistoryContext,
    sealed,
} from '@workspace/ui/components/properties-panel';
import { useCallback, useMemo } from 'react';
import type * as Y from 'yjs';
import {
    CHART_MIN_HEIGHT,
    figureMaxWidth,
    fitFigureSize,
    isAspectLocked,
    setAspectLocked,
    setFigureLayout,
} from './extensions/figure-frame';
import { selectionDrawsInLine } from './extensions/positioned-figure';
import { FigureLayoutSection, FigureSizeSection } from './figure-properties-panel';

// The selected chart's attributes. useEditor re-renders on no transaction, and a write that keeps the chart selected
// fires no selectionUpdate.
function useSelectedChart(editor: Editor) {
    const { parts, ...rest } = useEditorState({
        editor,
        selector: ({ editor: e }) => {
            const attrs = readChartAttrs(e.getAttributes('chart'));
            return {
                parts: Object.fromEntries(CHART_SPEC_PART_KEYS.map((key) => [key, attrs[key]])),
                ...figurePlacement(attrs),
                caption: attrs.caption || '',
                width: attrs.width ?? CHART_DEFAULT_SIZE.width,
                height: attrs.height ?? CHART_DEFAULT_SIZE.height,
                look: readChartLook(attrs),
                locked: isAspectLocked(e.state, 'chart'),
                inFlowOnly: selectionDrawsInLine(e),
            };
        },
    });
    return { ...useMemo(() => readChartSpec(parts), [parts]), ...rest };
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
    const { stored, spec, layout, alignment, caption, width, height, look, locked, inFlowOnly } =
        useSelectedChart(editor);
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
                    <FigureSizeSection
                        width={width}
                        height={height}
                        aspect={{ locked, onLockChange: (next) => setAspectLocked(editor, 'chart', next) }}
                        onChange={(size) =>
                            write(fitFigureSize(size, figureMaxWidth(editor, layout), CHART_MIN_HEIGHT))
                        }
                    />
                    <FigureLayoutSection
                        layout={layout}
                        alignment={alignment}
                        caption={caption}
                        inFlowOnly={inFlowOnly}
                        onChange={(attributes) =>
                            sealed(undoManager, () =>
                                setFigureLayout(editor, attributes, { width, height }, (written) =>
                                    editor.commands.updateChart(written),
                                ),
                            )
                        }
                    />
                    {spec && (
                        <ChartSections
                            spec={spec}
                            stored={stored}
                            onChange={(change) => write(chartSpecWrites(stored, change))}
                            look={look}
                            onLookChange={write}
                            sketchCapped={isInlineSketchCapped(spec)}
                            onEditData={onEditData}
                        />
                    )}
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
            onSave={(change) => writeChart(editor, undoManager, chartSpecWrites(stored, change))}
            onClose={onClose}
        />
    );
}
