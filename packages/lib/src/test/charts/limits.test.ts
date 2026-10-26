import { describe, expect, test } from 'bun:test';
import {
    exceedsInlineGridLimits,
    fitsInlineGrid,
    INLINE_GRID_MAX_CATEGORIES,
    INLINE_GRID_MAX_SERIES,
    MAX_CHART_POINTS,
    newChartSeriesId,
    parseChartSpec,
    sampleChartSpec,
} from '../../charts';
import type { InlineChartData } from '../../types/chart';
import { inlineData, rangeData, stored } from './spec-fixtures';

describe('series ids', () => {
    const withIds = (...ids: unknown[]) =>
        stored({
            data: {
                ...inlineData(ids.length, 1),
                series: ids.map((id, i) => ({ id, name: `S${i}`, values: [1] })),
            },
        });

    test('every series has a string id of up to 64 letters, digits, - or _, unique in its chart', () => {
        expect(parseChartSpec(withIds('s-1', 'x-0', `A_${'z'.repeat(62)}`))?.data.series.map((s) => s.id)).toEqual([
            's-1',
            'x-0',
            `A_${'z'.repeat(62)}`,
        ]);
        for (const id of [undefined, 7, null, '', 'x'.repeat(65), 's 1', 's/1', 'é']) {
            expect(parseChartSpec(withIds(id))).toBeNull();
        }
        expect(parseChartSpec(withIds('s-1', 's-1'))).toBeNull();
    });

    test("a name a plain object inherits is no id, so a record keyed by ids can't reach a prototype", () => {
        for (const id of ['__proto__', 'constructor', 'prototype']) expect(parseChartSpec(withIds(id))).toBeNull();
    });

    test('a range series needs one too', () => {
        const series = rangeData.series.map(({ id, ...rest }) => rest);
        expect(parseChartSpec(stored({ data: { ...rangeData, series } }))).toBeNull();
    });

    test('a new id is s- and ten of nanoid, and the sample numbers its series', () => {
        expect(newChartSeriesId()).toMatch(/^s-[A-Za-z0-9_-]{10}$/);
        expect(newChartSeriesId()).not.toBe(newChartSeriesId());
        expect(sampleChartSpec('column').data.series.map((s) => s.id)).toEqual(['s-1', 's-2', 's-3']);
        expect(sampleChartSpec('pie').data.series.map((s) => s.id)).toEqual(['s-1']);
    });
});

describe('exceedsInlineGridLimits', () => {
    test('the grid edits up to its series and category limits; a longer series counts as rows', () => {
        expect(exceedsInlineGridLimits(inlineData(INLINE_GRID_MAX_SERIES, 1))).toBe(false);
        expect(exceedsInlineGridLimits(inlineData(1, INLINE_GRID_MAX_CATEGORIES))).toBe(false);
        expect(exceedsInlineGridLimits(inlineData(INLINE_GRID_MAX_SERIES + 1, 1))).toBe(true);
        expect(exceedsInlineGridLimits(inlineData(1, INLINE_GRID_MAX_CATEGORIES + 1))).toBe(true);
        const ragged: InlineChartData = {
            source: 'inline',
            categories: [],
            series: [{ id: 's-1', name: 'S', values: Array(INLINE_GRID_MAX_CATEGORIES + 1).fill(1) }],
        };
        expect(exceedsInlineGridLimits(ragged)).toBe(true);
    });

    test('a full grid of 12 series by 200 rows is past the points limit, so its cells count too', () => {
        expect(INLINE_GRID_MAX_SERIES * INLINE_GRID_MAX_CATEGORIES).toBeGreaterThan(MAX_CHART_POINTS);
        expect(exceedsInlineGridLimits(inlineData(INLINE_GRID_MAX_SERIES, INLINE_GRID_MAX_CATEGORIES))).toBe(true);
        expect(exceedsInlineGridLimits(inlineData(10, MAX_CHART_POINTS / 10))).toBe(false);
        expect(fitsInlineGrid(10, MAX_CHART_POINTS / 10)).toBe(true);
        expect(fitsInlineGrid(11, MAX_CHART_POINTS / 10)).toBe(false);
        // A ragged chart's grid pads every series to the longest, so the grid's cells are what count.
        const ragged: InlineChartData = {
            source: 'inline',
            categories: [],
            series: [
                { id: 's-0', name: 'Long', values: Array(INLINE_GRID_MAX_CATEGORIES).fill(1) },
                ...Array.from({ length: INLINE_GRID_MAX_SERIES - 1 }, (_, i) => ({
                    id: `s-${i + 1}`,
                    name: 'Short',
                    values: [1],
                })),
            ],
        };
        expect(exceedsInlineGridLimits(ragged)).toBe(true);
    });
});
