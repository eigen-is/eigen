import { type CommandProps, Node } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { parseChartSpec, sampleChartSpec } from '../../../charts';
import type { ChartSpec, ChartType } from '../../../types/chart';
import { renderChartSpecSvg } from '../../../vector/kinds/chart-render';
import { MAX_PAPER_MM, mmToPx } from '../page';
import {
    type FigureFrameAttrs,
    figureFrameAttributes,
    figureFrameHTML,
    readFigureFrameAttrs,
    updateFigureNodes,
} from './figure-frame';

// Google's inserted chart, which fits the default page's 642 px text column.
export const CHART_DEFAULT_SIZE = { width: 600, height: 371 };

// No page's text area is wider or taller than the largest page, Word's 22 inches (2112 px). A side a peer or a paste
// sets past it would run the layout for seconds in every viewer and in the export.
export const CHART_MAX_SIDE = Math.round(mmToPx(MAX_PAPER_MM));

// The node's attribute set, as it comes back off a stored document (every attr defaults to null). The spec is the
// stored string, kept as it is even when it doesn't parse, as a canvas keeps it.
export type ChartAttrs = FigureFrameAttrs & {
    spec?: string | null;
    width?: number | null;
    height?: number | null;
};

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        chart: {
            // `maxWidth` is the text column's, which a narrower page gives.
            insertChart: (type: ChartType, maxWidth?: number) => ReturnType;
            updateChart: (attributes: ChartAttrs) => ReturnType;
        };
    }
}

const side = (value: unknown) => (typeof value === 'number' && value > 0 ? Math.min(CHART_MAX_SIDE, value) : null);

// A chart's attributes off untyped ones: a value of the wrong type reads as unset, and a side past the max as the max.
export function readChartAttrs(attrs: Record<string, unknown>): ChartAttrs {
    const { spec, width, height } = attrs;
    return {
        spec: typeof spec === 'string' ? spec : null,
        width: side(width),
        height: side(height),
        ...readFigureFrameAttrs(attrs),
    };
}

// The chart drawn in Google's flat look at its stored size, or the placeholder for a spec that doesn't parse.
export function chartSvg(spec: ChartSpec | null, { width, height }: ChartAttrs): string {
    return renderChartSpecSvg({
        id: 'chart',
        spec,
        width: width ?? CHART_DEFAULT_SIZE.width,
        height: height ?? CHART_DEFAULT_SIZE.height,
    });
}

const sideOf = (element: HTMLElement, name: string) => side(Number(element.getAttribute(name)));

// An inline atom like a figure, sharing its frame. A chart has no intrinsic aspect ratio, so it stores both sides.
export const ChartNode = Node.create({
    name: 'chart',

    group: 'inline',

    inline: true,

    atom: true,

    draggable: true,

    addAttributes() {
        return {
            spec: { default: null, parseHTML: (element: HTMLElement) => element.getAttribute('data-chart') || null },
            width: { default: null, parseHTML: (element: HTMLElement) => sideOf(element, 'data-width') },
            height: { default: null, parseHTML: (element: HTMLElement) => sideOf(element, 'data-height') },
            ...figureFrameAttributes(),
        };
    },

    // Above the figure's span.figure, so the image inside never parses as a figure.
    parseHTML() {
        return [{ tag: 'span.chart[data-chart]', priority: 70 }];
    },

    // The image is for an app that doesn't know the node; this schema reads the data attributes and skips it.
    renderHTML({ node }) {
        const attrs = readChartAttrs(node.attrs);
        const spec = parseChartSpec(attrs.spec ?? '');
        const frame = {
            class: 'chart',
            'data-chart': attrs.spec ?? '',
            'data-width': attrs.width,
            'data-height': attrs.height,
        };
        const img = {
            src: `data:image/svg+xml,${encodeURIComponent(chartSvg(spec, attrs))}`,
            alt: spec?.title || 'Chart',
            width: attrs.width ?? CHART_DEFAULT_SIZE.width,
            height: attrs.height ?? CHART_DEFAULT_SIZE.height,
        };
        return figureFrameHTML(frame, attrs, ['img', img]);
    },

    addCommands() {
        return {
            insertChart:
                (type, maxWidth) =>
                ({ tr, commands }: CommandProps) => {
                    const scale = Math.min(1, (maxWidth ?? Number.POSITIVE_INFINITY) / CHART_DEFAULT_SIZE.width);
                    const inserted = commands.insertContent({
                        type: this.name,
                        attrs: {
                            spec: JSON.stringify(sampleChartSpec(type)),
                            width: Math.round(CHART_DEFAULT_SIZE.width * scale),
                            height: Math.round(CHART_DEFAULT_SIZE.height * scale),
                        },
                    });
                    // Selected, so its panel opens, as Google's does.
                    const pos = tr.selection.from - 1;
                    if (inserted && tr.doc.nodeAt(pos)?.type.name === this.name) {
                        tr.setSelection(NodeSelection.create(tr.doc, pos));
                    }
                    return inserted;
                },
            updateChart: (attributes) => updateFigureNodes(this.name, attributes),
        };
    },
});
