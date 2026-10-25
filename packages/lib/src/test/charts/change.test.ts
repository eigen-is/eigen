import { describe, expect, test } from 'bun:test';
import { applyChartSpecChange, chartPointMoves, chartSpecChange, MAX_CHART_POINTS } from '../../charts';
import type { ChartSpecChange, StoredChartSpec } from '../../types/chart';
import { chart, stored } from './spec-fixtures';

describe('chartSpecChange', () => {
    test('is the leaves that differ; records are walked and arrays set whole', () => {
        const base = chart();
        const next = {
            ...base,
            title: { text: 'New' },
            axes: { ...base.axes, y: { ...base.axes.y, scale: { ...base.axes.y.scale, max: 50 } } },
            points: { 's-1': { 0: { color: '#eb6834' } } },
        };
        expect(chartSpecChange(base, next)).toEqual([
            { op: 'set', path: ['title', 'text'], value: 'New' },
            { op: 'set', path: ['axes', 'y', 'scale', 'max'], value: 50 },
            { op: 'set', path: ['points', 's-1'], value: { 0: { color: '#eb6834' } } },
        ]);
    });

    test('a spread that reorders the keys changes nothing', () => {
        const base = chart();
        const { title, data, ...rest } = base;
        expect(chartSpecChange(base, { data, ...rest, title })).toEqual([]);
    });
});

describe('applyChartSpecChange', () => {
    const raw = {
        ...chart(),
        future: 1,
        legend: { position: 'inside' },
        axes: { ...chart().axes, y: { ...chart().axes.y, scale: { ...chart().axes.y.scale, logBase: 10 } } },
        data: {
            ...chart().data,
            future: 3,
            series: chart().data.series.map((series) => ({ ...series, sizes: [1, 2] })),
        },
    };
    // The whole spec as JSON.parse makes it, a key beside the parts too.
    const parsed = (): StoredChartSpec => JSON.parse(JSON.stringify(raw));
    const apply = (change: ChartSpecChange) => applyChartSpecChange(parsed(), change);

    test('unknown keys at every level, and an unknown legend, survive a change elsewhere', () => {
        const next = apply([
            { op: 'set', path: ['title', 'text'], value: 'New' },
            { op: 'set', path: ['axes', 'y', 'scale', 'max'], value: 50 },
        ]);
        expect(JSON.parse(JSON.stringify(next))).toEqual({
            ...raw,
            title: { text: 'New' },
            axes: { ...raw.axes, y: { ...raw.axes.y, scale: { ...raw.axes.y.scale, max: 50 } } },
        });
    });

    test('leaves the stored spec it was given, and the values it sets, as they were', () => {
        const before = parsed();
        const value = { color: '#eb6834' };
        applyChartSpecChange(before, [
            { op: 'set', path: ['axes', 'y', 'scale', 'max'], value: 50 },
            { op: 'set', path: ['axes', 'y', 'scale', 'min'], value: 0 },
            { op: 'set', path: ['points', 's-1', '3'], value },
            { op: 'set', path: ['points', 's-1', '3', 'color'], value: '#2a78d6' },
        ]);
        expect(before).toEqual(raw);
        expect(value).toEqual({ color: '#eb6834' });
    });

    test('a series list is set whole, each series laid over the stored one with its id, a gone one gone', () => {
        const [, second, third] = chart().data.series;
        const next = apply([{ op: 'set', path: ['data', 'series'], value: [{ ...third, name: 'Hot' }, second] }]);
        expect(JSON.parse(JSON.stringify(next)).data.series).toEqual([
            { ...third, name: 'Hot', sizes: [1, 2] },
            { ...second, sizes: [1, 2] },
        ]);
        const fresh = { ...third, id: 's-new' };
        expect(
            JSON.parse(JSON.stringify(apply([{ op: 'set', path: ['data', 'series'], value: [fresh] }]))).data.series,
        ).toEqual([fresh]);
    });

    test('a set makes the records along its path; a remove of what is not there changes nothing', () => {
        const next = apply([{ op: 'set', path: ['points', 's-1', '3', 'color'], value: '#eb6834' }]);
        expect(next.points).toEqual({ 's-1': { 3: { color: '#eb6834' } } });
        expect(apply([{ op: 'remove', path: ['future'] }]).future).toBeUndefined();
        expect(apply([{ op: 'remove', path: ['nothing', 'here'] }])).toEqual(parsed());
    });

    test('a move takes the value to its new path, and nothing at from leaves nothing there', () => {
        const next = apply([{ op: 'move', from: ['future'], path: ['past'] }]);
        expect([next.future, next.past]).toEqual([undefined, 1]);
        expect(apply([{ op: 'move', from: ['nothing'], path: ['future'] }]).future).toBeUndefined();
    });

    test('the records it makes and copies have no prototype', () => {
        const next = apply([{ op: 'set', path: ['points', 's-1', '3', 'color'], value: '#eb6834' }]);
        expect(Object.getPrototypeOf(next)).toBeNull();
        expect(Object.getPrototypeOf(next.points)).toBeNull();
    });

    test('an op through __proto__, constructor or prototype changes nothing and leaves Object.prototype alone', () => {
        const before = parsed();
        for (const key of ['__proto__', 'constructor', 'prototype']) {
            const change: ChartSpecChange = [
                { op: 'set', path: [key, 'polluted'], value: true },
                { op: 'set', path: ['axes', key], value: { polluted: true } },
                { op: 'remove', path: [key] },
                { op: 'move', from: ['future'], path: [key] },
            ];
            expect(applyChartSpecChange(before, change)).toBe(before);
        }
        expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    });

    test('a stored __proto__ key stays data through a change', () => {
        const read: StoredChartSpec = JSON.parse(stored({ ['__proto__']: { polluted: true } }));
        const next = applyChartSpecChange(read, [{ op: 'set', path: ['title', 'text'], value: 'New' }]);
        expect(JSON.stringify(next)).toContain('"__proto__":{"polluted":true}');
        expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    });
});

describe('chartPointMoves', () => {
    const points = (colors: Record<number, string>) => ({
        points: { 's-1': Object.fromEntries(Object.entries(colors).map(([i, color]) => [i, { color, future: i }])) },
    });
    const moved = (before: Record<number, string>, target: (index: number) => number | null) =>
        JSON.parse(JSON.stringify(applyChartSpecChange(points(before), chartPointMoves(points(before), target))))
            .points['s-1'];

    test('a delete removes its points and moves the ones after it down, unknown keys with them', () => {
        const after = moved({ 0: '#000000', 1: '#000001', 2: '#000002', 3: '#000003' }, (i) =>
            i === 1 ? null : i > 1 ? i - 1 : i,
        );
        expect(after).toEqual({
            0: { color: '#000000', future: '0' },
            1: { color: '#000002', future: '2' },
            2: { color: '#000003', future: '3' },
        });
    });

    test('an insert moves the points after it up, from the highest, leaving the inserted ones automatic', () => {
        const after = moved({ 0: '#000000', 1: '#000001', 2: '#000002' }, (i) => (i >= 1 ? i + 1 : i));
        expect(after).toEqual({
            0: { color: '#000000', future: '0' },
            2: { color: '#000001', future: '1' },
            3: { color: '#000002', future: '2' },
        });
    });

    // An xlsx pie can store a point on every slice, and each row op moves them all.
    test('applies a move of every point in linear time', () => {
        const shift = (i: number) => (i === 0 ? null : i - 1);
        const applying = (count: number) => {
            const stored = points(Object.fromEntries(Array.from({ length: count }, (_, i) => [i, '#000000'])));
            const change = chartPointMoves(stored, shift);
            return () => applyChartSpecChange(stored, change);
        };
        const fastest = (run: () => unknown) =>
            Math.min(
                ...Array.from({ length: 7 }, () => {
                    const start = performance.now();
                    run();
                    return performance.now() - start;
                }),
            );
        // Timed against a tenth of the points, so load slows both: linear is about 10x, a copy per move 100x.
        expect(fastest(applying(MAX_CHART_POINTS))).toBeLessThan(30 * fastest(applying(MAX_CHART_POINTS / 10)));
        const after = moved(
            Object.fromEntries(Array.from({ length: MAX_CHART_POINTS }, (_, i) => [i, '#000000'])),
            shift,
        );
        expect(Object.keys(after)).toHaveLength(MAX_CHART_POINTS - 1);
        expect(after[MAX_CHART_POINTS - 2]).toEqual({ color: '#000000', future: String(MAX_CHART_POINTS - 1) });
    });

    test('only a stored point moves, and an index that stays writes nothing', () => {
        expect(moved({ 1: '#000001' }, (i) => (i === 0 ? 1 : null))).toEqual({});
        expect(chartPointMoves(points({ 0: '#000000', 1: '#000001', 2: '#000002' }), (i) => i)).toEqual([]);
    });
});
