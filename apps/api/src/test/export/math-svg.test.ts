import { describe, expect, test } from 'bun:test';
import type { MathRow } from '@workspace/math';
import { equationMathml } from '../../lib/export/doc/equations';
import { mathmlToSvg } from '../../lib/export/math-svg';
import { sanitizeExportHtml } from '../../lib/export/sanitize';

const x: MathRow = [{ kind: 'identifier', text: 'x' }];
const one: MathRow = [{ kind: 'number', text: '1' }];
const sum: MathRow = [
    { kind: 'nary', operator: '∑', limits: 'under', sub: [{ kind: 'identifier', text: 'i' }], sup: one, body: x },
];

const svgOf = (row: MathRow, display = false) => mathmlToSvg(equationMathml(row, display));
const height = (svg: string) => Number(svg.match(/height="([\d.]+)ex"/)?.[1]);

describe('mathmlToSvg', () => {
    test.each([
        ['a fraction', [{ kind: 'fraction', numerator: x, denominator: one, line: 'bar' }], 'mfrac'],
        ['a sum', sum, 'munderover'],
        ['prescripts', [{ kind: 'scripts', base: x, sub: one, pre: true }], 'mmultiscripts'],
        ['an enclosure', [{ kind: 'enclose', notation: ['top', 'bottom', 'left', 'right'], body: x }], 'menclose'],
    ] satisfies [string, MathRow, string][])('draws %s as one SVG of paths', async (_name, row, element) => {
        const svg = await svgOf(row);

        expect(svg).toMatch(/^<svg [^>]*><g [\s\S]*<\/svg>$/);
        expect(svg.match(/<svg/g)).toHaveLength(1);
        expect(svg).toContain(`data-mml-node="${element}"`);
        expect(svg).toContain('<path');
        expect(svg).not.toMatch(/merror|data-mjx-error|<use|<defs/);
    });

    // MathJax would break it at the + into one SVG per piece.
    test('an inline equation is one SVG', async () => {
        const svg = await svgOf([...x, { kind: 'operator', text: '+' }, ...one]);
        expect(svg.match(/<svg/g)).toHaveLength(1);
    });

    // The baseline offset an inline equation sits on.
    test('an inline equation carries its vertical-align', async () => {
        expect(await svgOf(sum)).toMatch(/^<svg style="vertical-align: -[\d.]+ex;"/);
    });

    // A displayed sum sets its limits under and over it, an inline one beside it.
    test('display="block" draws a display equation', async () => {
        expect(height(await svgOf(sum, true))).toBeGreaterThan(height(await svgOf(sum)) * 1.5);
    });

    // But focusable, which only Internet Explorer read.
    test('the export sanitizer keeps every element and attribute it draws', async () => {
        const svg = await svgOf([{ kind: 'radical', body: [{ kind: 'identifier', text: 'y', color: '#D32F2F' }] }]);
        const html = `<p>${svg}</p>`;

        expect(sanitizeExportHtml(html)).toBe(html.replace(' focusable="false"', ''));
    });
});
