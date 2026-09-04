import { describe, expect, test } from 'bun:test';
import { cssGradientStops, GRADIENT_STOP_COUNT, gradientStops, svgGradientStops } from '../../background/gradient';

describe('gradientStops', () => {
    test('samples the ramp at one fixed count, monotone in offset', () => {
        const stops = gradientStops('#ff0000', '#0000ff');
        expect(stops).toHaveLength(GRADIENT_STOP_COUNT);
        for (let i = 1; i < stops.length; i++) expect(stops[i].offset).toBeGreaterThan(stops[i - 1].offset);
        expect(stops[0].offset).toBe(0);
        expect(stops.at(-1)?.offset).toBe(1);
    });

    test('the endpoints are the stored colours, exactly', () => {
        const stops = gradientStops('#e60076', '#0000ff');
        expect(stops[0]).toEqual({ offset: 0, color: '#e60076', opacity: 1 });
        expect(stops.at(-1)).toEqual({ offset: 1, color: '#0000ff', opacity: 1 });
    });

    // The whole point: sRGB would put the middle of red → blue at #800080, a dull half-lit purple.
    // OKLab holds the lightness up across the ramp.
    test('the midpoint is the OKLab mix, not the sRGB average', () => {
        expect(gradientStops('#ff0000', '#0000ff')[4]).toEqual({ offset: 0.5, color: '#8c53a2', opacity: 1 });
        expect(gradientStops('#ff0000', '#0000ff')[4].color).not.toBe('#800080');
    });

    test('grey → grey stays grey at every stop', () => {
        for (const stop of gradientStops('#333333', '#cccccc')) {
            expect(stop.color).toMatch(/^#([0-9a-f]{2})\1\1$/);
        }
    });

    test('a transparent end borrows the other end colour and only the opacity ramps', () => {
        const stops = gradientStops('#e60076', 'transparent');
        for (const stop of stops) expect(stop.color).toBe('#e60076');
        expect(stops[0].opacity).toBe(1);
        expect(stops.at(-1)?.opacity).toBe(0);
        for (let i = 1; i < stops.length; i++) expect(stops[i].opacity).toBeLessThan(stops[i - 1].opacity);
    });

    test('transparent → colour ramps the other way', () => {
        const stops = gradientStops('transparent', '#e60076');
        for (const stop of stops) expect(stop.color).toBe('#e60076');
        expect(stops[0].opacity).toBe(0);
        expect(stops.at(-1)?.opacity).toBe(1);
    });

    test('alpha in an #rrggbbaa colour moves into the opacity channel', () => {
        const stops = gradientStops('#e6007680', '#ffffff');
        expect(stops[0]).toEqual({ offset: 0, color: '#e60076', opacity: 0.502 });
        expect(stops.at(-1)).toEqual({ offset: 1, color: '#ffffff', opacity: 1 });
    });

    test('an alpha-0 hex reads as the transparent sentinel does', () => {
        const stops = gradientStops('#e60076', '#00000000');
        for (const stop of stops) expect(stop.color).toBe('#e60076');
        expect(stops.at(-1)?.opacity).toBe(0);
    });

    test('transparent at both ends paints nothing', () => {
        for (const stop of gradientStops('transparent', 'transparent')) {
            expect(stop).toEqual({ offset: stop.offset, color: '#000000', opacity: 0 });
        }
    });

    test('a two-stop sample is still exact at the ends', () => {
        expect(gradientStops('#ff0000', '#0000ff', 2)).toEqual([
            { offset: 0, color: '#ff0000', opacity: 1 },
            { offset: 1, color: '#0000ff', opacity: 1 },
        ]);
    });
});

describe('emitters', () => {
    test('CSS and SVG carry the same stop colours, so canvas and PDF agree', () => {
        for (const [from, to] of [
            ['#ff0000', '#0000ff'],
            ['#e60076', 'transparent'],
        ]) {
            const css = cssGradientStops(from, to);
            const svg = svgGradientStops(from, to);
            for (const stop of gradientStops(from, to)) {
                expect(css).toContain(stop.color);
                expect(svg).toContain(stop.color);
            }
        }
    });

    test('CSS never emits a black stop for a colour → transparent gradient', () => {
        const css = cssGradientStops('#e60076', 'transparent');
        expect(css.startsWith('#e60076 0%')).toBe(true);
        expect(css.endsWith('#e6007600 100%')).toBe(true);
        expect(css).not.toContain('transparent');
        expect(css).not.toContain('#000000');
    });

    test('SVG never emits a black stop for a colour → transparent gradient', () => {
        const svg = svgGradientStops('#e60076', 'transparent');
        expect(svg).toContain('<stop offset="0" stop-color="#e60076"/>');
        expect(svg).toContain('<stop offset="1" stop-color="#e60076" stop-opacity="0"/>');
        expect(svg).not.toContain('transparent');
        expect(svg).not.toContain('#000000');
    });
});
