import { describe, expect, test } from 'bun:test';
import { chartColor } from '../../charts';
import { solidFill } from '../../vector/fill';
import type { SpecPatch } from './layout-fixtures';
import { layout, lines, rects, slices } from './layout-fixtures';

describe('outlines follow the fill style', () => {
    const legend: SpecPatch = { legend: { position: 'right' } };

    test('a solid fill draws bars, slices and legend swatches with no outline, the bars filling their slots', () => {
        const column = layout('column', legend, { paint: { strokeWidth: 4 } });
        const pie = layout('pie', legend);
        for (const shape of [
            ...rects(column, 'bar'),
            ...rects(column, 'legend'),
            ...slices(pie),
            ...rects(pie, 'legend'),
        ])
            expect([shape.id, shape.strokeColor]).toEqual([shape.id, 'transparent']);
        for (const bar of rects(column, 'bar')) expect(bar.strokeWidth).toBe(0);
    });

    test.each(['hachure', 'cross-hatch', 'zigzag'] as const)('%s outlines each in its own color', (fillStyle) => {
        const colors = [chartColor(0), chartColor(1), chartColor(2)];
        const column = layout('column', legend, { paint: { fillStyle, strokeWidth: 4 } });
        const bars = rects(column, 'bar');
        expect(new Set(bars.map((bar) => bar.strokeColor))).toEqual(new Set(colors));
        for (const bar of bars) {
            expect(bar.fill).toBe(solidFill(bar.strokeColor, fillStyle));
            expect(bar.strokeWidth).toBeGreaterThan(0);
        }
        expect(rects(column, 'legend').map((swatch) => swatch.strokeColor)).toEqual(colors);
        const pie = layout('pie', legend, { paint: { fillStyle } });
        for (const slice of slices(pie)) expect(slice.fill).toBe(solidFill(slice.strokeColor, fillStyle));
        expect(rects(pie, 'legend').map((swatch) => swatch.fill)).toEqual(slices(pie).map((slice) => slice.fill));
    });

    test('the axes and gridlines draw in the paint stroke whatever the fill style', () => {
        for (const fillStyle of ['solid', 'cross-hatch'] as const) {
            const out = layout('column', {}, { paint: { fillStyle, strokeColor: '#336699', strokeWidth: 4 } });
            for (const rule of [...lines(out, 'gridline'), ...lines(out, 'baseline')])
                expect([rule.strokeColor, rule.strokeWidth]).toEqual(['#336699', 4]);
        }
    });
});
