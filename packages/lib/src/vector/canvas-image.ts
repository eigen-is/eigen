// The pure half of Download image, the browser-drawn SVG of canvas elements: the elements a payload draws, what
// they are drawn on and which faces the file embeds. packages/ui's canvas image writer does the layout and the fetches.

import { type BundledFontFace, fontFacesFor, getFontName } from '../constants/fonts';
import type { EigenClipboardItem } from '../types/clipboard';
import { readElementsClipboardItem } from './clipboard';
import { ELEMENT_KINDS } from './kinds';
import type { MeasuredRichText } from './rich-text-svg';
import { DEFAULT_SCENE_META, type VectorScene } from './types';

// A chart in a doc or on a sheet is drawn on white paper, so one downloaded alone is too; a selection of anything
// else keeps the transparency it has on the canvas, and the whole drawing has its own background.
const CHART_PAPER = '#ffffff';

// The one place a payload becomes the elements the image draws: the canvas's own elements item, read as a paste
// reads it.
export function canvasImageScene(items: EigenClipboardItem[], drawingBackground?: string): VectorScene {
    const elements = readElementsClipboardItem(items)?.elements ?? [];
    const background =
        drawingBackground ??
        (elements.length === 1 && elements[0].type === 'chart' ? CHART_PAPER : DEFAULT_SCENE_META.background);
    return { elements, frames: [], meta: { ...DEFAULT_SCENE_META, background } };
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
