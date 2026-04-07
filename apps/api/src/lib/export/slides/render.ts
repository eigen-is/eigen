import { getFontFamily } from '@workspace/lib/constants/fonts';
import {
    BORDER_RADIUS_ROUND,
    pxToPercent,
    SLIDE_BASE_HEIGHT,
    SLIDE_BASE_WIDTH,
    type SlideItem,
    type SlideObject,
} from '@workspace/lib/slides';

export type SizeUnit = (px: number, axis: 'x' | 'y') => string;
export type ImgSrcResolver = (mediaName: string) => string | null;

export const responsiveSizeUnit: SizeUnit = (px, axis) => {
    const base = axis === 'x' ? SLIDE_BASE_WIDTH : SLIDE_BASE_HEIGHT;
    const unit = axis === 'x' ? 'cqw' : 'cqh';
    return `${(px / base) * 100}${unit}`;
};

export function fixedSizeUnit(pageWidth: number, pageHeight: number): SizeUnit {
    return (px, axis) => {
        const base = axis === 'x' ? SLIDE_BASE_WIDTH : SLIDE_BASE_HEIGHT;
        const dim = axis === 'x' ? pageWidth : pageHeight;
        return `${(px / base) * dim}px`;
    };
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function renderSlideObjectHtml(obj: SlideObject, sizeUnit: SizeUnit, resolveImgSrc: ImgSrcResolver): string {
    const styles: string[] = [
        'position:absolute',
        `left:${pxToPercent(obj.x, 'x')}%`,
        `top:${pxToPercent(obj.y, 'y')}%`,
        `width:${pxToPercent(obj.w, 'x')}%`,
        `height:${pxToPercent(obj.h, 'y')}%`,
    ];

    if (obj.rotation) styles.push(`transform:rotate(${obj.rotation}deg)`, 'transform-origin:center center');
    if (obj.borderWidth && obj.borderColor) {
        styles.push(`border:${sizeUnit(obj.borderWidth, 'y')} solid ${obj.borderColor}`);
    }
    if (obj.borderRadius) {
        styles.push(
            obj.borderRadius >= BORDER_RADIUS_ROUND
                ? 'border-radius:50%'
                : `border-radius:${sizeUnit(obj.borderRadius, 'x')}`,
        );
        styles.push('overflow:hidden');
    }

    if (obj.type === 'text') {
        if (obj.backgroundColor) styles.push(`background-color:${obj.backgroundColor}`);
        const vAlign = obj.verticalAlign || 'top';
        const alignItems = vAlign === 'center' ? 'center' : vAlign === 'bottom' ? 'flex-end' : 'flex-start';

        const textStyles: string[] = [
            `font-size:${sizeUnit(obj.fontSize, 'y')}`,
            `line-height:${obj.lineHeight || 1.2}`,
            `color:${obj.color || '#000000'}`,
        ];
        if (obj.fontFamily) textStyles.push(`font-family:${getFontFamily(obj.fontFamily)}`);
        if (obj.fontWeight && obj.fontWeight !== 'normal') textStyles.push(`font-weight:${obj.fontWeight}`);
        if (obj.fontStyle && obj.fontStyle !== 'normal') textStyles.push(`font-style:${obj.fontStyle}`);
        if (obj.textDecoration && obj.textDecoration !== 'none')
            textStyles.push(`text-decoration:${obj.textDecoration}`);
        if (obj.textAlign) textStyles.push(`text-align:${obj.textAlign}`);
        if (obj.letterSpacing) textStyles.push(`letter-spacing:${sizeUnit(obj.letterSpacing, 'x')}`);

        const text = escapeHtml(obj.text);
        const textContent = obj.highlightColor
            ? `<span style="background-color:${obj.highlightColor};box-decoration-break:clone;-webkit-box-decoration-break:clone">${text}</span>`
            : text;

        return `<div style="${styles.join(';')}"><div style="width:100%;height:100%;display:flex;align-items:${alignItems}"><p style="white-space:pre-wrap;word-break:break-word;width:100%;margin:0;${textStyles.join(';')}">${textContent}</p></div></div>`;
    }

    if (obj.type === 'image') {
        const src = resolveImgSrc(obj.mediaName);
        if (!src) return `<div style="${styles.join(';')}"></div>`;
        return `<div style="${styles.join(';')}"><img src="${escapeHtml(src)}" alt="" style="width:100%;height:100%;object-fit:${obj.objectFit || 'contain'}" /></div>`;
    }

    return '';
}

export function renderSlideHtml(
    slide: SlideItem,
    objects: SlideObject[],
    sizeUnit: SizeUnit,
    resolveImgSrc: ImgSrcResolver,
    options?: { fillPage?: boolean },
): string {
    const fillPage = options?.fillPage ?? false;
    const containerStyles: string[] = [
        'position:relative',
        'width:100%',
        fillPage ? 'height:100%' : 'aspect-ratio:16/9',
        'overflow:hidden',
        'container-type:size',
    ];

    if (slide.backgroundColor) containerStyles.push(`background-color:${slide.backgroundColor}`);

    if (slide.backgroundMediaName) {
        const bgSrc = resolveImgSrc(slide.backgroundMediaName);
        if (bgSrc) {
            containerStyles.push(
                `background-image:url('${escapeHtml(bgSrc)}')`,
                'background-size:cover',
                'background-position:center',
            );
        }
    }

    const objectsHtml = objects.map((obj) => renderSlideObjectHtml(obj, sizeUnit, resolveImgSrc)).join('\n');

    return `<div class="slide" style="${containerStyles.join(';')}">\n${objectsHtml}\n</div>`;
}

export function stripSlidesExtension(name: string): string {
    return name.replace(/\.eigenslides$/, '');
}
