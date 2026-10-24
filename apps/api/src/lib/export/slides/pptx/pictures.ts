import type { BackgroundFill } from '@workspace/lib/types/background';
import type { VectorFrame, VectorImageElement } from '@workspace/lib/vector';
import { isBordered } from '@workspace/lib/vector';
import { blipXml } from '../../../ooxml/drawingml';
import { officeImageParts } from '../../office-image';
import { lineXml } from './lines';
import type { Deck, Image, Slide } from './package';
import { relate } from './package';
import { boxGeometry, fillXml, presetXml, share, spXml, xfrmXml } from './shapes';

// Pictures and backgrounds.

// The first element to show a media name adds its parts; a type Office can't embed, or an SVG without its PNG, adds none.
function imageOf(name: string, deck: Deck): Image | undefined {
    const known = deck.images.get(name);
    if (known) return known;
    const media = deck.media.get(name);
    const parts = media && officeImageParts(media, deck.images.size + 1);
    if (!media || !parts) return undefined;
    const image: Image = { ...parts, media };
    deck.images.set(name, image);
    return image;
}

function slideBlipXml(image: Image, slide: Slide, opacity: number): string {
    const rId = relate(slide, 'image', `../media/${image.part}`);
    const svgRId = image.svgPart && relate(slide, 'image', `../media/${image.svgPart}`);
    return blipXml(rId, svgRId, opacity < 1 ? `<a:alphaModFix amt="${share(opacity)}"/>` : '');
}

// How much of each side cover cuts off the picture, or contain leaves empty in the box: one share of the whole, on the
// axis where the picture overshoots the box. Without the picture's size, nothing is cut and the picture stretches.
function fitOf(image: Image, width: number, height: number): { wide: boolean; cut: number } | null {
    const { media } = image;
    if (!media.width || !media.height || width <= 0 || height <= 0) return null;
    const picture = media.width / media.height;
    const box = width / height;
    const cut = (1 - Math.min(picture, box) / Math.max(picture, box)) / 2;
    return cut > 0 ? { wide: picture > box, cut } : null;
}

// Contain draws the picture in the box it fits, unrounded: Eigen's corner clip misses a fitted picture's corners. Its
// border keeps the element's box, as a shape of its own.
export function pictureXml(el: VectorImageElement, slide: Slide, opacity: number): string {
    const image = imageOf(el.mediaName, slide.deck);
    const border = isBordered(el)
        ? spXml(slide, 'Border', el, boxGeometry(el), '<a:noFill/>', lineXml(slide, el, opacity))
        : '';
    if (!image) return border;
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
    const cut = fit && share(fit.cut);
    const crop =
        el.objectFit === 'cover' && fit
            ? fit.wide
                ? `<a:srcRect l="${cut}" r="${cut}"/>`
                : `<a:srcRect t="${cut}" b="${cut}"/>`
            : '';
    const geometry = contain ? presetXml('rect') : boxGeometry(el);
    const id = ++slide.shapes;
    const picture = `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill>${slideBlipXml(image, slide, opacity)}${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrmXml(slide, box)}${geometry}</p:spPr></p:pic>`;
    return picture + border;
}

// A background places its picture with the fill rectangle, which LibreOffice reads where it ignores a background's
// crop: cover pushes the rectangle out past the slide on the axis the picture overshoots, contain pulls it in on the
// other.
export function backgroundXml(background: BackgroundFill | null, frame: VectorFrame, slide: Slide): string {
    if (!background) return '';
    if (background.type !== 'image') return `<p:bg><p:bgPr>${fillXml(background, 1)}<a:effectLst/></p:bgPr></p:bg>`;
    const image = imageOf(background.mediaName, slide.deck);
    if (!image) return '';
    const fit = fitOf(image, frame.width, frame.height);
    let insets = '';
    if (fit) {
        const cover = background.fit === 'cover';
        const inset = share(cover ? -fit.cut / (1 - 2 * fit.cut) : fit.cut);
        insets = fit.wide === cover ? ` l="${inset}" r="${inset}"` : ` t="${inset}" b="${inset}"`;
    }
    return `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1">${slideBlipXml(image, slide, 1)}<a:stretch><a:fillRect${insets}/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
}
