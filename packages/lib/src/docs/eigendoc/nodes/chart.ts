// The Docs chart node: an inline atom framed like a figure, its spec stored as one attribute per part and its look as
// an attribute per field, so two peers' edits of different parts both stand. It renders the chart as SVG at its stored
// size, and reads a pasted chart's parts and look through the chart validators.

import type { CommandProps } from '@tiptap/core';
import { Node } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import { nanoid } from 'nanoid';
import {
    CHART_DEFAULT_SIZE,
    CHART_MAX_SIDE,
    exceedsChartSpecBytes,
    exceedsChartSpecDepth,
    MAX_CHART_SPEC_BYTES,
    newChartSpecParts,
    readChartLook,
    readChartSpec,
    sampleChartSpec,
} from '../../../charts';
import { isRecord } from '../../../core/guards';
import type { ChartLook, ChartSpec, ChartSpecPartKey, ChartType } from '../../../types/chart';
import { CHART_LOOK_FIELDS, CHART_SPEC_PART_KEYS } from '../../../types/chart';
import { renderChartSpecSvg } from '../../../vector/kinds/chart-render';
import { randomSeed } from '../../../vector/write-vector';
import type { FigureFrameAttrs } from './figure-frame';
import { figureFrameAttributes, figureFrameHTML, readFigureFrameAttrs, updateFigureNodes } from './figure-frame';

// The node's attribute set, as it comes back off a stored document (every attr defaults to null). The spec is an
// attribute per part, each the stored string, kept as it is even when it doesn't parse, as a canvas keeps it; the look
// is a canvas chart's own fields, an attribute each. So two peers' edits of two parts, or of a stroke and a sketch,
// both stand, and an undo takes back only the attributes its step wrote.
export type ChartAttrs = FigureFrameAttrs &
    Partial<ChartLook> &
    Partial<Record<ChartSpecPartKey, string | null>> & {
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

// The spec's parts as the node stores them, a part that isn't a string unset; readChartSpec reads the spec off them.
function chartParts(attrs: Record<string, unknown>): Partial<Record<ChartSpecPartKey, string | null>> {
    return Object.fromEntries(
        CHART_SPEC_PART_KEYS.map((key) => {
            const text = attrs[key];
            return [key, typeof text === 'string' ? text : null];
        }),
    );
}

// A chart's attributes off untyped ones: a value of the wrong type reads as unset, and a side past the max as the max.
// The look reads through the chart look validators, flat where unset.
export function readChartAttrs(attrs: Record<string, unknown>): ChartAttrs & ChartLook {
    const { width, height } = attrs;
    return {
        ...chartParts(attrs),
        width: side(width),
        height: side(height),
        ...readChartLook(attrs),
        ...readFigureFrameAttrs(attrs),
    };
}

// The chart drawn in its look at its stored size, or the placeholder for a spec that doesn't parse. Its id is new on
// every draw, so no two charts on a page, or in a copy beside it, share a gradient's id.
export function chartSvg(spec: ChartSpec | null, { width, height, ...rest }: ChartAttrs): string {
    return renderChartSpecSvg({
        id: `chart-${nanoid(10)}`,
        spec,
        width: width ?? CHART_DEFAULT_SIZE.width,
        height: height ?? CHART_DEFAULT_SIZE.height,
        look: readChartLook(rest),
    });
}

const sideOf = (element: HTMLElement, name: string) => side(Number(element.getAttribute(name)));

// The parts' attribute escapes every quote in their text again, about a fifth more for a real chart, so it is bounded
// at twice the spec's byte limit before the parse, and the parts it holds at the limit itself after.
const MAX_PASTED_PARTS_LENGTH = 2 * MAX_CHART_SPEC_BYTES;

// A pasted span.chart's parts or look, one JSON attribute for each set, each value read through the validators later.
// One longer than its bound or past the spec's depth limit reads as empty, unparsed, so a forged one stores nothing.
function recordOf(text: string, maxLength: number): Record<string, unknown> {
    if (text.length > maxLength || exceedsChartSpecDepth(text)) return {};
    try {
        const record: unknown = JSON.parse(text);
        return isRecord(record) ? record : {};
    } catch {
        return {};
    }
}

// Every part and look field off one read of each attribute.
function pastedChartAttrs(element: HTMLElement): Record<string, unknown> {
    const parts = chartParts(recordOf(element.getAttribute('data-chart') ?? '', MAX_PASTED_PARTS_LENGTH));
    const look = recordOf(element.getAttribute('data-look') ?? '', MAX_CHART_SPEC_BYTES);
    return {
        ...(exceedsChartSpecBytes(parts) ? chartParts({}) : parts),
        ...Object.fromEntries(CHART_LOOK_FIELDS.map((field) => [field, look[field] ?? null])),
    };
}

// An inline atom like a figure, sharing its frame. A chart has no intrinsic aspect ratio, so it stores both sides.
export const ChartNode = Node.create({
    name: 'chart',

    group: 'inline',

    inline: true,

    atom: true,

    draggable: true,

    // getAttrs reads the parts and the look, each attribute once, so a foreign attribute of the same name never reaches
    // the doc.
    addAttributes() {
        const pasted = { default: null, parseHTML: () => null };
        return {
            ...Object.fromEntries(CHART_SPEC_PART_KEYS.map((key) => [key, pasted])),
            width: { default: null, parseHTML: (element: HTMLElement) => sideOf(element, 'data-width') },
            height: { default: null, parseHTML: (element: HTMLElement) => sideOf(element, 'data-height') },
            ...Object.fromEntries(CHART_LOOK_FIELDS.map((field) => [field, pasted])),
            ...figureFrameAttributes(),
        };
    },

    // Above the figure's span.figure, so the image inside never parses as a figure.
    parseHTML() {
        return [{ tag: 'span.chart[data-chart]', priority: 70, getAttrs: pastedChartAttrs }];
    },

    // The image is for an app that doesn't know the node; this schema reads the data attributes and skips it.
    renderHTML({ node }) {
        const attrs = readChartAttrs(node.attrs);
        const { spec } = readChartSpec(node.attrs);
        const frame = {
            class: 'chart',
            'data-chart': JSON.stringify(chartParts(node.attrs)),
            'data-width': attrs.width,
            'data-height': attrs.height,
            'data-look': JSON.stringify(readChartLook(node.attrs)),
        };
        const img = {
            src: `data:image/svg+xml,${encodeURIComponent(chartSvg(spec, attrs))}`,
            alt: spec?.title.text || 'Chart',
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
                            ...newChartSpecParts(sampleChartSpec(type)),
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
