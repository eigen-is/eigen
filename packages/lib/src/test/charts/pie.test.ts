import { describe, expect, test } from 'bun:test';
import { chartColor } from '../../charts';
import { solidFill } from '../../vector/fill';
import { labelBounds, layout, overlaps, rects, series, slices } from './layout-fixtures';

describe('pie', () => {
    test("slices sweep their share clockwise from 12 o'clock and sum to 360", () => {
        const out = layout('pie');
        const pie = slices(out);
        expect(pie).toHaveLength(7);
        expect(pie[0].startAngle).toBe(270);
        expect(pie.reduce((sum, slice) => sum + slice.sweepAngle, 0)).toBeCloseTo(360);
        expect(pie[0].sweepAngle).toBeCloseTo((13.1 / 100) * 360);
        for (let i = 1; i < pie.length; i++) {
            expect(pie[i].startAngle).toBeCloseTo((pie[i - 1].startAngle + pie[i - 1].sweepAngle) % 360);
        }
        const [first] = pie;
        expect(first.width).toBe(first.height);
        for (const slice of pie) expect(slice.x).toBe(first.x);
    });

    test("slices take their first series' points, then the palette, and the legend shows the same", () => {
        const out = layout('pie', { legend: { position: 'right' }, points: { 's-1': { 0: { color: '#000000' } } } });
        const pie = slices(out);
        expect(pie[0].fill).toBe(solidFill('#000000'));
        expect(pie[1].fill).toBe(solidFill(chartColor(1)));
        expect(rects(out, 'legend')[0].fill).toBe(solidFill('#000000'));
        const points = { 's-1': { 1: { color: '#000000' }, 2: { color: null } }, other: { 0: { color: '#ffffff' } } };
        const automatic = slices(layout('pie', { points }));
        expect(automatic.map((slice) => slice.fill)).toEqual(
            [chartColor(0), '#000000', chartColor(2), chartColor(3), chartColor(4), chartColor(5), chartColor(6)].map(
                (color) => solidFill(color),
            ),
        );
    });

    test('labels read name and percent; slices under 5% go unlabeled', () => {
        const out = layout(
            'pie',
            {},
            {
                data: { categories: ['Big', 'Small', 'Rest'], series: [series('S', [70, 4, 26])] },
            },
        );
        const texts = out.labels.map((label) => label.text);
        expect(texts).toContain('Big 70%');
        expect(texts).toContain('Rest 26%');
        expect(texts.some((text) => text.startsWith('Small'))).toBe(false);
        expect(slices(out)).toHaveLength(3);
        const big = out.labels.find((label) => label.text === 'Big 70%');
        const rest = out.labels.find((label) => label.text === 'Rest 26%');
        // 70% clockwise from 12 o'clock is centered lower right, the last 26% upper left
        expect(big?.anchor).toBe('start');
        expect(rest?.anchor).toBe('end');
    });

    // Two small neighbors near 6 o'clock put their middle-anchored labels on one line, closer than a label's width.
    test('a label that would touch one already placed hides, the largest slices placed first', () => {
        const out = layout(
            'pie',
            { title: { text: '' } },
            {
                data: {
                    categories: ['Delta', 'Alpha region', 'Beta region', 'Gamma region', 'Eps'],
                    series: [series('S', [44, 6, 6, 6, 38])],
                },
                width: 400,
                height: 300,
            },
        );
        const texts = out.labels.map((label) => label.text);
        expect(texts).toContain('Delta 44%');
        expect(texts).toContain('Eps 38%');
        expect(texts).toContain('Alpha region 6%');
        expect(texts).not.toContain('Beta region 6%');
        const bounds = out.labels.map(labelBounds);
        for (let i = 0; i < bounds.length; i++) {
            for (let j = i + 1; j < bounds.length; j++) expect(overlaps(bounds[i], bounds[j])).toBe(false);
        }
    });

    test('one slice of 100% sweeps the full circle', () => {
        const out = layout('pie', {}, { data: { categories: ['All', 'None'], series: [series('S', [5, 0])] } });
        const pie = slices(out);
        expect(pie).toHaveLength(1);
        expect(pie[0].sweepAngle).toBe(360);
        expect(out.labels.map((label) => label.text)).toContain('All 100%');
    });

    test('a negative value or a zero total draws a message, no slices', () => {
        for (const values of [
            [5, -1],
            [0, 0],
            [null, null],
        ]) {
            const out = layout('pie', {}, { data: { categories: ['A', 'B'], series: [series('S', values)] } });
            expect(slices(out)).toEqual([]);
            expect(out.labels).toHaveLength(1);
            expect(out.labels[0].anchor).toBe('middle');
        }
    });
});
