import { type CommandProps, Node } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { nanoid } from 'nanoid';
import { CHART_MAX_SIDE, parseChartSpec, readChartLook, sampleChartSpec } from '../../../charts';
import { isRecord } from '../../../core/guards';
import { CHART_LOOK_FIELDS, type ChartLook, type ChartSpec, type ChartType } from '../../../types/chart';
import { renderChartSpecSvg } from '../../../vector/kinds/chart-render';
import { randomSeed } from '../../../vector/write-vector';
import {
    type FigureFrameAttrs,
    figureFrameAttributes,
    figureFrameHTML,
    readFigureFrameAttrs,
    updateFigureNodes,
} from './figure-frame';

// Google's inserted chart, which fits the default page's 642 px text column.
export const CHART_DEFAULT_SIZE = { width: 600, height: 371 };

// The node's attribute set, as it comes back off a stored document (every attr defaults to null). The spec is the
// stored string, kept as it is even when it doesn't parse, as a canvas keeps it. The look is a canvas chart's own
// fields, an attribute each, so a peer's stroke edit merges with another's sketch edit.
export type ChartAttrs = FigureFrameAttrs &
    Partial<ChartLook> & {
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
// The look reads through the chart look validators, flat where unset.
export function readChartAttrs(attrs: Record<string, unknown>): ChartAttrs & ChartLook {
    const { spec, width, height } = attrs;
    return {
        spec: typeof spec === 'string' ? spec : null,
        width: side(width),
        height: side(height),
        ...readChartLook(attrs),
        ...readFigureFrameAttrs(attrs),
    };
}

// The chart drawn in its look at its stored size, or the placeholder for a spec that doesn't parse. Its id is new on
// every draw, so no two charts on a page, or in a copy beside it, share a gradient's id.
export function chartSvg(spec: ChartSpec | null, { width, height, ...look }: ChartAttrs): string {
    return renderChartSpecSvg({
        id: `chart-${nanoid(10)}`,
        spec,
        width: width ?? CHART_DEFAULT_SIZE.width,
        height: height ?? CHART_DEFAULT_SIZE.height,
        look: readChartLook(look),
    });
}

const sideOf = (element: HTMLElement, name: string) => side(Number(element.getAttribute(name)));

// A pasted span.chart's look, one JSON attribute for every field, each read through the validators later.
function lookOf(element: HTMLElement): Record<string, unknown> {
    try {
        const look: unknown = JSON.parse(element.getAttribute('data-look') ?? '');
        return isRecord(look) ? look : {};
    } catch {
        return {};
    }
}

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
            ...Object.fromEntries(
                CHART_LOOK_FIELDS.map((field) => [
                    field,
                    { default: null, parseHTML: (element: HTMLElement) => lookOf(element)[field] ?? null },
                ]),
            ),
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
            'data-look': JSON.stringify(readChartLook(node.attrs)),
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
                            seed: randomSeed(),
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
