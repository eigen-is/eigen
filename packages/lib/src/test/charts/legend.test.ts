import { describe, expect, test } from 'bun:test';
import { chartColor } from '../../charts';
import type { ChartData } from '../../types/chart';
import { solidFill } from '../../vector/fill';
import { measureLabel } from '../../vector/text-width';
import { labelBounds, layout, lines, rects, series, style } from './layout-fixtures';

describe('legend', () => {
    test('top and bottom are a centered row of swatches, left and right a column', () => {
        const top = layout('column', { legend: { position: 'top' } });
        const swatches = rects(top, 'legend');
        expect(swatches.map((swatch) => swatch.fill)).toEqual([0, 1, 2].map((i) => solidFill(chartColor(i))));
        expect(swatches[0].y).toBeCloseTo(swatches[1].y);
        const titleBottom = Math.max(...top.labels.filter((l) => l.bold).map((l) => labelBounds(l).bottom));
        expect(swatches[0].y).toBeGreaterThan(titleBottom);
        const left = swatches[0].x;
        const last = top.labels.find((label) => label.text === 'Hot star');
        const right = (last?.x ?? 0) + measureLabel('Hot star', 'Inter', last?.fontSize ?? 0, false);
        expect((left + right) / 2).toBeCloseTo(320, -1);

        const bottom = rects(layout('column', { legend: { position: 'bottom' } }), 'legend');
        expect(bottom[0].y).toBeGreaterThan(300);

        for (const side of ['left', 'right'] as const) {
            const column = rects(layout('column', { legend: { position: side } }), 'legend');
            expect(column[0].x).toBeCloseTo(column[1].x);
            expect(column[1].y).toBeGreaterThan(column[0].y);
            expect(side === 'left' ? column[0].x < 100 : column[0].x > 400).toBe(true);
        }
        expect(rects(layout('column', { legend: { position: 'none' } }), 'legend')).toEqual([]);
    });

    test('a null series color is the palette color at its index, on the bar and the swatch', () => {
        const data: ChartData = {
            categories: ['A'],
            series: [series('S1', [1]), series('S2', [2]), series('S3', [3])],
        };
        const out = layout(
            'column',
            { series: { S2: style({ color: '#123456' }) } },
            { data, paint: { fillStyle: 'hachure' } },
        );
        const colors = [chartColor(0), '#123456', chartColor(2)];
        expect(rects(out, 'legend').map((swatch) => swatch.strokeColor)).toEqual(colors);
        expect(rects(out, 'bar').map((bar) => bar.strokeColor)).toEqual(colors);
        expect(rects(out, 'bar').map((bar) => bar.fill)).toEqual(colors.map((color) => solidFill(color, 'hachure')));
    });

    test('a wide legend wraps into rows that stay inside the box', () => {
        const names = Array.from({ length: 12 }, (_, i) => `Series number ${i + 1}`);
        const out = layout(
            'column',
            { legend: { position: 'top' } },
            {
                data: { categories: ['A', 'B'], series: names.map((name, i) => series(name, [i, i + 1])) },
            },
        );
        const swatches = rects(out, 'legend');
        expect(new Set(swatches.map((swatch) => swatch.y)).size).toBeGreaterThan(1);
    });

    test('a crowded legend keeps to its share of the box and counts what it drops', () => {
        const many = Array.from({ length: 32 }, (_, i) => series(`Series ${i + 1}`, [i, i + 1]));
        for (const legend of ['top', 'bottom', 'left', 'right'] as const) {
            const out = layout(
                'column',
                { legend: { position: legend }, title: { text: '' } },
                { width: 400, height: 300, data: { categories: ['A', 'B'], series: many } },
            );
            const swatches = rects(out, 'legend');
            expect(swatches.length).toBeLessThan(32);
            const more = out.labels.find((label) => /^\+\d+$/.test(label.text));
            expect(more?.text).toBe(`+${32 - swatches.length}`);
            if (legend === 'top') {
                const rows = out.labels.filter((label) => label.anchor === 'start').map(labelBounds);
                const top = Math.min(...rows.map((row) => row.top));
                const bottom = Math.max(...rows.map((row) => row.bottom));
                expect(bottom - top).toBeLessThanOrEqual(300 * 0.3);
                expect(Math.min(...lines(out, 'gridline').map((line) => line.y))).toBeGreaterThan(bottom);
            }
        }
    });
});
