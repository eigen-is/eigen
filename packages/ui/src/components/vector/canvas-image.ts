// The image writer behind Download image and Vector's File › Download › SVG: canvas elements, or a doc's or a sheet's
// chart, drawn by the browser as one standalone SVG. Rich text is written as SVG text from the browser's own layout
// of each box, the faces it and the labels draw in are embedded, and images are inlined from the canvas's own media,
// so the file draws the same in any SVG reader. DOM work, so the measuring lives here and the writing in lib.

import { inlineSvgMedia } from '@workspace/lib/clipboard';
import { fontFaceCss } from '@workspace/lib/constants/fonts';
import { downloadBlob } from '@workspace/lib/download';
import { bytesToBase64 } from '@workspace/lib/format';
import { sanitizeToLightEditorHtml } from '@workspace/lib/html-dom';
import type { EigenClipboardChartItem } from '@workspace/lib/types/clipboard';
import {
    canvasImageFaces,
    canvasImageScene,
    eigenMediaHref,
    layerInnerHtml,
    type MeasuredDisc,
    type MeasuredRichText,
    type MeasuredRule,
    type MeasuredText,
    richTextCssText,
    richTextSvg,
    sceneToSvg,
    type VectorElement,
    type VectorRichTextElement,
} from '@workspace/lib/vector';
import { spliceAfterSvgOpenTag } from '@workspace/lib/xml';
import { bundledFontUrl } from './bundled-font-url';

type CanvasImageOptions = {
    // The file's name, without its extension.
    name: string;
    // The whole drawing's background; a selection has none of its own (canvasImageScene).
    background?: string;
    // An image element's bytes, from the canvas's own media; a chart holds no images.
    fetchMedia?: (mediaName: string) => Promise<Blob | null>;
};

export async function downloadCanvasImage(
    content: VectorElement[] | EigenClipboardChartItem,
    { name, background, fetchMedia = async () => null }: CanvasImageOptions,
): Promise<void> {
    const scene = canvasImageScene(content, background);
    const measured = await measureRichText(scene.elements);
    const richText = new Map([...measured].map(([id, box]) => [id, richTextSvg(box)]));
    const inlined = await inlineSvgMedia(sceneToSvg(scene, { resolveMedia: eigenMediaHref, richText }), fetchMedia);
    const faces = await Promise.all(
        canvasImageFaces(scene.elements, measured).map(async (face) => {
            const response = await fetch(bundledFontUrl(face.file));
            if (!response.ok) throw new Error(`The ${face.family} font could not be loaded`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            return fontFaceCss(face, `data:font/woff2;base64,${bytesToBase64(bytes)}`);
        }),
    );
    const svg = spliceAfterSvgOpenTag(inlined, `<defs><style>${faces.join('\n')}</style></defs>`);
    downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`);
}

// Each rich-text box laid out as its canvas layer is, the layer's own markup and style at the box's size under the
// app's canvas-text.css, and read back as where every character landed.
async function measureRichText(elements: VectorElement[]): Promise<Map<string, MeasuredRichText>> {
    const boxes = elements
        .filter((el): el is VectorRichTextElement => el.type === 'richtext')
        .map((el) => {
            const host = document.createElement('div');
            host.style.cssText = `position:fixed;left:0;top:0;width:${el.width}px;height:${el.height}px;visibility:hidden;pointer-events:none`;
            // Stored html arrives verbatim from any peer, so it is sanitized here as at every seam that renders it.
            host.innerHTML = layerInnerHtml({
                svg: '',
                html: sanitizeToLightEditorHtml(el.html),
                style: richTextCssText(el),
            });
            // A list marker is a ::marker no Range reaches, so the measured copy carries a number as text where the
            // browser draws it: its own figures, ending where the item starts. A disc is no text (discOf).
            for (const item of host.querySelectorAll<HTMLLIElement>('ol > li')) {
                const marker = document.createElement('span');
                marker.style.cssText = 'position:absolute;right:100%;white-space:pre;font-variant-numeric:tabular-nums';
                marker.textContent = `${[...(item.parentElement?.children ?? [])].indexOf(item) + 1}. `;
                item.style.position = 'relative';
                item.prepend(marker);
            }
            document.body.append(host);
            return { el, host };
        });
    try {
        // Laying the boxes out asks for every face they draw in; the characters are read once those have loaded.
        for (const { host } of boxes) host.getBoundingClientRect();
        await document.fonts.ready;
        return new Map(boxes.map(({ el, host }) => [el.id, readBox(el, host)]));
    } finally {
        for (const { host } of boxes) host.remove();
    }
}

// A disc sits on its item's first line, at the item's start, in the item's font. A zero-width space at the start of
// the item's first block finds that line's baseline, an empty paragraph's too, after every character is read.
function discOf(item: Element, origin: DOMRect, root: Element): MeasuredDisc {
    const line = item.firstElementChild ?? item;
    const probe = document.createTextNode('\u200b');
    line.prepend(probe);
    const range = document.createRange();
    range.selectNodeContents(probe);
    const top = range.getBoundingClientRect().top;
    const baseline = top - origin.top + ascentOf(line);
    probe.remove();
    return {
        x: item.getBoundingClientRect().left - origin.left,
        baseline,
        ascent: ascentOf(item),
        color: getComputedStyle(item).color,
        opacity: opacityOf(item, root),
    };
}

function readBox(el: VectorRichTextElement, host: HTMLDivElement): MeasuredRichText {
    const origin = host.getBoundingClientRect();
    const root = host.firstElementChild;
    if (!root) return { texts: [], rules: [], discs: [], justify: false };
    const texts: MeasuredText[] = [];
    const ascents = new Map<string, number>();
    const range = document.createRange();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        const data = node.textContent ?? '';
        if (!parent || data === '') continue;
        const chars: MeasuredText['chars'] = [];
        let offset = 0;
        for (const ch of data) {
            range.setStart(node, offset);
            range.setEnd(node, offset + ch.length);
            offset += ch.length;
            const rect = range.getClientRects()[0];
            if (!rect) continue;
            chars.push({
                text: ch,
                x: rect.left - origin.left,
                y: rect.top - origin.top,
                width: rect.width,
                height: rect.height,
            });
        }
        if (chars.length === 0) continue;
        const style = getComputedStyle(parent);
        const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        let ascent = ascents.get(font);
        if (ascent === undefined) {
            ascent = ascentOf(parent);
            ascents.set(font, ascent);
        }
        texts.push({
            style: {
                fontFamily: style.fontFamily,
                fontSize: Number.parseFloat(style.fontSize),
                fontWeight: style.fontWeight,
                fontStyle: style.fontStyle,
                fontVariantNumeric: style.fontVariantNumeric,
                color: style.color,
                opacity: opacityOf(parent, root),
                decoration: decorationOf(parent, root),
                letterSpacing: style.letterSpacing === 'normal' ? 0 : Number.parseFloat(style.letterSpacing),
            },
            ascent,
            chars,
        });
    }
    return {
        texts,
        rules: rulesOf(root, origin),
        discs: [...root.querySelectorAll('ul > li')].map((item) => discOf(item, origin, root)),
        justify: el.textAlign === 'justify',
    };
}

// How far below a character box's top the baseline sits in this element's font: a zero-size inline-block rests on
// the baseline, beside a letter whose box a run's own characters share. Out of flow, so nothing else moves.
function ascentOf(parent: Element): number {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;white-space:pre';
    const letter = document.createTextNode('x');
    const baseline = document.createElement('span');
    baseline.style.cssText = 'display:inline-block;width:0;height:0';
    probe.append(letter, baseline);
    parent.append(probe);
    const range = document.createRange();
    range.selectNodeContents(letter);
    const ascent = baseline.getBoundingClientRect().bottom - range.getBoundingClientRect().top;
    probe.remove();
    return ascent;
}

function opacityOf(from: Element, root: Element): number {
    let opacity = 1;
    for (let el: Element | null = from; el && root.contains(el); el = el.parentElement) {
        opacity *= Number.parseFloat(getComputedStyle(el).opacity);
    }
    return opacity;
}

// text-decoration is no inherited property: an ancestor draws its lines through its descendants' text, except into
// an out-of-flow box such as a marker.
function decorationOf(from: Element, root: Element): string {
    const lines = new Set<string>();
    for (let el: Element | null = from; el && root.contains(el); el = el.parentElement) {
        const style = getComputedStyle(el);
        for (const line of style.textDecorationLine.split(' ')) if (line !== 'none') lines.add(line);
        if (style.position === 'absolute') break;
    }
    return [...lines].join(' ');
}

// A quote's rule is its left border.
function rulesOf(root: Element, origin: DOMRect): MeasuredRule[] {
    const rules: MeasuredRule[] = [];
    for (const el of root.querySelectorAll('*')) {
        const style = getComputedStyle(el);
        const width = Number.parseFloat(style.borderLeftWidth);
        if (style.borderLeftStyle === 'none' || !(width > 0)) continue;
        const rect = el.getBoundingClientRect();
        rules.push({
            x: rect.left - origin.left,
            y: rect.top - origin.top,
            width,
            height: rect.height,
            color: style.borderLeftColor,
            opacity: opacityOf(el, root),
        });
    }
    return rules;
}
