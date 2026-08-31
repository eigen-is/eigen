import { describe, expect, test } from 'bun:test';
import { eigenMediaHref } from '../../vector/media-refs';
import { sceneToSvg } from '../../vector/scene-to-svg';
import { DEFAULT_ELEMENT_PROPS, type VectorElement, type VectorScene } from '../../vector/types';

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

// The golden scene: each shape type, both roundness variants, a two-line text, the three linear
// renders (a freedraw stroke, a sharp open line, a round closed-and-filled line), and three arrows — a
// plain one with an end head, a bound one with a triangle head and a clipped two-line label, and a bound
// elbow arrow whose orthogonal route is derived at render time (its `<g transform="translate(40 60)">`). Pins
// roughjs + perfect-freehand determinism (fixed seeds → byte-identical output run-to-run and across the
// pinned versions). After a deliberate renderer change, regenerate GOLDEN_SVG by pasting the output of
// `sceneToSvg(buildGoldenScene())`.
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
        {
            ...DEFAULT_ELEMENT_PROPS,
            id: 'fd1',
            type: 'freedraw',
            x: 0,
            y: 320,
            width: 60,
            height: 20,
            angle: 0,
            seed: 7,
            index: 'a6',
            roundness: 'sharp',
            points: '[[0,0],[15,10],[30,4],[45,18],[60,8]]',
        },
        {
            ...DEFAULT_ELEMENT_PROPS,
            id: 'ln1',
            type: 'line',
            x: 120,
            y: 320,
            width: 100,
            height: 40,
            angle: 0,
            seed: 8,
            index: 'a7',
            roundness: 'sharp',
            points: '[[0,0],[100,0],[100,40]]',
        },
        {
            ...DEFAULT_ELEMENT_PROPS,
            id: 'ln2',
            type: 'line',
            x: 0,
            y: 400,
            width: 80,
            height: 60,
            angle: 0,
            seed: 9,
            index: 'a8',
            roundness: 'round',
            backgroundColor: '#ffd43b',
            fillStyle: 'solid',
            points: '[[0,0],[80,0],[40,60],[0,0]]',
        },
        // A plain arrow — default head on the end only, unbound, no label.
        {
            ...DEFAULT_ELEMENT_PROPS,
            id: 'ar1',
            type: 'arrow',
            x: 120,
            y: 400,
            width: 100,
            height: 40,
            angle: 0,
            seed: 10,
            index: 'a9',
            roundness: 'sharp',
            points: '[[0,0],[100,40]]',
            startArrowhead: 'none',
            endArrowhead: 'arrow',
            startBinding: '',
            endBinding: '',
            elbow: false,
            text: '',
            fontSize: 20,
            fontFamily: 'Excalifont',
            labelWidth: 0,
        },
        // A bound arrow (both ends → present shapes) with a triangle head and a two-line label; the
        // shaft is clipped under the label. Bindings don't affect rendering (follow is a separate step).
        {
            ...DEFAULT_ELEMENT_PROPS,
            id: 'ar2',
            type: 'arrow',
            x: 0,
            y: 500,
            width: 120,
            height: 0,
            angle: 0,
            seed: 11,
            index: 'aA',
            roundness: 'sharp',
            points: '[[0,0],[120,0]]',
            startArrowhead: 'none',
            endArrowhead: 'triangle',
            startBinding: '{"elementId":"r1","fixedPoint":[1,0.5]}',
            endBinding: '{"elementId":"e1","fixedPoint":[0,0.5]}',
            elbow: false,
            text: 'Two\nLines',
            fontSize: 20,
            fontFamily: 'Excalifont',
            labelWidth: 60,
        },
        // A bound elbow arrow between two rects (r1 top-left, r3 below-right): its route is DERIVED — an
        // orthogonal snake around the shapes — so it exercises the elbow render path in the golden.
        {
            ...DEFAULT_ELEMENT_PROPS,
            id: 'ar3',
            type: 'arrow',
            x: 40,
            y: 60,
            width: 200,
            height: 160,
            angle: 0,
            seed: 12,
            index: 'aB',
            roundness: 'sharp',
            points: '[[0,0],[200,160]]',
            startArrowhead: 'none',
            endArrowhead: 'arrow',
            startBinding: '{"elementId":"r1","fixedPoint":[0.5,1]}',
            endBinding: '{"elementId":"r3","fixedPoint":[0,0.5]}',
            elbow: true,
            text: '',
            fontSize: 20,
            fontFamily: 'Excalifont',
            labelWidth: 0,
        },
        shape({ id: 'r3', type: 'rectangle', roundness: 'sharp', x: 240, y: 200, seed: 13, index: 'aC' }),
    ]);
}

const GOLDEN_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="545" viewBox="-10 -10 360 545"><g transform="translate(0 0)" stroke-linecap="round"><path d="M0 0 C20.86 0.76 39.68 0.96 100 0 M0 0 C27.4 -0.39 54.17 0.83 100 0 M100 0 C101.79 14.28 100.65 27.06 100 60 M100 0 C99.73 23.29 98.63 45.58 100 60 M100 60 C65.24 58.31 27.07 59.81 0 60 M100 60 C76.15 58.34 51.08 59.23 0 60 M0 60 C0.31 41.54 0.84 18.9 0 0 M0 60 C-0.31 39.83 -0.14 18.58 0 0" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><g transform="translate(120 0)" stroke-linecap="round"><path d="M15 0 C28.72 0.34 44.36 0.74 85 0 M15 0 C38.47 -0.72 63.7 -0.28 85 0 M85 0 C94.41 -0.94 99.76 6.25 100 15 M85 0 C93.1 -1.18 99.63 6.16 100 15 M100 15 C101.1 20.55 100.22 29.56 100 45 M100 15 C99.94 26.74 99.44 37.56 100 45 M100 45 C99.19 53.8 93.97 58.56 85 60 M100 45 C98.92 52.83 94.57 59.32 85 60 M85 60 C68.91 62.26 52.67 62.3 15 60 M85 60 C69.38 61.1 53.1 59.81 15 60 M15 60 C3.23 61.43 1.65 54.06 0 45 M15 60 C6.36 62.26 2.02 52.89 0 45 M0 45 C0.42 35.23 0.39 21.53 0 15 M0 45 C0.04 34.69 0.48 23.49 0 15 M0 15 C-1.13 6.99 3.9 -0.62 15 0 M0 15 C1.06 3.16 4.73 2.24 15 0" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><g transform="translate(0 80)" stroke-linecap="round"><path d="M51 0 C59.22 4.79 69.49 11.59 100 31 M51 0 C61.99 5.94 71.3 12.29 100 31 M100 31 C86.15 40.04 71.77 48.9 51 60 M100 31 C84.58 41.06 67.31 49.85 51 60 M51 60 C36.46 52.91 19.88 45.15 0 31 M51 60 C35.01 49.86 17.62 41.16 0 31 M0 31 C13.18 26.32 22.1 16.86 51 0 M0 31 C13.97 24.13 25.45 15.76 51 0" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><g transform="translate(120 80)" stroke-linecap="round"><path d="M63.75 7.75 C69.83 12.75 73.82 12.65 87.25 23.25 M63.75 7.75 C70.23 12.21 77.3 17.54 87.25 23.25 M87.25 23.25 C100.81 31.12 101.52 31.51 87.25 38.75 M87.25 23.25 C98.49 30.95 101.56 31.03 87.25 38.75 M87.25 38.75 C80.94 41.38 72.84 44.94 63.75 52.25 M87.25 38.75 C78.06 43.27 70.64 49 63.75 52.25 M63.75 52.25 C51.38 59.61 50.94 59.12 38.25 52.25 M63.75 52.25 C51.14 57.95 52.44 60.94 38.25 52.25 M38.25 52.25 C29.76 50.09 22.97 46.63 12.75 38.75 M38.25 52.25 C31.79 48.9 24.94 44.77 12.75 38.75 M12.75 38.75 C-1.55 31.85 1.3 31.11 12.75 23.25 M12.75 38.75 C0.42 33.23 1.74 29.08 12.75 23.25 M12.75 23.25 C20.74 18.55 29.52 12.18 38.25 7.75 M12.75 23.25 C21.23 18.02 27.9 14.04 38.25 7.75 M38.25 7.75 C50.74 1.99 50.79 0.77 63.75 7.75 M38.25 7.75 C50.82 -1.38 52.75 2.19 63.75 7.75" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><g transform="translate(0 160)" stroke-linecap="round"><path d="M60.77 0.3 C69.43 0.95 78.7 5.59 85.04 9.57 C91.38 13.55 96.8 18.97 98.82 24.21 C100.84 29.44 100.36 36 97.17 40.98 C93.97 45.95 86.84 50.82 79.66 54.04 C72.48 57.27 63.1 60.08 54.1 60.33 C45.1 60.59 33.67 58.2 25.67 55.56 C17.67 52.92 10.42 49.21 6.11 44.5 C1.79 39.78 -0.78 32.72 -0.21 27.28 C0.36 21.84 4.03 16.24 9.54 11.87 C15.04 7.5 23.69 2.86 32.84 1.07 C41.99 -0.73 58.78 0.88 64.44 1.09 C70.1 1.3 67.04 1.9 66.79 2.32 M25.85 2.9 C33.34 0.2 46 -0.19 55.18 0.34 C64.36 0.86 73.96 2.91 80.91 6.04 C87.86 9.17 93.72 13.79 96.9 19.11 C100.09 24.43 102.22 32.41 100.02 37.98 C97.83 43.56 90.62 49.02 83.75 52.55 C76.88 56.08 67.47 58.1 58.8 59.14 C50.13 60.17 39.71 60.75 31.71 58.75 C23.71 56.75 15.87 51.53 10.79 47.13 C5.72 42.72 2.15 37.85 1.28 32.32 C0.41 26.8 1.41 18.95 5.59 13.96 C9.77 8.96 22.73 4.02 26.37 2.33 C30.02 0.64 26.79 3.16 27.46 3.83" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><g transform="translate(0 240)"><text x="0" y="17.62" font-family="&apos;Excalifont&apos;, cursive" font-size="20px" fill="#1e1e1e" text-anchor="start" style="white-space: pre;">Line one</text><text x="0" y="42.62" font-family="&apos;Excalifont&apos;, cursive" font-size="20px" fill="#1e1e1e" text-anchor="start" style="white-space: pre;">Line two</text></g><g transform="translate(0 320)"><path d="M 1.01 -1.52 Q 1.01 -1.52 5.17 1.38 9.33 4.28 15.13 3.74 20.93 3.19 28.11 7.1 35.28 11 47.51 8.78 59.75 6.56 59.99 6.56 60.22 6.56 60.45 6.63 60.67 6.71 60.86 6.85 61.05 6.99 61.18 7.18 61.32 7.38 61.38 7.6 61.45 7.83 61.44 8.07 61.43 8.3 61.34 8.52 61.26 8.74 61.1 8.92 60.95 9.1 60.75 9.23 60.55 9.35 60.32 9.4 60.09 9.46 59.86 9.43 59.62 9.41 59.41 9.31 59.19 9.21 59.02 9.05 58.85 8.89 58.73 8.68 58.62 8.48 58.58 8.25 58.54 8.01 58.58 7.78 58.61 7.55 58.72 7.34 58.83 7.13 59 6.96 59.17 6.8 59.38 6.7 59.6 6.6 59.83 6.57 60.07 6.54 60.3 6.59 60.53 6.64 60.73 6.76 60.93 6.88 61.09 7.06 61.24 7.24 61.33 7.46 61.42 7.67 61.44 7.91 61.45 8.15 61.39 8.37 61.33 8.6 61.2 8.8 61.07 8.99 60.88 9.14 60.69 9.28 60.47 9.36 60.25 9.44 60.25 9.44 60.25 9.44 47.25 11.58 34.25 13.73 27.57 10.01 20.9 6.29 14.41 6.75 7.92 7.22 3.45 4.37 -1.01 1.52 -1.18 1.38 -1.35 1.23 -1.48 1.05 -1.6 0.88 -1.69 0.67 -1.77 0.47 -1.8 0.25 -1.83 0.03 -1.8 -0.19 -1.78 -0.41 -1.71 -0.62 -1.63 -0.82 -1.51 -1.01 -1.39 -1.19 -1.22 -1.34 -1.06 -1.49 -0.87 -1.59 -0.68 -1.7 -0.46 -1.75 -0.25 -1.81 -0.03 -1.81 0.19 -1.82 0.41 -1.77 0.62 -1.72 0.82 -1.62 1.01 -1.52 1.01 -1.52 L 1.01 -1.52 Z" fill="#1e1e1e" stroke="none"/></g><g transform="translate(120 320)" stroke-linecap="round"><path d="M0 0 C20.86 1.09 39.45 -1.32 100 0 M0 0 C38.16 0.88 74.36 0.63 100 0 M100 0 C98.67 10.62 101.55 23.2 100 40 M100 0 C100.98 7.24 100.16 15.58 100 40" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><g transform="translate(0 400)" stroke-linecap="round"><path d="M0.4 0.93 C13.73 0.7 72.97 -11.58 79.89 -1.66 C86.81 8.27 54.9 59.89 41.9 60.48 C28.91 61.07 8.65 12.04 1.9 1.9" fill="#ffd43b" stroke="none"/><path d="M-0.21 -0.17 C13.39 -0.16 73.86 -9.25 80.4 0.67 C86.95 10.6 52.44 59.4 39.08 59.38 C25.72 59.35 6.82 10.23 0.26 0.51 M-1.78 -1.31 C11.8 -1.7 72.46 -11.37 79.67 -1.1 C86.88 9.18 54.66 60.48 41.49 60.36 C28.32 60.25 7.26 8.55 0.64 -1.77" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><g transform="translate(120 400)" stroke-linecap="round"><path d="M0 0 C18.86 8.61 39.09 18.61 100 40 M0 0 C33.1 12.9 64.84 25.88 100 40" stroke="#1e1e1e" stroke-width="2" fill="none"/><path d="M75.01 39.21 C78.59 39.25 83.82 41.4 100 40 M75.01 39.21 C83.97 38.84 91.72 39.28 100 40" stroke="#1e1e1e" stroke-width="2" fill="none"/><path d="M100 40 C94.73 36.12 91.23 34.78 81.36 23.34 M100 40 C94.94 33.62 88.73 28.47 81.36 23.34" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><g transform="translate(0 500)" stroke-linecap="round"><clipPath id="arrow-label-clip-ar2"><path clip-rule="evenodd" d="M-52 -82 h224 v164 h-224 Z M25 -30 h70 v60 h-70 Z"/></clipPath><g clip-path="url(#arrow-label-clip-ar2)"><path d="M0 0 C25.44 -1.67 48.49 0.52 120 0 M0 0 C47.19 -0.21 93.55 1.19 120 0" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><path d="M107.36 6.09 L121.45 1.74 L108.17 -6.76" fill="#1e1e1e" stroke="none"/><path d="M106.41 6.34 C110.14 3.99 112.15 4.37 120 0 M106.41 6.34 C111.82 3.42 116.65 1.98 120 0 M120 0 C116.11 -0.91 110.46 -5.36 106.41 -6.34 M120 0 C115.86 -1.62 111.3 -4 106.41 -6.34 M106.41 -6.34 C105.94 -2.55 107.05 2.53 106.41 6.34 M106.41 -6.34 C106.73 -2.83 106.26 0.19 106.41 6.34" stroke="#1e1e1e" stroke-width="2" fill="none"/><text x="60" y="-7.38" font-family="&apos;Excalifont&apos;, cursive" font-size="20px" fill="#1e1e1e" text-anchor="middle" style="white-space: pre;">Two</text><text x="60" y="17.62" font-family="&apos;Excalifont&apos;, cursive" font-size="20px" fill="#1e1e1e" text-anchor="middle" style="white-space: pre;">Lines</text></g><g transform="translate(40 60)" stroke-linecap="round"><path d="M0 0 C-1.25 33.58 -3.37 63.98 0 160 M0 0 C0.34 41.79 1.25 84.64 0 160 M0 160 C45.7 159.57 88.51 159.57 200 160 M0 160 C60.44 161.17 121.8 160.61 200 160" stroke="#1e1e1e" stroke-width="2" fill="none"/><path d="M176.51 168.55 C181.58 168.54 184.15 165.22 200 160 M176.51 168.55 C182.01 165.8 189.12 164.16 200 160" stroke="#1e1e1e" stroke-width="2" fill="none"/><path d="M200 160 C195.67 159.72 188.85 156.4 176.51 151.45 M200 160 C193.1 157.36 187.81 155.72 176.51 151.45" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><g transform="translate(240 200)" stroke-linecap="round"><path d="M0 0 C19.15 -0.1 39.85 -1.51 100 0 M0 0 C34.14 -1.07 66.22 -1.23 100 0 M100 0 C100.82 13.65 98.01 31.72 100 60 M100 0 C100.53 16.71 100.19 32.58 100 60 M100 60 C68.11 60.03 39.85 59.52 0 60 M100 60 C65.96 60.43 34.09 59.96 0 60 M0 60 C-1.56 47.98 1.34 33.75 0 0 M0 60 C-1.23 37.75 -1.07 15.5 0 0" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></svg>';

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

    test('an eigen-media ref href survives escapeXml unchanged (R1)', () => {
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
            mediaName: "Bob's photo.png",
        };
        const href = eigenMediaHref(img.mediaName);
        const out = sceneToSvg(scene([img]), { resolveMedia: (name) => eigenMediaHref(name) });
        // The stored token equals eigenMediaHref exactly — escapeXml is a no-op on it, so the copy
        // path's rewrite/strip (media-refs) find it by exact-token match.
        expect(out).toContain(`href="${href}"`);
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
