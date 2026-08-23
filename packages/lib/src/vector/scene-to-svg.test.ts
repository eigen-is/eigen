import { describe, expect, test } from 'bun:test';
import { sceneToSvg } from './scene-to-svg';
import { DEFAULT_ELEMENT_PROPS, type VectorElement, type VectorScene } from './types';

const base = (over: Partial<VectorElement> & Pick<VectorElement, 'id' | 'type'>) => ({
    ...DEFAULT_ELEMENT_PROPS,
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    seed: 1,
    index: 'a0',
    ...over,
});

const shape = (over: Partial<VectorElement> & Pick<VectorElement, 'id' | 'type'>): VectorElement => {
    const el = { roundness: 'sharp' as const, ...base(over) };
    if (el.type === 'rectangle' || el.type === 'diamond' || el.type === 'ellipse') return el;
    throw new Error('shape() expects a shape type');
};

const scene = (elements: VectorElement[], background = 'transparent'): VectorScene => ({
    meta: { background, gridSize: 20 },
    elements,
});

// The golden scene: each shape type, both roundness variants, and a two-line text. Pins
// roughjs determinism (fixed seeds → byte-identical output run-to-run and across the pinned
// roughjs version). Regenerate with scripts/regen (see report) after any deliberate change.
export function buildGoldenScene(): VectorScene {
    return scene([
        shape({ id: 'r1', type: 'rectangle', roundness: 'sharp', x: 0, y: 0, seed: 1, index: 'a0' }),
        shape({ id: 'r2', type: 'rectangle', roundness: 'round', x: 120, y: 0, seed: 2, index: 'a1' }),
        shape({ id: 'd1', type: 'diamond', roundness: 'sharp', x: 0, y: 80, seed: 3, index: 'a2' }),
        shape({ id: 'd2', type: 'diamond', roundness: 'round', x: 120, y: 80, seed: 4, index: 'a3' }),
        shape({ id: 'e1', type: 'ellipse', roundness: 'sharp', x: 0, y: 160, seed: 5, index: 'a4' }),
        {
            ...DEFAULT_ELEMENT_PROPS,
            id: 't1',
            type: 'text',
            x: 0,
            y: 240,
            width: 120,
            height: 50,
            angle: 0,
            seed: 6,
            index: 'a5',
            text: 'Line one\nLine two',
            fontSize: 20,
            fontFamily: 'Excalifont',
            textAlign: 'left',
        },
    ]);
}

const GOLDEN_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="310" viewBox="-10 -10 240 310"><g transform="translate(0 0)" stroke-linecap="round"><path d="M0 0 C20.86 0.76 39.68 0.96 100 0 M0 0 C27.4 -0.39 54.17 0.83 100 0 M100 0 C101.79 14.28 100.65 27.06 100 60 M100 0 C99.73 23.29 98.63 45.58 100 60 M100 60 C65.24 58.31 27.07 59.81 0 60 M100 60 C76.15 58.34 51.08 59.23 0 60 M0 60 C0.31 41.54 0.84 18.9 0 0 M0 60 C-0.31 39.83 -0.14 18.58 0 0" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><g transform="translate(120 0)" stroke-linecap="round"><path d="M15 0 C28.72 0.34 44.36 0.74 85 0 M15 0 C38.47 -0.72 63.7 -0.28 85 0 M85 0 C94.41 -0.94 99.76 6.25 100 15 M85 0 C93.1 -1.18 99.63 6.16 100 15 M100 15 C101.1 20.55 100.22 29.56 100 45 M100 15 C99.94 26.74 99.44 37.56 100 45 M100 45 C99.19 53.8 93.97 58.56 85 60 M100 45 C98.92 52.83 94.57 59.32 85 60 M85 60 C68.91 62.26 52.67 62.3 15 60 M85 60 C69.38 61.1 53.1 59.81 15 60 M15 60 C3.23 61.43 1.65 54.06 0 45 M15 60 C6.36 62.26 2.02 52.89 0 45 M0 45 C0.42 35.23 0.39 21.53 0 15 M0 45 C0.04 34.69 0.48 23.49 0 15 M0 15 C-1.13 6.99 3.9 -0.62 15 0 M0 15 C1.06 3.16 4.73 2.24 15 0" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><g transform="translate(0 80)" stroke-linecap="round"><path d="M51 0 C59.22 4.79 69.49 11.59 100 31 M51 0 C61.99 5.94 71.3 12.29 100 31 M100 31 C86.15 40.04 71.77 48.9 51 60 M100 31 C84.58 41.06 67.31 49.85 51 60 M51 60 C36.46 52.91 19.88 45.15 0 31 M51 60 C35.01 49.86 17.62 41.16 0 31 M0 31 C13.18 26.32 22.1 16.86 51 0 M0 31 C13.97 24.13 25.45 15.76 51 0" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><g transform="translate(120 80)" stroke-linecap="round"><path d="M63.75 7.75 C69.83 12.75 73.82 12.65 87.25 23.25 M63.75 7.75 C70.23 12.21 77.3 17.54 87.25 23.25 M87.25 23.25 C100.81 31.12 101.52 31.51 87.25 38.75 M87.25 23.25 C98.49 30.95 101.56 31.03 87.25 38.75 M87.25 38.75 C80.94 41.38 72.84 44.94 63.75 52.25 M87.25 38.75 C78.06 43.27 70.64 49 63.75 52.25 M63.75 52.25 C51.38 59.61 50.94 59.12 38.25 52.25 M63.75 52.25 C51.14 57.95 52.44 60.94 38.25 52.25 M38.25 52.25 C29.76 50.09 22.97 46.63 12.75 38.75 M38.25 52.25 C31.79 48.9 24.94 44.77 12.75 38.75 M12.75 38.75 C-1.55 31.85 1.3 31.11 12.75 23.25 M12.75 38.75 C0.42 33.23 1.74 29.08 12.75 23.25 M12.75 23.25 C20.74 18.55 29.52 12.18 38.25 7.75 M12.75 23.25 C21.23 18.02 27.9 14.04 38.25 7.75 M38.25 7.75 C50.74 1.99 50.79 0.77 63.75 7.75 M38.25 7.75 C50.82 -1.38 52.75 2.19 63.75 7.75" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><g transform="translate(0 160)" stroke-linecap="round"><path d="M60.77 0.3 C69.43 0.95 78.7 5.59 85.04 9.57 C91.38 13.55 96.8 18.97 98.82 24.21 C100.84 29.44 100.36 36 97.17 40.98 C93.97 45.95 86.84 50.82 79.66 54.04 C72.48 57.27 63.1 60.08 54.1 60.33 C45.1 60.59 33.67 58.2 25.67 55.56 C17.67 52.92 10.42 49.21 6.11 44.5 C1.79 39.78 -0.78 32.72 -0.21 27.28 C0.36 21.84 4.03 16.24 9.54 11.87 C15.04 7.5 23.69 2.86 32.84 1.07 C41.99 -0.73 58.78 0.88 64.44 1.09 C70.1 1.3 67.04 1.9 66.79 2.32 M25.85 2.9 C33.34 0.2 46 -0.19 55.18 0.34 C64.36 0.86 73.96 2.91 80.91 6.04 C87.86 9.17 93.72 13.79 96.9 19.11 C100.09 24.43 102.22 32.41 100.02 37.98 C97.83 43.56 90.62 49.02 83.75 52.55 C76.88 56.08 67.47 58.1 58.8 59.14 C50.13 60.17 39.71 60.75 31.71 58.75 C23.71 56.75 15.87 51.53 10.79 47.13 C5.72 42.72 2.15 37.85 1.28 32.32 C0.41 26.8 1.41 18.95 5.59 13.96 C9.77 8.96 22.73 4.02 26.37 2.33 C30.02 0.64 26.79 3.16 27.46 3.83" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><g transform="translate(0 240)"><text x="0" y="17.62" font-family="&apos;Excalifont&apos;, cursive" font-size="20px" fill="#1e1e1e" text-anchor="start" style="white-space: pre;" dominant-baseline="alphabetic">Line one</text><text x="0" y="42.62" font-family="&apos;Excalifont&apos;, cursive" font-size="20px" fill="#1e1e1e" text-anchor="start" style="white-space: pre;" dominant-baseline="alphabetic">Line two</text></g></svg>';

describe('sceneToSvg', () => {
    test('golden snapshot — exact SVG string (roughjs determinism)', () => {
        expect(sceneToSvg(buildGoldenScene())).toBe(GOLDEN_SVG);
    });

    test('is deterministic run-to-run', () => {
        expect(sceneToSvg(buildGoldenScene())).toBe(sceneToSvg(buildGoldenScene()));
    });

    test('empty scene renders a zero-size svg', () => {
        expect(sceneToSvg(scene([]))).toBe(
            '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" viewBox="0 0 0 0"></svg>',
        );
    });

    test('XML-escapes user text and attribute values', () => {
        const svg = sceneToSvg(
            scene([
                {
                    ...DEFAULT_ELEMENT_PROPS,
                    id: 't',
                    type: 'text',
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 30,
                    angle: 0,
                    seed: 1,
                    index: 'a0',
                    text: `a<b>&"'z`,
                    fontSize: 20,
                    fontFamily: 'Excalifont',
                    textAlign: 'left',
                },
            ]),
        );
        expect(svg).toContain('a&lt;b&gt;&amp;&quot;&apos;z');
        expect(svg).not.toContain('<b>');
        expect(svg).not.toContain('&"');
    });

    test('XML-escapes hostile shape attribute values (stroke color)', () => {
        const svg = sceneToSvg(scene([shape({ id: 's', type: 'rectangle', strokeColor: '"><script>' })]));
        expect(svg).toContain('stroke="&quot;&gt;&lt;script&gt;"');
        expect(svg).not.toContain('"><script>');
        expect(svg).not.toContain('<script>');
    });

    test('renders a fill (fillSketch/fillPath) using the background color', () => {
        const svg = sceneToSvg(
            scene([shape({ id: 's', type: 'rectangle', backgroundColor: '#ff0000', fillStyle: 'hachure' })]),
        );
        expect(svg).toContain('stroke="#ff0000"');
    });

    test('emits stroke-dasharray for a dashed stroke', () => {
        const svg = sceneToSvg(scene([shape({ id: 's', type: 'rectangle', strokeStyle: 'dashed' })]));
        expect(svg).toContain('stroke-dasharray=');
    });

    test('emits a rotate() transform only when angle is non-zero', () => {
        expect(sceneToSvg(scene([shape({ id: 's', type: 'rectangle', angle: 30 })]))).toContain('rotate(30 ');
        expect(sceneToSvg(scene([shape({ id: 's', type: 'rectangle', angle: 0 })]))).not.toContain('rotate(');
    });

    test('emits opacity only when not 100', () => {
        expect(sceneToSvg(scene([shape({ id: 's', type: 'rectangle', opacity: 50 })]))).toContain('opacity="0.5"');
        expect(sceneToSvg(scene([shape({ id: 's', type: 'rectangle', opacity: 100 })]))).not.toContain('opacity=');
    });

    test('renders images through the media resolver, nothing when unresolvable', () => {
        const img: VectorElement = {
            ...DEFAULT_ELEMENT_PROPS,
            id: 'img',
            type: 'image',
            x: 0,
            y: 0,
            width: 40,
            height: 40,
            angle: 0,
            seed: 1,
            index: 'a0',
            mediaName: 'pic.png',
        };
        const resolved = sceneToSvg(scene([img]), { resolveMedia: () => 'data:image/png;base64,AAA' });
        expect(resolved).toContain('<image');
        expect(resolved).toContain('href="data:image/png;base64,AAA"');
        expect(sceneToSvg(scene([img]))).not.toContain('<image');
    });

    test('paints in fractional-index order regardless of input order', () => {
        const front = shape({ id: 'front', type: 'rectangle', index: 'a2' });
        const back = shape({ id: 'back', type: 'rectangle', index: 'a0' });
        // both share default styling, so compare paint order via a distinguishing stroke color
        const a = sceneToSvg(
            scene([
                { ...front, strokeColor: '#111111' },
                { ...back, strokeColor: '#222222' },
            ]),
        );
        expect(a.indexOf('#222222')).toBeLessThan(a.indexOf('#111111'));
    });
});
