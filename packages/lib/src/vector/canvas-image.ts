// The pure half of Download image, the browser-drawn SVG of canvas elements: the elements it draws, what they are
// drawn on, which faces the file embeds and what it is called. packages/ui's canvas image writer does the layout and
// the fetches.

import { parseChartSpec } from '../charts/spec';
import { type BundledFontFace, fontFacesFor, getFontName } from '../constants/fonts';
import type { EigenClipboardChartItem } from '../types/clipboard';
import { ELEMENT_KINDS } from './kinds';
import { readElementFromFields } from './read-vector';
import type { MeasuredRichText } from './rich-text-svg';
import { DEFAULT_SCENE_META, type VectorElement, type VectorScene } from './types';

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
        const { spec, width, height, look } = content;
        const record: Record<string, unknown> = { ...look, id: 'chart', type: 'chart', chart: spec, width, height };
        const el = readElementFromFields({ get: (key: string) => record[key] });
        if (el) elements = [el];
    }
    const background =
        drawingBackground ??
        (elements.length === 1 && elements[0].type === 'chart' ? CHART_PAPER : DEFAULT_SCENE_META.background);
    return { elements, frames: [], meta: { ...DEFAULT_SCENE_META, background } };
}

// A chart's file is named for its title, less what a file name can't hold; one without a title is "Chart". Anything
// else is a selection of the file.
export function chartImageName(spec: string): string {
    const title = parseChartSpec(spec)?.title ?? '';
    return (
        title
            .replace(/[\\/:*?"<>|\p{Cc}]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim() || 'Chart'
    );
}

export function canvasImageName(elements: VectorElement[], fileName: string): string {
    const [first] = elements;
    return elements.length === 1 && first.type === 'chart' ? chartImageName(first.chart) : `${fileName} – selection`;
}

// The faces the file draws in: a measured box's runs, each in the face its computed family list starts with, and
// every other element's labels, upright.
export function canvasImageFaces(
    elements: VectorScene['elements'],
    measured: ReadonlyMap<string, MeasuredRichText>,
): BundledFontFace[] {
    const uses: { family: string; style: string }[] = [];
    for (const el of elements) {
        const box = measured.get(el.id);
        if (box) {
            for (const { style } of box.texts)
                uses.push({ family: getFontName(style.fontFamily), style: style.fontStyle });
        } else {
            for (const family of ELEMENT_KINDS[el.type].fontFamilies(el)) uses.push({ family, style: 'normal' });
        }
    }
    return fontFacesFor(uses);
}
