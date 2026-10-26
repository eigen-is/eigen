// The pptx writer's pictures and slide backgrounds, each image a media part related from the slide that shows it.

import type { BackgroundFill } from '@workspace/lib/types/background';
import type { VectorFrame, VectorImageElement } from '@workspace/lib/vector';
import { isBordered } from '@workspace/lib/vector';
import { blipXml } from '../../../ooxml/drawingml';
import type { OfficeImage } from '../../office-image';
import { lineXml } from './lines';
import type { Slide } from './package';
import { boxGeometry, drawingShare, fillXml, presetXml, spXml, xfrmXml } from './shapes';

function slideBlipXml(image: OfficeImage, slide: Slide, opacity: number): string {
    const rId = slide.part.relate('image', `../media/${image.part}`);
    const svgRId = image.svgPart && slide.part.relate('image', `../media/${image.svgPart}`);
    return blipXml(rId, svgRId, opacity < 1 ? `<a:alphaModFix amt="${drawingShare(opacity)}"/>` : '');
}

// How much of each side cover cuts off the picture, or contain leaves empty in the box: one share of the whole, on the
// axis where the picture overshoots the box. Without the picture's size, nothing is cut and the picture stretches.
function fitOf(image: OfficeImage, width: number, height: number): { wide: boolean; cut: number } | null {
    const { media } = image;
    if (!media.width || !media.height || width <= 0 || height <= 0) return null;
    const picture = media.width / media.height;
    const box = width / height;
    const cut = (1 - Math.min(picture, box) / Math.max(picture, box)) / 2;
    return cut > 0 ? { wide: picture > box, cut } : null;
}

// A picture's border is its own a:ln, as PowerPoint writes one. Contain draws the picture in the box it fits, unrounded:
// Eigen's corner clip misses a fitted picture's corners, and its border keeps the element's box, as a shape of its own.
export function pictureXml(el: VectorImageElement, slide: Slide, opacity: number): string {
    const image = slide.deck.images.image(el.mediaName);
    const bordered = isBordered(el);
    const border = () => spXml(slide, 'Border', el, boxGeometry(el), '<a:noFill/>', lineXml(slide, el, opacity));
    if (!image) {
        if (el.mediaName) slide.deck.lost('images-dropped', el);
        return bordered ? border() : '';
    }
    const fit = fitOf(image, el.width, el.height);
    const contain = el.objectFit === 'contain' && fit;
    const box = contain
        ? {
              ...el,
              x: fit.wide ? el.x : el.x + el.width * fit.cut,
              y: fit.wide ? el.y + el.height * fit.cut : el.y,
              width: fit.wide ? el.width : el.width * (1 - 2 * fit.cut),
              height: fit.wide ? el.height * (1 - 2 * fit.cut) : el.height,
          }
        : el;
    const cut = fit && drawingShare(fit.cut);
    const crop =
        el.objectFit === 'cover' && fit
            ? fit.wide
                ? `<a:srcRect l="${cut}" r="${cut}"/>`
                : `<a:srcRect t="${cut}" b="${cut}"/>`
            : '';
    const geometry = contain ? presetXml('rect') : boxGeometry(el);
    const id = ++slide.shapes;
    const ln = bordered && !contain ? lineXml(slide, el, opacity) : '';
    const picture = `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill>${slideBlipXml(image, slide, opacity)}${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrmXml(slide, box)}${geometry}${ln}</p:spPr></p:pic>`;
    return bordered && contain ? picture + border() : picture;
}

// A background places its picture with the fill rectangle, which LibreOffice reads where it ignores a background's
// crop: cover pushes the rectangle out past the slide on the axis the picture overshoots, contain pulls it in on the
// other.
export function backgroundXml(background: BackgroundFill | null, frame: VectorFrame, slide: Slide): string {
    if (!background) return '';
    if (background.type !== 'image') return `<p:bg><p:bgPr>${fillXml(background, 1)}<a:effectLst/></p:bgPr></p:bg>`;
    const image = slide.deck.images.image(background.mediaName);
    if (!image) {
        slide.deck.lost('images-dropped', frame);
        return '';
    }
    const fit = fitOf(image, frame.width, frame.height);
    let insets = '';
    if (fit) {
        const cover = background.fit === 'cover';
        const inset = drawingShare(cover ? -fit.cut / (1 - 2 * fit.cut) : fit.cut);
        insets = fit.wide === cover ? ` l="${inset}" r="${inset}"` : ` t="${inset}" b="${inset}"`;
    }
    return `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1">${slideBlipXml(image, slide, 1)}<a:stretch><a:fillRect${insets}/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
}
