// The pptx writer's pictures and slide backgrounds. Each image is a media part related from the slide that shows it.
// A picture is one p:pic in its element's box, with its fit and its border on it, so the pptx reader reads back one
// element. The slide writer calls these as it writes a slide's shapes and its background.

import type { BackgroundFill } from '@workspace/lib/types/background';
import type { VectorFrame, VectorImageElement } from '@workspace/lib/vector';
import { isBordered } from '@workspace/lib/vector';
import { blipXml, drawingShare } from '../../../ooxml/drawingml';
import type { OfficeImage } from '../../export-image';
import { lineXml } from './lines';
import type { Slide } from './package';
import { boxGeometry, fillXml, spXml, xfrmXml } from './shapes';

// How a picture meets its box: whether it is wider than the box, and the share of the box each side differs by.
type Fit = { wide: boolean; cut: number };

// A picture's border is its own a:ln, as PowerPoint writes one. Its fit is its crop: cover cuts into the source, and
// contain crops past it, so the picture keeps the element's box and the border and rounded corners clip as on the
// canvas. LibreOffice ignores a picture's fill rectangle, so the crop does the fitting.
export function pictureXml(el: VectorImageElement, slide: Slide, opacity: number): string {
    const image = slide.deck.images.image(el.mediaName);
    const line = isBordered(el) ? lineXml(slide, el, opacity) : '';
    if (!image) {
        if (el.mediaName) slide.deck.lost('images-dropped', el);
        return line && spXml(slide, 'Border', el, boxGeometry(el), '<a:noFill/>', line);
    }
    const fit = fitOf(image, el.width, el.height);
    const crop = fit && el.objectFit !== 'fill' ? insetXml('srcRect', fit, el.objectFit === 'cover') : '';
    const id = ++slide.shapes;
    return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill>${slideBlipXml(image, slide, opacity)}${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrmXml(slide, el)}${boxGeometry(el)}${line}</p:spPr></p:pic>`;
}

// A background places its picture with the fill rectangle, which LibreOffice reads where it ignores a background's
// crop.
export function backgroundXml(background: BackgroundFill | null, frame: VectorFrame, slide: Slide): string {
    if (!background) return '';
    if (background.type !== 'image') return `<p:bg><p:bgPr>${fillXml(background, 1)}<a:effectLst/></p:bgPr></p:bg>`;
    const image = slide.deck.images.image(background.mediaName);
    if (!image) {
        slide.deck.lost('images-dropped', frame);
        return '';
    }
    const fit = fitOf(image, frame.width, frame.height);
    const stretch = `<a:stretch>${fit ? insetXml('fillRect', fit, background.fit === 'cover') : '<a:fillRect/>'}</a:stretch>`;
    return `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1">${slideBlipXml(image, slide, 1)}${stretch}</a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
}

function slideBlipXml(image: OfficeImage, slide: Slide, opacity: number): string {
    const rId = slide.part.relate('image', `../media/${image.part}`);
    const svgRId = image.svgPart && slide.part.relate('image', `../media/${image.svgPart}`);
    return blipXml(rId, svgRId, opacity < 1 ? `<a:alphaModFix amt="${drawingShare(opacity)}"/>` : '');
}

// How much of each side cover cuts off the picture, or contain leaves empty in the box: one share of the whole, on the
// axis where the picture overshoots the box. Without the picture's size, nothing is cut and the picture stretches.
function fitOf(image: OfficeImage, width: number, height: number): Fit | null {
    const { media } = image;
    if (!media.width || !media.height || width <= 0 || height <= 0) return null;
    const picture = media.width / media.height;
    const box = width / height;
    const cut = (1 - Math.min(picture, box) / Math.max(picture, box)) / 2;
    return cut > 0 ? { wide: picture > box, cut } : null;
}

// A crop or a fill rectangle that fits the picture to its box, on the axis the fit acts on. A crop cuts into the picture,
// and a fill rectangle into the box: cover cuts into the picture where it overshoots, and contain into the box where the
// picture falls short. The other way round, the inset is negative and grows the picture or the box.
function insetXml(rect: 'srcRect' | 'fillRect', fit: Fit, cover: boolean): string {
    const grows = (rect === 'fillRect') === cover;
    const inset = drawingShare(grows ? -fit.cut / (1 - 2 * fit.cut) : fit.cut);
    const sides = fit.wide === cover ? `l="${inset}" r="${inset}"` : `t="${inset}" b="${inset}"`;
    return `<a:${rect} ${sides}/>`;
}
