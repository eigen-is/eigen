import { describe, expect, test } from 'bun:test';
import { ELEMENT_KINDS } from '../../../vector/kinds';
import { outlinePath, rectOutline } from '../../../vector/outline';
import type { VectorImageElement } from '../../../vector/types';
import { image } from '../element-factories';

// Unless a case says otherwise the picture resolves; these are about the border drawn around it.
function makeImage(over: Partial<VectorImageElement> = {}): VectorImageElement {
    return image({ id: 'im1', mediaName: 'p.png', ...over });
}

function svgOf(el: VectorImageElement): string {
    const out = ELEMENT_KINDS.image.render(el, { resolveMedia: () => 'https://example.test/p.png' });
    if ('html' in out) throw new Error('an image must render svg');
    return out.svg;
}

describe('image border', () => {
    test('a stroked image draws its outline on top of the picture', () => {
        const svg = svgOf(makeImage({ strokeColor: '#1e1e1e', strokeWidth: 2, corners: 'straight' }));
        expect(svg).toContain('stroke="#1e1e1e"');
        expect(svg).toContain('stroke-width="2"');
        expect(svg).toContain('fill="none"');
        // The border is drawn AFTER the image, or the picture paints over it.
        expect(svg.indexOf('<image')).toBeLessThan(svg.lastIndexOf('stroke='));
    });

    test('the border is the roughjs drawable the shapes draw, not a plain outline', () => {
        const bordered = { strokeColor: '#1e1e1e', strokeWidth: 2, corners: 'straight', roughness: 1 } as const;
        const svg = svgOf(makeImage({ ...bordered, seed: 5 }));
        const border = svg.slice(svg.indexOf('<g stroke-linecap="round">'));
        expect(border).toStartWith('<g stroke-linecap="round">');
        // roughjs draws each edge twice, so the border is many subpaths where the silhouette is one.
        const d = border.match(/\sd="([^"]+)"/)?.[1] ?? '';
        expect(d.match(/M/g)?.length ?? 0).toBeGreaterThan(1);
        expect(d).not.toBe(outlinePath(rectOutline({ x: 0, y: 0, width: 100, height: 60 }, 0, 0)));
        // The jitter is the stored seed's, so the same box renders byte-identically every time.
        expect(svgOf(makeImage({ ...bordered, seed: 5 }))).toBe(svg);
        expect(svgOf(makeImage({ ...bordered, seed: 6 }))).not.toBe(svg);
    });

    test('a rounded image still clips its picture to the silhouette path', () => {
        const rounded = svgOf(
            makeImage({ strokeColor: '#111', strokeWidth: 1, corners: 'round', width: 200, height: 80 }),
        );
        const d = outlinePath(rectOutline({ x: 0, y: 0, width: 200, height: 80 }, 40, 0));
        expect(rounded).toContain(`<clipPath id="image-clip-im1"><path d="${d}"/></clipPath>`);
        expect(rounded).toContain('<g stroke-linecap="round">');
    });

    test('a transparent stroke colour or zero width draws no border', () => {
        expect(svgOf(makeImage({ strokeColor: 'transparent', strokeWidth: 2 }))).not.toContain('stroke=');
        expect(svgOf(makeImage({ strokeColor: '#111', strokeWidth: 0 }))).not.toContain('stroke=');
    });

    test('strokeStyle becomes a dash array, like every other kind', () => {
        expect(svgOf(makeImage({ strokeColor: '#111', strokeWidth: 2, strokeStyle: 'dashed' }))).toContain(
            'stroke-dasharray=',
        );
    });

    test('unresolvable media draws a placeholder and the border, so the box stays visible', () => {
        const out = ELEMENT_KINDS.image.render(makeImage({ strokeColor: '#111', strokeWidth: 2 }), {
            resolveMedia: () => null,
        });
        if ('html' in out) throw new Error('an image must render svg');
        expect(out.svg).not.toContain('<image');
        expect(out.svg).toContain('stroke-dasharray');
        expect(out.svg).toContain('stroke="#111"');
    });

    test('an unbordered image whose media is missing still draws the placeholder', () => {
        const out = ELEMENT_KINDS.image.render(makeImage({ strokeColor: 'transparent' }), {
            resolveMedia: () => null,
        });
        expect(!('html' in out) && out.svg).not.toBe('');
    });

    // paintsNothing says exactly this, so the empty-outline ring and the render agree.
    test('an image with no media name and no border renders nothing', () => {
        const out = ELEMENT_KINDS.image.render(makeImage({ mediaName: '', strokeColor: 'transparent' }), {
            resolveMedia: () => null,
        });
        expect(!('html' in out) && out.svg).toBe('');
    });

    test('an image with no media name but a border draws the border alone', () => {
        const out = ELEMENT_KINDS.image.render(makeImage({ mediaName: '', strokeColor: '#111', strokeWidth: 2 }), {
            resolveMedia: () => null,
        });
        if ('html' in out) throw new Error('an image must render svg');
        expect(out.svg).toContain('stroke="#111"');
        expect(out.svg).not.toContain('stroke-dasharray');
    });
});
