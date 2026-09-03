import { getElementBounds, hitTestBox } from '../geometry';
import { cornerRadius, outlinePath, rectOutline } from '../outline';
import { CORNERS, DEFAULT_CORNERS, DEFAULT_OBJECT_FIT, OBJECT_FITS, type VectorImageElement } from '../types';
import { defineKind } from './kind';
import { oneOf, str } from './read-fields';
import { escapeXml, round } from './render-utils';

export const imageKind = defineKind<VectorImageElement>({
    type: 'image',
    is: (el): el is VectorImageElement => el.type === 'image',
    // no `roughness`/`seed`: an image is a DOM box, roughjs never touches it
    fields: ['mediaName', 'corners', 'objectFit'],
    capabilities: {
        fill: false,
        fillStyle: false,
        stroke: true,
        roughness: false,
        corners: true,
        opacity: true,
        typography: false,
        objectFit: true,
        arrowheads: false,
        bindable: false,
        creation: 'none',
        resize: 'box',
    },
    defaults: (style) => ({
        mediaName: '',
        corners: style.corners,
        objectFit: DEFAULT_OBJECT_FIT,
    }),
    read: (src, base) => ({
        ...base,
        type: 'image',
        mediaName: str(src.get('mediaName'), ''),
        corners: oneOf(src.get('corners'), CORNERS, DEFAULT_CORNERS),
        objectFit: oneOf(src.get('objectFit'), OBJECT_FITS, DEFAULT_OBJECT_FIT),
    }),
    bounds: (el) => getElementBounds(el),
    hitTest: (el, point) => hitTestBox(el, point),
    outline: (el, inflate) =>
        rectOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, cornerRadius(el, 'rectangle'), inflate),
    render: (el, ctx) => {
        const href = ctx.resolveMedia?.(el.mediaName) ?? null;
        if (!href) return { svg: '' };
        const fit = el.objectFit === 'fill' ? 'none' : el.objectFit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';
        const image = `<image x="0" y="0" width="${round(el.width)}" height="${round(el.height)}" href="${escapeXml(href)}" preserveAspectRatio="${fit}"/>`;
        const radius = cornerRadius(el, 'rectangle');
        if (radius <= 0) return { svg: image };
        // The same outline path the shape kinds draw, used as a clip — one definition of a rounded box.
        const d = outlinePath(rectOutline({ x: 0, y: 0, width: el.width, height: el.height }, radius, 0));
        const clipId = `image-clip-${el.id.replace(/[^A-Za-z0-9_-]/g, '')}`;
        return {
            svg: `<defs><clipPath id="${clipId}"><path d="${d}"/></clipPath></defs><g clip-path="url(#${clipId})">${image}</g>`,
        };
    },
    searchText: () => '',
});
