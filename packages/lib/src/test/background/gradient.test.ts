import { describe, expect, test } from 'bun:test';
import { cssGradientStops, gradientStops, svgGradientStops } from '../../background/gradient';

describe('gradientStops', () => {
    test('opaque ends keep their colours at full opacity', () => {
        expect(gradientStops('#e60076', '#0000ff')).toEqual([
            { offset: 0, color: '#e60076', opacity: 1 },
            { offset: 1, color: '#0000ff', opacity: 1 },
        ]);
    });

    test('a transparent end borrows the other end colour at opacity 0', () => {
        expect(gradientStops('#e60076', 'transparent')).toEqual([
            { offset: 0, color: '#e60076', opacity: 1 },
            { offset: 1, color: '#e60076', opacity: 0 },
        ]);
        expect(gradientStops('transparent', '#e60076')).toEqual([
            { offset: 0, color: '#e60076', opacity: 0 },
            { offset: 1, color: '#e60076', opacity: 1 },
        ]);
    });

    test('alpha in an #rrggbbaa colour moves into the opacity channel', () => {
        expect(gradientStops('#e6007680', '#fff')).toEqual([
            { offset: 0, color: '#e60076', opacity: 0.502 },
            { offset: 1, color: '#ffffff', opacity: 1 },
        ]);
    });

    test('transparent at both ends paints nothing', () => {
        expect(gradientStops('transparent', 'transparent')).toEqual([
            { offset: 0, color: '#000000', opacity: 0 },
            { offset: 1, color: '#000000', opacity: 0 },
        ]);
    });
});

describe('emitters', () => {
    test('CSS never emits a black stop for a colour → transparent gradient', () => {
        const css = cssGradientStops('#e60076', 'transparent');
        expect(css).toBe('#e60076 0%, #e6007600 100%');
        expect(css).not.toContain('transparent');
        expect(css).not.toContain('#000000');
    });

    test('SVG never emits a black stop for a colour → transparent gradient', () => {
        const svg = svgGradientStops('#e60076', 'transparent');
        expect(svg).toBe(
            '<stop offset="0" stop-color="#e60076"/><stop offset="1" stop-color="#e60076" stop-opacity="0"/>',
        );
        expect(svg).not.toContain('transparent');
        expect(svg).not.toContain('#000000');
    });

    test('the CSS and SVG emitters carry the same stop colours', () => {
        const stops = gradientStops('#e60076', 'transparent');
        const css = cssGradientStops('#e60076', 'transparent');
        const svg = svgGradientStops('#e60076', 'transparent');
        for (const stop of stops) {
            expect(css).toContain(stop.color);
            expect(svg).toContain(stop.color);
        }
    });
});
