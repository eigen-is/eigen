// The Docs editor's chart: the shared chart node with a view that draws its spec as inline SVG at its size, redrawn at
// every move of a resize, inside the figure frame a picture uses. A double-click on a chart with inline data opens
// Edit data, which the editor passes in as an option.

import type { NodeViewProps } from '@tiptap/react';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { CHART_DEFAULT_SIZE, readChartSpec } from '@workspace/lib/charts';
import { ChartNode, chartSvg, readChartAttrs } from '@workspace/lib/docs/eigendoc';
import type { Box } from '@workspace/lib/vector';
import { useCallback, useMemo, useRef } from 'react';
import type { FigureFrameOptions } from './figure-frame';
import {
    clampFigureWidth,
    FIGURE_MIN_SIZE,
    FigureFrame,
    figureFramePlugins,
    figureMaxWidth,
    useFigureResize,
} from './figure-frame';

export type ChartOptions = FigureFrameOptions & {
    // Opens Edit data for the selected chart.
    onEditData: () => void;
};

type ChartSize = { width: number; height: number };

// Free, as a chart has no aspect ratio of its own: each side within the floor, the width within the column too.
const fitChart = (next: Box, maxWidth: number): ChartSize => ({
    width: clampFigureWidth(next.width, maxWidth),
    height: Math.round(Math.max(FIGURE_MIN_SIZE, next.height)),
});

// A chart keeps both sides.
const storedSize = (size: ChartSize) => size;

function ChartView(props: NodeViewProps) {
    const { node, selected, editor, extension, getPos } = props;
    const { onEditData }: ChartOptions = extension.options;
    const containerRef = useRef<HTMLSpanElement>(null);
    // node.attrs is a new object only when an attribute changes, a part's and the look's among them.
    const attrs = useMemo(() => readChartAttrs(node.attrs), [node.attrs]);
    const { width, height, layout } = attrs;
    const isEditable = editor.isEditable;

    const getMaxWidth = useCallback(() => figureMaxWidth(editor, layout), [editor, layout]);
    const resize = useFigureResize({ editor, getPos, node, getMaxWidth, fit: fitChart, stored: storedSize });

    // A resize lays the chart out again at every move, as the canvas does.
    const size = resize.preview?.size ?? {
        width: width ?? CHART_DEFAULT_SIZE.width,
        height: height ?? CHART_DEFAULT_SIZE.height,
    };
    const parsed = useMemo(() => readChartSpec(node.attrs).spec, [node.attrs]);
    const svg = useMemo(() => chartSvg(parsed, { ...attrs, ...size }), [parsed, attrs, size.width, size.height]);
    const box: Box | null = selected && isEditable ? { x: 0, y: 0, ...size, angle: 0 } : null;

    return (
        <FigureFrame
            {...props}
            containerRef={containerRef}
            box={box}
            shift={resize.preview?.shift}
            resizeMode="free"
            onTransform={resize.onTransform}
            onCommit={resize.onCommit}
            onGestureEnd={resize.onGestureEnd}
            label="Resize chart"
        >
            <span
                className="block"
                // The painter's own SVG: its labels are escaped where they are written.
                dangerouslySetInnerHTML={{ __html: svg }}
                onDoubleClick={() => {
                    const pos = getPos();
                    if (!isEditable || pos === undefined || parsed?.data.source !== 'inline') return;
                    editor.commands.setNodeSelection(pos);
                    onEditData();
                }}
            />
        </FigureFrame>
    );
}

export const Chart = ChartNode.extend<ChartOptions>({
    addOptions() {
        return { onContextMenu: () => {}, onOpenComment: () => {}, onEditData: () => {} };
    },
    addProseMirrorPlugins() {
        return figureFramePlugins(this.name);
    },
    addNodeView() {
        // TipTap skips the re-render when only decorations change, and the comment mark's color arrives as one.
        return ReactNodeViewRenderer(ChartView, {
            update: ({ updateProps }) => {
                updateProps();
                return true;
            },
        });
    },
});
