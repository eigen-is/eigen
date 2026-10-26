import { describe, expect, test } from 'bun:test';
import { chartPaintOf, FLAT_CHART_LOOK, readChartLook } from '../../charts';
import type { ChartLook } from '../../types/chart';
import { CHART_LOOK_FIELDS } from '../../types/chart';
import { isTransparentFill, parseFill, serializeFill } from '../../vector/fill';

const SKETCH: ChartLook = {
    fill: serializeFill({ type: 'gradient', from: '#ffeeaa', to: 'transparent', angle: 90, style: 'cross-hatch' }),
    color: '#ffffff',
    strokeColor: '#336699',
    strokeWidth: 4,
    strokeStyle: 'dashed',
    roughness: 2,
    seed: 1234,
};

describe('FLAT_CHART_LOOK', () => {
    test("is Google's flat look: no background, solid marks, no sketch", () => {
        expect(isTransparentFill(parseFill(FLAT_CHART_LOOK.fill))).toBe(true);
        expect(parseFill(FLAT_CHART_LOOK.fill).style).toBe('solid');
        expect(FLAT_CHART_LOOK).toMatchObject({ strokeStyle: 'solid', roughness: 0, strokeWidth: 2 });
    });

    test('names the look fields a canvas chart stores, all but the series width, which draws at the stroke unset', () => {
        expect([...Object.keys(FLAT_CHART_LOOK), 'seriesStrokeWidth'].sort()).toEqual([...CHART_LOOK_FIELDS].sort());
    });
});

describe('readChartLook', () => {
    test('a chart that stores no look reads flat', () => {
        expect(readChartLook({})).toEqual(FLAT_CHART_LOOK);
        expect(readChartLook({ fill: null, color: null, roughness: null })).toEqual(FLAT_CHART_LOOK);
    });

    test('keeps a stored look, a gradient and its hatch included', () => {
        expect(readChartLook({ ...SKETCH, spec: '{}', width: 3 })).toEqual(SKETCH);
        expect(readChartLook({ ...SKETCH, seriesStrokeWidth: 3 })).toEqual({ ...SKETCH, seriesStrokeWidth: 3 });
    });

    test('a series width that is no number is unset, and one out of range clamps as the stroke does', () => {
        for (const value of [null, '3', Number.NaN]) {
            expect(readChartLook({ seriesStrokeWidth: value }).seriesStrokeWidth).toBeUndefined();
        }
        expect(readChartLook({ seriesStrokeWidth: -5 }).seriesStrokeWidth).toBe(0);
        expect(readChartLook({ seriesStrokeWidth: 500 }).seriesStrokeWidth).toBe(100);
    });

    // A peer, a paste or the clipboard writes these; the canvas reader's own validators judge them.
    test('a hostile value reads as the canvas reader reads it', () => {
        const look = readChartLook({
            fill: '{"type":"solid","color":"url(#x)"}',
            color: 'red; background: url(x)',
            strokeColor: 7,
            strokeWidth: -5,
            strokeStyle: 'wavy',
            roughness: 99,
            seed: 0,
        });
        expect(isTransparentFill(parseFill(look.fill))).toBe(true);
        expect(look.color).toBe(FLAT_CHART_LOOK.color);
        expect(look.strokeColor).toBe(FLAT_CHART_LOOK.strokeColor);
        expect(look.strokeWidth).toBe(0);
        expect(look.strokeStyle).toBe('solid');
        expect(look.roughness).toBe(10);
        expect(look.seed).toBe(1);
    });
});

describe('chartPaintOf', () => {
    test("the fill is the background and its hatch the marks'; the rest map one to one", () => {
        expect(chartPaintOf(SKETCH)).toEqual({
            color: '#ffffff',
            background: SKETCH.fill,
            strokeColor: '#336699',
            strokeWidth: 4,
            seriesStrokeWidth: 4,
            strokeStyle: 'dashed',
            roughness: 2,
            seed: 1234,
            fillStyle: 'cross-hatch',
        });
    });

    test("a line series draws at its own width, else at the stroke's", () => {
        expect(chartPaintOf({ ...SKETCH, seriesStrokeWidth: 1.5 }).seriesStrokeWidth).toBe(1.5);
        expect(chartPaintOf(FLAT_CHART_LOOK).seriesStrokeWidth).toBe(FLAT_CHART_LOOK.strokeWidth);
    });
});
