import { describe, expect, test } from 'bun:test';
import { serializePoints } from '../../../vector/geometry';
import { ELEMENT_KINDS } from '../../../vector/kinds';
import type { VectorArrowElement } from '../../../vector/types';
import { arrow } from '../element-factories';

// A label only exists once the client has measured it, so every fixture here carries text + labelWidth.
function labelled(over: Partial<VectorArrowElement> = {}): VectorArrowElement {
    return arrow({ id: 'ar1', text: 'Two', labelWidth: 70, fontSize: 20, ...over });
}

function svgOf(el: VectorArrowElement): string {
    return ELEMENT_KINDS.arrow.render(el, {}).svg;
}

describe('arrow label hole', () => {
    test('the hole is a mask, never an even-odd clip', () => {
        const svg = svgOf(labelled());
        expect(svg).toContain('<mask id="arrow-label-mask-ar1" maskUnits="userSpaceOnUse"');
        // WeasyPrint ignores clip-rule="evenodd", and the shaft then strikes through the label in a PDF.
        expect(svg).not.toContain('evenodd');
        expect(svg).not.toContain('clipPath');
    });

    test('the mask paints a white ground and a black label rect', () => {
        const svg = svgOf(labelled({ text: 'Two\nLines' }));
        const mask = svg.slice(svg.indexOf('<mask'), svg.indexOf('</mask>'));
        const rects = [...mask.matchAll(/<rect [^>]*\/>/g)].map((m) => m[0]);
        expect(rects).toHaveLength(2);
        expect(rects[0]).toContain('fill="#fff"');
        expect(rects[1]).toContain('fill="#000"');
        // The hole is the label rect + 5px of padding: two lines at 20px, centered on the midpoint.
        expect(rects[1]).toContain('width="80"');
        expect(rects[1]).toContain('height="60"');
    });

    test('the mask rides every shaft path, not a wrapping group', () => {
        // Headless, so every path after the mask IS the shaft.
        const svg = svgOf(labelled({ startArrowhead: 'none', endArrowhead: 'none' }));
        const shaft = svg.slice(svg.indexOf('</mask>'), svg.indexOf('<text'));
        const paths = [...shaft.matchAll(/<path /g)];
        expect(paths.length).toBeGreaterThan(0);
        // WeasyPrint applies a mask AFTER drawing a group's children, so `<g mask>` masks nothing there.
        expect(shaft).not.toContain('<g mask=');
        expect([...shaft.matchAll(/mask="url\(#arrow-label-mask-ar1\)"/g)]).toHaveLength(paths.length);
    });

    test('the arrowheads draw on top, unmasked', () => {
        const headless = svgOf(labelled({ startArrowhead: 'none', endArrowhead: 'none' }));
        const headed = svgOf(labelled({ startArrowhead: 'none', endArrowhead: 'arrow' }));
        const masked = (svg: string) => [...svg.matchAll(/mask="url\(#/g)].length;
        expect([...headed.matchAll(/<path /g)].length).toBeGreaterThan([...headless.matchAll(/<path /g)].length);
        expect(masked(headed)).toBe(masked(headless));
    });

    test('the ground rect encloses the whole shaft, however long the arrow', () => {
        const long = labelled({
            points: serializePoints([
                { x: 0, y: 0 },
                { x: 4000, y: 0 },
            ]),
        });
        const ground = svgOf(long).match(/<rect [^>]*fill="#fff"\/>/)?.[0] ?? '';
        expect(Number(ground.match(/width="([\d.-]+)"/)?.[1])).toBeGreaterThan(4000);
    });

    test('the mask id is element-scoped, so two labelled arrows never collide', () => {
        expect(svgOf(labelled({ id: 'ar2' }))).toContain('<mask id="arrow-label-mask-ar2"');
    });

    test('an unlabelled arrow carries no mask at all', () => {
        const svg = svgOf(arrow({ id: 'ar1' }));
        expect(svg).not.toContain('<mask');
        expect(svg).not.toContain('mask=');
    });
});
