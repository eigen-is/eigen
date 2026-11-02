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

// How a picture meets its box: whether it is wider than the box, and how many times wider or taller, always more than 1.
type Fit = { wide: boolean; ratio: number };

// A fit past this ratio is drawn at it, so the picture keeps at least 1/2,001 of its box, which is under a pixel on any
// slide. The outward inset then stays at most 1,000 times the box, well inside ST_Percentage's 32-bit int.
const MAX_FIT_RATIO = 2001;

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
    const cover = el.objectFit === 'cover';
    const insets = fit && el.objectFit !== 'fill' ? insetsOf(fit, cover, !cover) : '';
    const crop = insets && `<a:srcRect${insets}/>`;
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
    const cover = background.fit === 'cover';
    const insets = fit ? insetsOf(fit, cover, cover) : '';
    return `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1">${slideBlipXml(image, slide, 1)}<a:stretch><a:fillRect${insets}/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
}

// Without the picture's size, or when it has its box's aspect, nothing is fitted and the picture stretches.
function fitOf(image: OfficeImage, width: number, height: number): Fit | null {
    const { media } = image;
    if (!media.width || !media.height || width <= 0 || height <= 0) return null;
    const picture = media.width / media.height;
    const box = width / height;
    const ratio = Math.min(Math.max(picture, box) / Math.min(picture, box), MAX_FIT_RATIO);
    return ratio > 1 ? { wide: picture > box, ratio } : null;
}

// The insets of a crop or a fill rectangle that fit the picture to its box, or none when they round to nothing. Cover
// acts on the axis where the picture overshoots its box, and contain on the other. An inward inset pulls the rectangle
// in and is positive. An outward one pushes it out past its edges and is negative.
function insetsOf(fit: Fit, cover: boolean, outward: boolean): string {
    const inset = drawingShare(outward ? -(fit.ratio - 1) / 2 : (1 - 1 / fit.ratio) / 2);
    if (inset === 0) return '';
    const leftAndRight = cover ? fit.wide : !fit.wide;
    return leftAndRight ? ` l="${inset}" r="${inset}"` : ` t="${inset}" b="${inset}"`;
}

function slideBlipXml(image: OfficeImage, slide: Slide, opacity: number): string {
    const rId = slide.part.relate('image', `../media/${image.part}`);
    const svgRId = image.svgPart && slide.part.relate('image', `../media/${image.svgPart}`);
    return blipXml(rId, svgRId, opacity < 1 ? `<a:alphaModFix amt="${drawingShare(opacity)}"/>` : '');
}
