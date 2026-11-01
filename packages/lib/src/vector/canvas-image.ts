// The pure half of Download image, the browser-drawn SVG of canvas elements: the elements it draws, what they are
// drawn on, which font slices the file embeds and what it is called. The canvas image writer in the UI package does
// the layout and the fetches.

import { newChartSpecParts, readChartSpec } from '../charts/spec';
import type { FontSlice } from '../constants/font-slices';
import { getFontName, TEXT_FALLBACK_FAMILIES } from '../constants/fonts';
import type { EigenClipboardChartItem } from '../types/clipboard';
import { ELEMENT_KINDS } from './kinds';
import { readElementFromFields } from './read-vector';
import type { MeasuredRichText } from './rich-text-svg';
import type { VectorElement, VectorScene } from './types';
import { DEFAULT_SCENE_META } from './types';

// A chart in a doc or on a sheet is drawn on white paper, so one downloaded alone is too; a selection of anything
// else keeps the transparency it has on the canvas, and the whole drawing has its own background.
const CHART_PAPER = '#ffffff';

// What the image draws: a canvas's own elements as they are, or a chart a doc or a sheet holds, given as the chart
// item its copy writes and drawn as the one chart element a canvas paste makes of it, read through the element reader.
export function canvasImageScene(
    content: VectorElement[] | EigenClipboardChartItem,
    drawingBackground?: string,
): VectorScene {
    let elements: VectorElement[] = [];
    if (Array.isArray(content)) elements = content;
    else {
        const { parts, width, height, look } = content;
        const record = { ...look, ...newChartSpecParts(parts), id: 'chart', type: 'chart', width, height };
        const el = readElementFromFields(new Map(Object.entries(record)));
        if (el) elements = [el];
    }
    const background =
        drawingBackground ??
        (elements.length === 1 && elements[0].type === 'chart' ? CHART_PAPER : DEFAULT_SCENE_META.background);
    return { elements, frames: [], meta: { ...DEFAULT_SCENE_META, background } };
}

// A chart's file is named for its title, less what a file name can't hold; one without a title is "Chart". Anything
// else is a selection of the file.
export function chartImageName(chart: Readonly<Record<string, unknown>>): string {
    const title = readChartSpec(chart).spec?.title.text ?? '';
    return (
        title
            .replace(/[\\/:*?"<>|\p{Cc}]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim() || 'Chart'
    );
}

export function canvasImageName(elements: VectorElement[], fileName: string): string {
    const [first] = elements;
    return elements.length === 1 && first.type === 'chart' ? chartImageName(first) : `${fileName} – selection`;
}

// The slices the file draws in: each measured run in the family its computed list starts with, and every other
// element's text upright in its own. Each draws in the fallbacks too, for what its family lacks. An italic run takes a
// family's italic slices where it has them; elsewhere the reader slants the upright ones. The slice table is large,
// so it loads here, on a download.
export async function canvasImageFaces(
    elements: VectorScene['elements'],
    measured: ReadonlyMap<string, MeasuredRichText>,
): Promise<FontSlice[]> {
    const { FONT_SLICES, slicesFor } = await import('../constants/font-slices');
    const picked = new Set<FontSlice>();
    const draw = (family: string, style: string, text: string) => {
        const codePoints = new Set(Array.from(text, (char) => char.codePointAt(0) ?? 0));
        for (const name of [family, ...TEXT_FALLBACK_FAMILIES]) {
            const italic =
                style !== 'normal' && FONT_SLICES.some((slice) => slice.family === name && slice.style === 'italic');
            for (const slice of slicesFor(codePoints, [name]))
                if (slice.style === (italic ? 'italic' : 'normal')) picked.add(slice);
        }
    };
    for (const el of elements) {
        const box = measured.get(el.id);
        if (box) {
            for (const { style, chars } of box.texts)
                draw(getFontName(style.fontFamily), style.fontStyle, chars.map((char) => char.text).join(''));
        } else {
            for (const { family, text } of ELEMENT_KINDS[el.type].fontRuns(el)) draw(family, 'normal', text);
        }
    }
    return FONT_SLICES.filter((slice) => picked.has(slice));
}
