import { getFontFamily } from '@workspace/lib/constants/fonts';
import { escapeHtml } from '@workspace/lib/html';
import {
    BORDER_RADIUS_ROUND,
    type DeckData,
    pxToPercent,
    SLIDE_BASE_HEIGHT,
    SLIDE_BASE_WIDTH,
    type SlideItem,
    type SlideObject,
} from '@workspace/lib/slides';
import DOMPurify from 'isomorphic-dompurify';
import type { SizeUnit, SlideImgSrcResolver } from '../render-types';

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

export function renderSlideObjectHtml(
    obj: SlideObject,
    sizeUnit: SizeUnit,
    resolveImgSrc: SlideImgSrcResolver,
): string {
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
        if (obj.background?.type === 'solid') {
            styles.push(`background-color:${obj.background.color}`);
        } else if (obj.background?.type === 'gradient') {
            // Why: no `in oklab` — WeasyPrint (PDF export) drops gradients with
            // color-interpolation-method as invalid. Live editor uses
            // getBackgroundStyle in real browsers and emits oklab there.
            const { from, to, angle } = obj.background;
            styles.push(`background-image:linear-gradient(${angle}deg, ${from}, ${to})`);
        }
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

        const safeText = DOMPurify.sanitize(obj.text);
        const textContent = obj.highlightColor
            ? `<span style="background-color:${escapeHtml(obj.highlightColor)};box-decoration-break:clone;-webkit-box-decoration-break:clone">${safeText}</span>`
            : safeText;

        return `<div style="${styles.join(';')}"><div style="width:100%;height:100%;display:flex;align-items:${alignItems}"><div class="slide-text" style="white-space:pre-wrap;word-break:break-word;width:100%;${textStyles.join(';')}">${textContent}</div></div></div>`;
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
    resolveImgSrc: SlideImgSrcResolver,
    options?: { fillPage?: boolean; pageWidthPx?: number; pageHeightPx?: number },
): string {
    const fillPage = options?.fillPage ?? false;
    const containerStyles: string[] = ['position:relative', 'overflow:hidden'];

    if (fillPage && options?.pageWidthPx && options?.pageHeightPx) {
        // PDF mode: explicit pixel dimensions (WeasyPrint doesn't support container queries or % height)
        containerStyles.push(`width:${options.pageWidthPx}px`, `height:${options.pageHeightPx}px`);
    } else if (fillPage) {
        containerStyles.push('width:100%', 'height:100%', 'container-type:size');
    } else {
        containerStyles.push('width:100%', 'aspect-ratio:16/9', 'container-type:size');
    }

    const bg = slide.background;
    if (bg?.type === 'solid') {
        containerStyles.push(`background-color:${bg.color}`);
    } else if (bg?.type === 'gradient') {
        containerStyles.push(`background-image:linear-gradient(${bg.angle}deg, ${bg.from}, ${bg.to})`);
    } else if (bg?.type === 'image' && bg.mediaName) {
        const bgSrc = resolveImgSrc(bg.mediaName);
        if (bgSrc) {
            containerStyles.push(
                `background-image:url('${escapeHtml(bgSrc)}')`,
                `background-size:${bg.fit}`,
                'background-position:center',
                'background-repeat:no-repeat',
            );
        }
    }

    const objectsHtml = objects.map((obj) => renderSlideObjectHtml(obj, sizeUnit, resolveImgSrc)).join('\n');

    return `<div class="slide" style="${containerStyles.join(';')}">\n${objectsHtml}\n</div>`;
}

export function renderDeckHtml(
    deck: DeckData,
    sizeUnit: SizeUnit,
    resolveImgSrc: SlideImgSrcResolver,
    slideOptions?: { fillPage?: boolean; pageWidthPx?: number; pageHeightPx?: number },
): string {
    return deck.slideOrder
        .map((slideId) => {
            const slide = deck.slides[slideId];
            if (!slide) return '';
            const objects = slide.objectIds.map((id) => deck.objects[id]).filter(Boolean);
            return renderSlideHtml(slide, objects, sizeUnit, resolveImgSrc, slideOptions);
        })
        .filter(Boolean)
        .join('\n');
}

export function stripSlidesExtension(name: string): string {
    return name.replace(/\.eigenslides$/, '');
}
