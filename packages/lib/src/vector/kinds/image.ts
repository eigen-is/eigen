import { escapeXml } from '../../core/html';
import { hitTestBox, round } from '../geometry';
import { cornerRadius, outlinePath, rectOutline } from '../outline';
import { CORNERS, DEFAULT_CORNERS, DEFAULT_OBJECT_FIT, OBJECT_FITS, type VectorImageElement } from '../types';
import { defineKind } from './kind';
import { oneOf, str } from './read-fields';
import { dashArray, isBordered, svgId } from './render-utils';

// The dashed grey box a picture with no resolvable file draws in its place.
const MISSING_MEDIA_COLOR = '#9ca3af';
const MISSING_MEDIA_DASH = '6 6';

export const imageKind = defineKind<VectorImageElement>({
    type: 'image',
    is: (el): el is VectorImageElement => el.type === 'image',
    // no `roughness`/`seed`: an image is a DOM box, roughjs never touches it
    capabilities: {
        fill: false,
        fillStyle: false,
        strokeStyle: true,
        roughness: false,
        corners: true,
        strokeOptional: true,
        bindable: true,
        silhouette: 'box',
        creation: 'none',
    },
    defaults: (style) => ({
        mediaName: '',
        corners: style.corners,
        objectFit: DEFAULT_OBJECT_FIT,
    }),
    // The stroke is this kind's border, so a pasted picture arrives unframed.
    baseDefaults: { strokeColor: 'transparent' },
    read: (src, base) => ({
        ...base,
        type: 'image',
        mediaName: str(src.get('mediaName'), ''),
        corners: oneOf(src.get('corners'), CORNERS, DEFAULT_CORNERS),
        objectFit: oneOf(src.get('objectFit'), OBJECT_FITS, DEFAULT_OBJECT_FIT),
    }),
    hitTest: (el, point) => hitTestBox(el, point),
    outline: (el, inflate) =>
        rectOutline({ x: el.x, y: el.y, width: el.width, height: el.height }, cornerRadius(el, 'rectangle'), inflate),
    // No media name and no border: render draws nothing, so the empty-outline ring marks the spot.
    paintsNothing: (el) => el.mediaName === '' && !isBordered(el),
    render: (el, ctx) => {
        const radius = cornerRadius(el, 'rectangle');
        // The same outline path the shape kinds draw: one silhouette, clipped, stroked and placeheld.
        const d = outlinePath(rectOutline({ x: 0, y: 0, width: el.width, height: el.height }, radius, 0));
        // The stroke fields are this kind's BORDER (types.ts), the way they are rich text's. It is drawn
        // after the picture, so a border never sits under the pixels it frames.
        const dash = dashArray(el.strokeStyle, el.strokeWidth);
        const border = isBordered(el)
            ? `<path d="${d}" fill="none" stroke="${escapeXml(el.strokeColor)}" stroke-width="${round(el.strokeWidth)}"${dash ? ` stroke-dasharray="${dash.map(round).join(' ')}"` : ''}/>`
            : '';
        const href = ctx.resolveMedia?.(el.mediaName) ?? null;
        if (!href) {
            // Media that is deleted, still uploading or on another mount: draw the box so the element
            // stays visible, selectable and findable. An image with no media name at all is the empty
            // element `paintsNothing` rings instead.
            const placeholder =
                el.mediaName === ''
                    ? ''
                    : `<path d="${d}" fill="none" stroke="${MISSING_MEDIA_COLOR}" stroke-width="1" stroke-dasharray="${MISSING_MEDIA_DASH}"/>`;
            return { svg: `${placeholder}${border}` };
        }
        const fit = el.objectFit === 'fill' ? 'none' : el.objectFit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';
        const image = `<image x="0" y="0" width="${round(el.width)}" height="${round(el.height)}" href="${escapeXml(href)}" preserveAspectRatio="${fit}"/>`;
        if (radius <= 0) return { svg: `${image}${border}` };
        const clipId = svgId('image-clip', el.id);
        return {
            svg: `<defs><clipPath id="${clipId}"><path d="${d}"/></clipPath></defs><g clip-path="url(#${clipId})">${image}</g>${border}`,
        };
    },
});
