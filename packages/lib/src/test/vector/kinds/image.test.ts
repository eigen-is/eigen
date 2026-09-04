import { describe, expect, test } from 'bun:test';
import { ELEMENT_KINDS } from '../../../vector/kinds';
import type { VectorImageElement } from '../../../vector/types';
import { image } from '../element-factories';

// Unless a case says otherwise the picture resolves; these are about the border drawn around it.
function makeImage(over: Partial<VectorImageElement> = {}): VectorImageElement {
    return image({ id: 'im1', mediaName: 'p.png', ...over });
}

function svgOf(el: VectorImageElement): string {
    const out = ELEMENT_KINDS.image.render(el, { resolveMedia: () => 'https://example.test/p.png' });
    if (!('svg' in out)) throw new Error('an image must render svg');
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

    test('the border follows the corner treatment — the same path the clip uses', () => {
        const rounded = svgOf(
            makeImage({ strokeColor: '#111', strokeWidth: 1, corners: 'round', width: 200, height: 80 }),
        );
        // One definition of the silhouette: the clipPath's `d` and the border's `d` are identical.
        const ds = [...rounded.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
        expect(ds.length).toBe(2);
        expect(ds[0]).toBe(ds[1]);
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
        if (!('svg' in out)) throw new Error('an image must render svg');
        expect(out.svg).not.toContain('<image');
        expect(out.svg).toContain('stroke-dasharray');
        expect(out.svg).toContain('stroke="#111"');
    });

    test('an unbordered image whose media is missing still draws the placeholder', () => {
        const out = ELEMENT_KINDS.image.render(makeImage({ strokeColor: 'transparent' }), {
            resolveMedia: () => null,
        });
        expect('svg' in out && out.svg).not.toBe('');
    });

    // paintsNothing says exactly this, so the empty-outline ring and the render agree.
    test('an image with no media name and no border renders nothing', () => {
        const out = ELEMENT_KINDS.image.render(makeImage({ mediaName: '', strokeColor: 'transparent' }), {
            resolveMedia: () => null,
        });
        expect('svg' in out && out.svg).toBe('');
    });

    test('an image with no media name but a border draws the border alone', () => {
        const out = ELEMENT_KINDS.image.render(makeImage({ mediaName: '', strokeColor: '#111', strokeWidth: 2 }), {
            resolveMedia: () => null,
        });
        if (!('svg' in out)) throw new Error('an image must render svg');
        expect(out.svg).toContain('stroke="#111"');
        expect(out.svg).not.toContain('stroke-dasharray');
    });
});
