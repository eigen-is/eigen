import { describe, expect, test } from 'bun:test';
import { solidFill } from '../../vector/fill';
import { eigenMediaHref } from '../../vector/media-refs';
import { elementToSvg, sceneToSvg } from '../../vector/scene-to-svg';
import {
    DEFAULT_ELEMENT_PROPS,
    type VectorElement,
    type VectorImageElement,
    type VectorLinearElement,
    type VectorRectangleElement,
    type VectorScene,
} from '../../vector/types';
import { scene, shape } from './element-factories';

// Freedraw/line/arrow rows carry the paint + roughjs fields the shared defaults no longer hold.
const LINEAR_PAINT = { fill: solidFill('transparent'), fillStyle: 'solid', roughness: 1 } as const;

// The golden is pinned on the flat style (sharp corners, no hachure) so a change to the vector app's
// style table can never rewrite it; everything else comes from the shared fixtures. Spread-only so the
// ellipse case doesn't trip the excess-property check on `corners`.
const GOLDEN_STYLE: Pick<VectorRectangleElement, 'corners' | 'fillStyle'> = { corners: 'straight', fillStyle: 'solid' };

const goldenShape = (over: Partial<VectorElement> & Pick<VectorElement, 'id' | 'type'>): VectorElement =>
    shape({ ...GOLDEN_STYLE, ...over });

// The golden scene: each shape type, straight and curved corners, a rich-text box, the linear renders (a
// freedraw stroke, a sharp open line, a round closed-and-filled line), and the arrows — a plain one with
// an end head, a bound one with a triangle head and a clipped two-line label, a bound sharp elbow arrow
// whose orthogonal route is derived at render time (its `<g transform="translate(40 60)">`), and a bound
// round elbow on the same route whose bends render as quadratic corner arcs. The r=2 trio at the bottom
// (a line, a barb-head arrow, a circle-head arrow) pins the cartoon-roughness drift: linear shafts keep
// preserveVertices at every roughness (endpoints exactly on the stored points) and heads cap roughness
// (barbs ≤ 1, circle ≤ 0.5). Pins roughjs + perfect-freehand determinism (fixed seeds → byte-identical
// output run-to-run and across the pinned versions). After a deliberate renderer change, regenerate
// GOLDEN_SVG by pasting the output of `sceneToSvg(buildGoldenScene())`.
export function buildGoldenScene(): VectorScene {
    return scene([
        goldenShape({ id: 'r1', type: 'rectangle', corners: 'straight', x: 0, y: 0, seed: 1, index: 'a0' }),
        goldenShape({ id: 'r2', type: 'rectangle', corners: 'curved', x: 120, y: 0, seed: 2, index: 'a1' }),
        goldenShape({ id: 'd1', type: 'diamond', corners: 'straight', x: 0, y: 80, seed: 3, index: 'a2' }),
        goldenShape({ id: 'd2', type: 'diamond', corners: 'curved', x: 120, y: 80, seed: 4, index: 'a3' }),
        goldenShape({ id: 'e1', type: 'ellipse', x: 0, y: 160, seed: 5, index: 'a4' }),
        {
            ...DEFAULT_ELEMENT_PROPS,
            id: 't1',
            type: 'richtext',
            x: 0,
            y: 240,
            width: 120,
            height: 50,
            angle: 0,
            index: 'a5',
            fill: solidFill('transparent'),
            fillStyle: 'solid',
            corners: 'straight',
            html: '<p>Line one</p><p>Line two</p>',
            fontFamily: 'Excalifont',
            fontSize: 20,
            fontWeight: 'normal',
            fontStyle: 'normal',
            textDecoration: 'none',
            textAlign: 'left',
            verticalAlign: 'top',
            color: '#1e1e1e',
            letterSpacing: 0,
            lineHeight: 1.2,
            highlightColor: 'transparent',
            padding: 0,
        },
        {
            ...DEFAULT_ELEMENT_PROPS,
            ...LINEAR_PAINT,
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
            pressures: '',
            simulatePressure: true,
        },
        {
            ...DEFAULT_ELEMENT_PROPS,
            ...LINEAR_PAINT,
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
            pressures: '',
            simulatePressure: true,
        },
        {
            ...DEFAULT_ELEMENT_PROPS,
            ...LINEAR_PAINT,
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
            fill: solidFill('#ffd43b'),
            points: '[[0,0],[80,0],[40,60],[0,0]]',
            pressures: '',
            simulatePressure: true,
        },
        // A plain arrow — default head on the end only, unbound, no label.
        {
            ...DEFAULT_ELEMENT_PROPS,
            roughness: 1,
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
            fixedSegments: '',
            text: '',
            fontSize: 20,
            fontFamily: 'Excalifont',
            labelWidth: 0,
        },
        // A bound arrow (both ends → present shapes) with a triangle head and a two-line label; the
        // shaft is clipped under the label. Bindings don't affect rendering (follow is a separate step).
        {
            ...DEFAULT_ELEMENT_PROPS,
            roughness: 1,
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
            fixedSegments: '',
            text: 'Two\nLines',
            fontSize: 20,
            fontFamily: 'Excalifont',
            labelWidth: 60,
        },
        // A bound elbow arrow between two rects (r1 top-left, r3 below-right): its route is DERIVED — an
        // orthogonal snake around the shapes — so it exercises the elbow render path in the golden.
        {
            ...DEFAULT_ELEMENT_PROPS,
            roughness: 1,
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
            fixedSegments: '',
            text: '',
            fontSize: 20,
            fontFamily: 'Excalifont',
            labelWidth: 0,
        },
        goldenShape({ id: 'r3', type: 'rectangle', corners: 'straight', x: 240, y: 200, seed: 13, index: 'aC' }),
        // Same bound route as ar3 but `roundness: 'round'` — its bends render as quadratic corner arcs
        // (Excalidraw's generateElbowArrowShape) instead of the sharp linearPath, exercising the rounded
        // elbow branch. Endpoints and the final segment's direction (thus the head) stay identical to ar3.
        {
            ...DEFAULT_ELEMENT_PROPS,
            roughness: 1,
            id: 'ar4',
            type: 'arrow',
            x: 40,
            y: 60,
            width: 200,
            height: 160,
            angle: 0,
            seed: 14,
            index: 'aD',
            roundness: 'round',
            points: '[[0,0],[200,160]]',
            startArrowhead: 'none',
            endArrowhead: 'arrow',
            startBinding: '{"elementId":"r1","fixedPoint":[0.5,1]}',
            endBinding: '{"elementId":"r3","fixedPoint":[0,0.5]}',
            elbow: true,
            fixedSegments: '',
            text: '',
            fontSize: 20,
            fontFamily: 'Excalifont',
            labelWidth: 0,
        },
        // Cartoon-roughness (r=2) coverage: a sharp line whose SHAFT preserves its vertices at every
        // roughness now (the deliberate drift), so its endpoints land exactly on the stored points.
        {
            ...DEFAULT_ELEMENT_PROPS,
            ...LINEAR_PAINT,
            id: 'ln3',
            type: 'line',
            x: 0,
            y: 580,
            width: 100,
            height: 40,
            angle: 0,
            seed: 15,
            index: 'aE',
            roughness: 2,
            roundness: 'sharp',
            points: '[[0,0],[100,0],[100,40]]',
            pressures: '',
            simulatePressure: true,
        },
        // An r=2 arrow with an 'arrow' barb head: the shaft's endpoints pin, and the head roughness caps at
        // 1 (getArrowheadLineOptions) so the barb docks cleanly on the pinned end.
        {
            ...DEFAULT_ELEMENT_PROPS,
            id: 'ar5',
            type: 'arrow',
            x: 120,
            y: 580,
            width: 100,
            height: 40,
            angle: 0,
            seed: 16,
            index: 'aF',
            roughness: 2,
            roundness: 'sharp',
            points: '[[0,0],[100,40]]',
            startArrowhead: 'none',
            endArrowhead: 'arrow',
            startBinding: '',
            endBinding: '',
            elbow: false,
            fixedSegments: '',
            text: '',
            fontSize: 20,
            fontFamily: 'Excalifont',
            labelWidth: 0,
        },
        // An r=2 arrow with a 'circle' head: exercises the tighter circle cap (roughness ≤ 0.5).
        {
            ...DEFAULT_ELEMENT_PROPS,
            id: 'ar6',
            type: 'arrow',
            x: 0,
            y: 680,
            width: 100,
            height: 0,
            angle: 0,
            seed: 17,
            index: 'aG',
            roughness: 2,
            roundness: 'sharp',
            points: '[[0,0],[100,0]]',
            startArrowhead: 'none',
            endArrowhead: 'circle',
            startBinding: '',
            endBinding: '',
            elbow: false,
            fixedSegments: '',
            text: '',
            fontSize: 20,
            fontFamily: 'Excalifont',
            labelWidth: 0,
        },
        // A PINNED elbow arrow: stored-polyline mode — `points` holds the full 4-point L and
        // `fixedSegments` pins its middle (vertical) segment at index 2. arrowRoute returns the polyline
        // VERBATIM (no router). Placed inside the existing bounds so it only APPENDS a fragment — every
        // fragment above stays byte-identical.
        {
            ...DEFAULT_ELEMENT_PROPS,
            roughness: 1,
            id: 'ar7',
            type: 'arrow',
            x: 250,
            y: 460,
            width: 80,
            height: 60,
            angle: 0,
            seed: 20,
            index: 'aH',
            roundness: 'sharp',
            points: '[[0,0],[40,0],[40,60],[80,60]]',
            startArrowhead: 'none',
            endArrowhead: 'arrow',
            startBinding: '',
            endBinding: '',
            elbow: true,
            fixedSegments:
                '{"segments":[{"index":2,"start":[40,0],"end":[40,60]}],"startIsSpecial":false,"endIsSpecial":false}',
            text: '',
            fontSize: 20,
            fontFamily: 'Excalifont',
            labelWidth: 0,
        },
        // The two gradient paints, in free space inside the existing bounds so every fragment above stays
        // byte-identical: a solid-styled one (the gradient rides `fill=` on the fillPath) and a hachure one
        // (it rides `stroke=` on the fillSketch strokes).
        goldenShape({
            id: 'gr1',
            type: 'rectangle',
            x: 230,
            y: 0,
            seed: 21,
            index: 'aI',
            fill: '{"type":"gradient","from":"#ff0000","to":"#0000ff","angle":45}',
            fillStyle: 'solid',
        }),
        goldenShape({
            id: 'gr2',
            type: 'ellipse',
            x: 230,
            y: 80,
            seed: 22,
            index: 'aJ',
            fill: '{"type":"gradient","from":"#ffd43b","to":"#1e1e1e","angle":180}',
            fillStyle: 'hachure',
        }),
    ]);
}

const GOLDEN_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="700" viewBox="-10 -10 360 700"><g transform="translate(0 0)"><g stroke-linecap="round"><path d="M0 0 C20.86 0.76 39.68 0.96 100 0 M0 0 C27.4 -0.39 54.17 0.83 100 0 M100 0 C101.79 14.28 100.65 27.06 100 60 M100 0 C99.73 23.29 98.63 45.58 100 60 M100 60 C65.24 58.31 27.07 59.81 0 60 M100 60 C76.15 58.34 51.08 59.23 0 60 M0 60 C0.31 41.54 0.84 18.9 0 0 M0 60 C-0.31 39.83 -0.14 18.58 0 0" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g><g transform="translate(120 0)"><g stroke-linecap="round"><path d="M15 0 C28.72 0.34 44.36 0.74 85 0 M15 0 C38.47 -0.72 63.7 -0.28 85 0 M85 0 C92.69 -0.94 99.76 7.97 100 15 M85 0 C91.38 -1.18 99.63 7.88 100 15 M100 15 C101.1 20.55 100.22 29.56 100 45 M100 15 C99.94 26.74 99.44 37.56 100 45 M100 45 C99.19 52.09 92.25 58.56 85 60 M100 45 C98.92 51.11 92.86 59.32 85 60 M85 60 C68.91 62.26 52.67 62.3 15 60 M85 60 C69.38 61.1 53.1 59.81 15 60 M15 60 C4.94 61.43 1.65 52.34 0 45 M15 60 C8.08 62.26 2.02 51.18 0 45 M0 45 C0.42 35.23 0.39 21.53 0 15 M0 45 C0.04 34.69 0.48 23.49 0 15 M0 15 C-1.13 8.71 5.61 -0.62 15 0 M0 15 C1.06 4.87 6.44 2.24 15 0 M15 0 C15 0 15 0 15 0 M15 0 C15 0 15 0 15 0" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g><g transform="translate(0 80)"><g stroke-linecap="round"><path d="M50 0 C58.43 4.59 68.9 11.19 100 30 M50 0 C61.21 5.72 70.73 11.85 100 30 M100 30 C85.85 39.34 71.16 48.5 50 60 M100 30 C84.25 40.39 66.65 49.51 50 60 M50 60 C35.74 52.63 19.44 44.59 0 30 M50 60 C34.32 49.54 17.26 40.52 0 30 M0 30 C12.95 25.54 21.65 16.3 50 0 M0 30 C13.71 23.38 24.94 15.27 50 0" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g><g transform="translate(120 80)"><g stroke-linecap="round"><path d="M57.72 4.63 C63.28 9.03 66.74 8.33 78.56 17.14 M57.72 4.63 C63.45 8.21 69.75 12.68 78.56 17.14 M78.56 17.14 C89.08 23.08 89.79 37.55 78.56 42.86 M78.56 17.14 C86.77 22.91 89.83 37.06 78.56 42.86 M78.56 42.86 C72.98 45.22 65.6 48.52 57.72 55.37 M78.56 42.86 C70.32 47.03 63.86 52.41 57.72 55.37 M57.72 55.37 C53.35 57.83 46.97 57.34 42.28 55.37 M57.72 55.37 C53.11 56.17 48.48 59.16 42.28 55.37 M42.28 55.37 C35.01 53.43 29.45 50.23 21.44 42.86 M42.28 55.37 C37.05 52.25 31.42 48.38 21.44 42.86 M21.44 42.86 C10.18 37.89 13.02 23.07 21.44 17.14 M21.44 42.86 C12.15 39.27 13.47 21.05 21.44 17.14 M21.44 17.14 C27.81 13.51 34.97 8.18 42.28 4.63 M21.44 17.14 C28.48 12.83 33.72 9.76 42.28 4.63 M42.28 4.63 C46.78 3.77 52.76 2.55 57.72 4.63 M42.28 4.63 C46.85 0.4 54.72 3.97 57.72 4.63 M57.72 4.63 C57.72 4.63 57.72 4.63 57.72 4.63 M57.72 4.63 C57.72 4.63 57.72 4.63 57.72 4.63" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g><g transform="translate(0 160)"><g stroke-linecap="round"><path d="M60.77 0.3 C69.43 0.95 78.7 5.59 85.04 9.57 C91.38 13.55 96.8 18.97 98.82 24.21 C100.84 29.44 100.36 36 97.17 40.98 C93.97 45.95 86.84 50.82 79.66 54.04 C72.48 57.27 63.1 60.08 54.1 60.33 C45.1 60.59 33.67 58.2 25.67 55.56 C17.67 52.92 10.42 49.21 6.11 44.5 C1.79 39.78 -0.78 32.72 -0.21 27.28 C0.36 21.84 4.03 16.24 9.54 11.87 C15.04 7.5 23.69 2.86 32.84 1.07 C41.99 -0.73 58.78 0.88 64.44 1.09 C70.1 1.3 67.04 1.9 66.79 2.32 M25.85 2.9 C33.34 0.2 46 -0.19 55.18 0.34 C64.36 0.86 73.96 2.91 80.91 6.04 C87.86 9.17 93.72 13.79 96.9 19.11 C100.09 24.43 102.22 32.41 100.02 37.98 C97.83 43.56 90.62 49.02 83.75 52.55 C76.88 56.08 67.47 58.1 58.8 59.14 C50.13 60.17 39.71 60.75 31.71 58.75 C23.71 56.75 15.87 51.53 10.79 47.13 C5.72 42.72 2.15 37.85 1.28 32.32 C0.41 26.8 1.41 18.95 5.59 13.96 C9.77 8.96 22.73 4.02 26.37 2.33 C30.02 0.64 26.79 3.16 27.46 3.83" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g><g transform="translate(0 240)"><foreignObject x="0" y="0" width="120" height="50"><div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;flex-direction:column;justify-content:flex-start;width:100%;height:100%;font-family:&apos;Excalifont&apos;, cursive;font-size:20px;font-weight:normal;font-style:normal;text-decoration:none;text-align:left;color:#1e1e1e;letter-spacing:0px;line-height:1.2"><p>Line one</p><p>Line two</p></div></foreignObject></g><g transform="translate(0 320)"><path d="M 1.01 -1.52 Q 1.01 -1.52 5.17 1.38 9.33 4.28 15.13 3.74 20.93 3.19 28.11 7.1 35.28 11 47.51 8.78 59.75 6.56 59.99 6.56 60.22 6.56 60.45 6.63 60.67 6.71 60.86 6.85 61.05 6.99 61.18 7.18 61.32 7.38 61.38 7.6 61.45 7.83 61.44 8.07 61.43 8.3 61.34 8.52 61.26 8.74 61.1 8.92 60.95 9.1 60.75 9.23 60.55 9.35 60.32 9.4 60.09 9.46 59.86 9.43 59.62 9.41 59.41 9.31 59.19 9.21 59.02 9.05 58.85 8.89 58.73 8.68 58.62 8.48 58.58 8.25 58.54 8.01 58.58 7.78 58.61 7.55 58.72 7.34 58.83 7.13 59 6.96 59.17 6.8 59.38 6.7 59.6 6.6 59.83 6.57 60.07 6.54 60.3 6.59 60.53 6.64 60.73 6.76 60.93 6.88 61.09 7.06 61.24 7.24 61.33 7.46 61.42 7.67 61.44 7.91 61.45 8.15 61.39 8.37 61.33 8.6 61.2 8.8 61.07 8.99 60.88 9.14 60.69 9.28 60.47 9.36 60.25 9.44 60.25 9.44 60.25 9.44 47.25 11.58 34.25 13.73 27.57 10.01 20.9 6.29 14.41 6.75 7.92 7.22 3.45 4.37 -1.01 1.52 -1.18 1.38 -1.35 1.23 -1.48 1.05 -1.6 0.88 -1.69 0.67 -1.77 0.47 -1.8 0.25 -1.83 0.03 -1.8 -0.19 -1.78 -0.41 -1.71 -0.62 -1.63 -0.82 -1.51 -1.01 -1.39 -1.19 -1.22 -1.34 -1.06 -1.49 -0.87 -1.59 -0.68 -1.7 -0.46 -1.75 -0.25 -1.81 -0.03 -1.81 0.19 -1.82 0.41 -1.77 0.62 -1.72 0.82 -1.62 1.01 -1.52 1.01 -1.52 L 1.01 -1.52 Z" fill="#1e1e1e" stroke="none"/></g><g transform="translate(120 320)"><g stroke-linecap="round"><path d="M0 0 C20.86 1.09 39.45 -1.32 100 0 M0 0 C38.16 0.88 74.36 0.63 100 0 M100 0 C98.67 10.62 101.55 23.2 100 40 M100 0 C100.98 7.24 100.16 15.58 100 40" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g><g transform="translate(0 400)"><g stroke-linecap="round"><path d="M0.4 0.93 C13.73 0.7 72.97 -11.58 79.89 -1.66 C86.81 8.27 54.9 59.89 41.9 60.48 C28.91 61.07 8.65 12.04 1.9 1.9" fill="#ffd43b" stroke="none"/><path d="M-0.21 -0.17 C13.39 -0.16 73.86 -9.25 80.4 0.67 C86.95 10.6 52.44 59.4 39.08 59.38 C25.72 59.35 6.82 10.23 0.26 0.51 M-1.78 -1.31 C11.8 -1.7 72.46 -11.37 79.67 -1.1 C86.88 9.18 54.66 60.48 41.49 60.36 C28.32 60.25 7.26 8.55 0.64 -1.77" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g><g transform="translate(120 400)"><g stroke-linecap="round"><path d="M0 0 C18.86 8.61 39.09 18.61 100 40 M0 0 C33.1 12.9 64.84 25.88 100 40" stroke="#1e1e1e" stroke-width="2" fill="none"/><path d="M75.01 39.21 C78.59 39.25 83.82 41.4 100 40 M75.01 39.21 C83.97 38.84 91.72 39.28 100 40" stroke="#1e1e1e" stroke-width="2" fill="none"/><path d="M100 40 C94.73 36.12 91.23 34.78 81.36 23.34 M100 40 C94.94 33.62 88.73 28.47 81.36 23.34" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g><g transform="translate(0 500)"><g stroke-linecap="round"><clipPath id="arrow-label-clip-ar2"><path clip-rule="evenodd" d="M-52 -82 h224 v164 h-224 Z M25 -30 h70 v60 h-70 Z"/></clipPath><g clip-path="url(#arrow-label-clip-ar2)"><path d="M0 0 C25.44 -1.67 48.49 0.52 120 0 M0 0 C47.19 -0.21 93.55 1.19 120 0" stroke="#1e1e1e" stroke-width="2" fill="none"/></g><path d="M107.36 6.09 L121.45 1.74 L108.17 -6.76" fill="#1e1e1e" stroke="none"/><path d="M106.41 6.34 C110.14 3.99 112.15 4.37 120 0 M106.41 6.34 C111.82 3.42 116.65 1.98 120 0 M120 0 C116.11 -0.91 110.46 -5.36 106.41 -6.34 M120 0 C115.86 -1.62 111.3 -4 106.41 -6.34 M106.41 -6.34 C105.94 -2.55 107.05 2.53 106.41 6.34 M106.41 -6.34 C106.73 -2.83 106.26 0.19 106.41 6.34" stroke="#1e1e1e" stroke-width="2" fill="none"/><text x="60" y="-7.38" font-family="&apos;Excalifont&apos;, cursive" font-size="20px" fill="#1e1e1e" text-anchor="middle" style="white-space: pre;">Two</text><text x="60" y="17.62" font-family="&apos;Excalifont&apos;, cursive" font-size="20px" fill="#1e1e1e" text-anchor="middle" style="white-space: pre;">Lines</text></g></g><g transform="translate(40 60)"><g stroke-linecap="round"><path d="M0 0 C-1.25 33.58 -3.37 63.98 0 160 M0 0 C0.34 41.79 1.25 84.64 0 160 M0 160 C45.7 159.57 88.51 159.57 200 160 M0 160 C60.44 161.17 121.8 160.61 200 160" stroke="#1e1e1e" stroke-width="2" fill="none"/><path d="M176.51 168.55 C181.58 168.54 184.15 165.22 200 160 M176.51 168.55 C182.01 165.8 189.12 164.16 200 160" stroke="#1e1e1e" stroke-width="2" fill="none"/><path d="M200 160 C195.67 159.72 188.85 156.4 176.51 151.45 M200 160 C193.1 157.36 187.81 155.72 176.51 151.45" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g><g transform="translate(240 200)"><g stroke-linecap="round"><path d="M0 0 C19.15 -0.1 39.85 -1.51 100 0 M0 0 C34.14 -1.07 66.22 -1.23 100 0 M100 0 C100.82 13.65 98.01 31.72 100 60 M100 0 C100.53 16.71 100.19 32.58 100 60 M100 60 C68.11 60.03 39.85 59.52 0 60 M100 60 C65.96 60.43 34.09 59.96 0 60 M0 60 C-1.56 47.98 1.34 33.75 0 0 M0 60 C-1.23 37.75 -1.07 15.5 0 0" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g><g transform="translate(40 60)"><g stroke-linecap="round"><path d="M0 0 C-2.89 28.3 0.63 55.9 0 144 M0 0 C1.03 29.93 1.08 58.92 0 144 M0 144 C-0.16 156.08 3.64 160.78 16 160 M0 144 C0.48 155.62 7.35 158.94 16 160 M16 160 C60.6 161.15 107.56 158.87 200 160 M16 160 C63.52 159.23 108.62 159.38 200 160" stroke="#1e1e1e" stroke-width="2" fill="none"/><path d="M176.51 168.55 C179.26 166.37 187.48 163.45 200 160 M176.51 168.55 C181.06 166.89 186 164.17 200 160" stroke="#1e1e1e" stroke-width="2" fill="none"/><path d="M200 160 C193.35 157.75 192.18 154.82 176.51 151.45 M200 160 C194.79 158.08 189.96 155.36 176.51 151.45" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g><g transform="translate(0 580)"><g stroke-linecap="round"><path d="M0 0 C21.72 -1.16 38.42 4.82 100 0 M0 0 C29.88 0.31 57.13 0.86 100 0 M100 0 C100.8 10.26 98.62 23.34 100 40 M100 0 C98.54 8.22 101.46 18.82 100 40" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g><g transform="translate(120 580)"><g stroke-linecap="round"><path d="M0 0 C19.22 10.36 41.56 16.74 100 40 M0 0 C34.79 13.61 68.4 26.66 100 40" stroke="#1e1e1e" stroke-width="2" fill="none"/><path d="M75.01 39.21 C79.73 40.73 85.89 40.08 100 40 M75.01 39.21 C83.94 39.74 91.94 39.51 100 40" stroke="#1e1e1e" stroke-width="2" fill="none"/><path d="M100 40 C96.03 38.13 93.47 33.99 81.36 23.34 M100 40 C93.72 34.67 86.37 28.3 81.36 23.34" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g><g transform="translate(0 680)"><g stroke-linecap="round"><path d="M0 0 C17.15 1.88 37.14 0.66 100 0 M0 0 C21.06 2.75 45.02 0.17 100 0" stroke="#1e1e1e" stroke-width="2" fill="none"/><path d="M100.86 -7.44 C102.37 -7.32 104.62 -6.46 105.73 -5.2 C106.83 -3.94 107.47 -1.48 107.47 0.11 C107.48 1.7 106.68 3.22 105.76 4.33 C104.84 5.45 103.49 6.45 101.97 6.8 C100.45 7.15 98.18 7.09 96.65 6.41 C95.11 5.74 93.31 4.17 92.77 2.77 C92.24 1.37 92.84 -0.45 93.44 -1.99 C94.03 -3.52 94.96 -5.61 96.33 -6.44 C97.69 -7.27 100.71 -6.81 101.62 -6.98 C102.53 -7.16 101.8 -7.51 101.76 -7.5 M102.11 -7.79 C103.56 -7.34 104.98 -5.13 105.83 -3.92 C106.68 -2.72 107.37 -2.03 107.21 -0.55 C107.05 0.93 105.79 3.6 104.87 4.96 C103.95 6.32 103.14 7.45 101.68 7.63 C100.23 7.81 97.52 7.02 96.15 6.04 C94.77 5.06 93.94 3.23 93.44 1.73 C92.93 0.23 92.69 -1.52 93.12 -2.95 C93.54 -4.38 94.52 -6.17 95.97 -6.84 C97.42 -7.52 100.91 -6.87 101.82 -7.02 C102.73 -7.17 101.5 -7.88 101.43 -7.76" fill="#1e1e1e" stroke="none"/><path d="M99.97 -7.82 C101.46 -7.89 103.33 -6.98 104.59 -5.82 C105.86 -4.67 107.36 -2.61 107.57 -0.88 C107.77 0.84 106.68 3.24 105.82 4.53 C104.96 5.83 103.87 6.53 102.42 6.88 C100.96 7.23 98.56 7.2 97.09 6.63 C95.61 6.07 94.21 4.87 93.57 3.49 C92.94 2.11 92.92 -0.08 93.27 -1.66 C93.61 -3.25 94.52 -4.98 95.65 -6.02 C96.78 -7.05 99.26 -7.72 100.04 -7.9 C100.82 -8.07 100.32 -7.27 100.33 -7.07 M99.18 -7.51 C100.47 -7.7 102.4 -6.53 103.74 -5.63 C105.08 -4.73 106.82 -3.67 107.22 -2.1 C107.62 -0.53 106.75 2.29 106.13 3.79 C105.51 5.29 104.92 6.28 103.5 6.9 C102.07 7.51 99.07 7.83 97.56 7.47 C96.05 7.11 95.23 6.05 94.45 4.74 C93.67 3.43 92.74 1.35 92.89 -0.4 C93.03 -2.14 94.22 -4.51 95.32 -5.74 C96.42 -6.97 98.68 -7.61 99.47 -7.76 C100.27 -7.92 100.07 -6.81 100.1 -6.64" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g><g transform="translate(250 460)"><g stroke-linecap="round"><path d="M0 0 C7.15 1.66 15.61 1.64 40 0 M0 0 C10.52 -0.36 19.62 0.01 40 0 M40 0 C38.72 19.62 39.94 35.11 40 60 M40 0 C39.86 18.7 39.81 36.66 40 60 M40 60 C51.02 60.38 59.78 58.35 80 60 M40 60 C48.57 60.19 57.77 59.94 80 60" stroke="#1e1e1e" stroke-width="2" fill="none"/><path d="M61.21 66.84 C64.08 66.93 68.3 65.54 80 60 M61.21 66.84 C66.66 64.65 70.68 63.37 80 60" stroke="#1e1e1e" stroke-width="2" fill="none"/><path d="M80 60 C75.36 59.73 72.06 58.35 61.21 53.16 M80 60 C76.44 57.45 71.44 56.18 61.21 53.16" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g><g transform="translate(230 0)"><defs><linearGradient id="fill-gr1" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff"/></linearGradient></defs><g stroke-linecap="round"><path d="M-1.96 0.81 L100.38 1.96 L100.31 59.08 L1.43 59.68" fill="url(#fill-gr1)" stroke="none"/><path d="M0 0 C18.01 -0.01 41.3 0.17 100 0 M0 0 C31.31 -0.18 61.58 -0.6 100 0 M100 0 C97.91 19.9 97.98 40.16 100 60 M100 0 C101.2 16.99 100.04 33.25 100 60 M100 60 C62.02 62.52 20.37 61.99 0 60 M100 60 C73.17 59.15 48.76 59.79 0 60 M0 60 C-0.67 40.28 -1.53 16.98 0 0 M0 60 C0.28 36.37 -0.22 14.11 0 0" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g><g transform="translate(230 80)"><defs><linearGradient id="fill-gr2" x1="0.5" y1="0" x2="0.5" y2="1"><stop offset="0" stop-color="#ffd43b"/><stop offset="1" stop-color="#1e1e1e"/></linearGradient></defs><g stroke-linecap="round"><path d="M0.89 23.3 C0.89 23.3 0.89 23.3 0.89 23.3 M0.89 23.3 C0.89 23.3 0.89 23.3 0.89 23.3 M2.99 33.08 C10.76 20.25 23.63 12.28 27.27 5.15 M2.99 33.08 C9.55 26.05 14.02 18.75 27.27 5.15 M5.75 42.1 C17.16 31.75 26.97 18.36 41.18 1.34 M5.75 42.1 C13.8 31.68 20.96 23.81 41.18 1.34 M11.79 47.35 C27.52 30.46 41.87 13.87 51.81 1.31 M11.79 47.35 C20.58 35.5 31.85 23.72 51.81 1.31 M17.17 53.35 C28.6 41 41.78 27.02 62.44 1.28 M17.17 53.35 C33.8 34.41 49.46 15.95 62.44 1.28 M25.17 56.33 C38.48 42.74 52.95 26.02 71.75 2.75 M25.17 56.33 C41.26 38.05 57.1 17.32 71.75 2.75 M34.49 57.81 C48.46 38.67 66.34 23.55 79.1 6.49 M34.49 57.81 C50.96 38.13 69.46 18.09 79.1 6.49 M43.15 60.04 C60.88 41.52 76.47 22.78 86.45 10.23 M43.15 60.04 C56.52 44.98 69.14 29.56 86.45 10.23 M53.78 60 C62.25 47.17 75.79 35.67 92.49 15.48 M53.78 60 C63.05 48.54 72.27 37.96 92.49 15.48 M65.07 59.22 C74.89 47.96 83.67 37.98 96.56 22.99 M65.07 59.22 C72.73 50.97 78.8 42.67 96.56 22.99 M79.64 54.65 C85.95 47.7 92.14 38.67 99.32 32.01 M79.64 54.65 C85.74 47.12 93 38.62 99.32 32.01" stroke="url(#fill-gr2)" stroke-width="1" fill="none"/><path d="M40.97 0.56 C49.36 -0.95 60.27 -0.6 68.47 1.37 C76.67 3.34 84.86 7.76 90.19 12.38 C95.51 16.99 99.73 23.54 100.42 29.06 C101.11 34.57 98.7 40.72 94.33 45.45 C89.95 50.19 82.23 55.01 74.18 57.45 C66.13 59.9 55.23 60.6 46.03 60.12 C36.83 59.64 26.03 57.93 18.98 54.58 C11.93 51.24 6.69 45.34 3.73 40.06 C0.77 34.79 -0.54 28.1 1.22 22.92 C2.98 17.75 6.71 12.64 14.29 8.99 C21.86 5.35 40.36 2.54 46.66 1.05 C52.97 -0.44 52.16 -0.27 52.12 0.06 M50.49 0.12 C59.37 -0.26 70.81 1.07 78.3 4.16 C85.78 7.25 91.76 13.46 95.41 18.66 C99.05 23.87 101.24 30.08 100.16 35.39 C99.08 40.7 94.78 46.53 88.93 50.52 C83.08 54.5 73.68 57.79 65.06 59.29 C56.45 60.78 45.81 61.31 37.23 59.51 C28.64 57.7 19.54 52.73 13.56 48.45 C7.58 44.17 2.91 39.09 1.35 33.82 C-0.21 28.55 0.53 21.7 4.2 16.81 C7.86 11.93 15.93 7.12 23.34 4.52 C30.74 1.92 44.03 1.65 48.6 1.21 C53.17 0.76 50.62 1.57 50.77 1.85" stroke="#1e1e1e" stroke-width="2" fill="none"/></g></g></svg>';

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

    test('rich text rides into the foreignObject verbatim, its style attribute escaped', () => {
        const svg = sceneToSvg(
            scene([
                {
                    ...DEFAULT_ELEMENT_PROPS,
                    id: 't',
                    type: 'richtext',
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 30,
                    angle: 0,
                    index: 'a0',
                    fill: solidFill('transparent'),
                    fillStyle: 'solid',
                    corners: 'straight',
                    html: '<p>a<b>bold</b></p>',
                    fontFamily: 'Excalifont',
                    fontSize: 20,
                    fontWeight: 'normal',
                    fontStyle: 'normal',
                    textDecoration: 'none',
                    textAlign: 'left',
                    verticalAlign: 'top',
                    color: '#1e1e1e',
                    letterSpacing: 0,
                    lineHeight: 1.2,
                    highlightColor: 'transparent',
                    padding: 12,
                },
            ]),
        );
        // The html is markup, not text — it is emitted as written (sanitisation happens at each
        // consumer's own seam), while the style attribute's quotes are escaped.
        expect(svg).toContain('<p>a<b>bold</b></p>');
        expect(svg).toContain('font-family:&apos;Excalifont&apos;, cursive');
        // padding shrinks the text area inside the stored box rather than growing it
        expect(svg).toContain('padding:12px;box-sizing:border-box');
    });

    test('XML-escapes hostile shape attribute values (stroke color)', () => {
        const svg = sceneToSvg(scene([goldenShape({ id: 's', type: 'rectangle', strokeColor: '"><script>' })]));
        expect(svg).toContain('stroke="&quot;&gt;&lt;script&gt;"');
        expect(svg).not.toContain('"><script>');
        expect(svg).not.toContain('<script>');
    });

    test('renders a fill (fillSketch/fillPath) using the background color', () => {
        const svg = sceneToSvg(
            scene([goldenShape({ id: 's', type: 'rectangle', fill: solidFill('#ff0000'), fillStyle: 'hachure' })]),
        );
        expect(svg).toContain('stroke="#ff0000"');
    });

    test('emits stroke-dasharray for a dashed stroke', () => {
        const svg = sceneToSvg(scene([goldenShape({ id: 's', type: 'rectangle', strokeStyle: 'dashed' })]));
        expect(svg).toContain('stroke-dasharray=');
    });

    test('emits a rotate() transform only when angle is non-zero', () => {
        expect(sceneToSvg(scene([goldenShape({ id: 's', type: 'rectangle', angle: 30 })]))).toContain('rotate(30 ');
        expect(sceneToSvg(scene([goldenShape({ id: 's', type: 'rectangle', angle: 0 })]))).not.toContain('rotate(');
    });

    test('emits opacity only when not 100', () => {
        expect(sceneToSvg(scene([goldenShape({ id: 's', type: 'rectangle', opacity: 50 })]))).toContain(
            'opacity="0.5"',
        );
        expect(sceneToSvg(scene([goldenShape({ id: 's', type: 'rectangle', opacity: 100 })]))).not.toContain(
            'opacity=',
        );
    });

    test('renders images through the media resolver, nothing when unresolvable', () => {
        const img: VectorImageElement = {
            ...DEFAULT_ELEMENT_PROPS,
            id: 'img',
            type: 'image',
            x: 0,
            y: 0,
            width: 40,
            height: 40,
            angle: 0,
            index: 'a0',
            corners: 'straight',
            objectFit: 'contain',
            mediaName: 'pic.png',
        };
        const resolved = sceneToSvg(scene([img]), { resolveMedia: () => 'data:image/png;base64,AAA' });
        expect(resolved).toContain('<image');
        expect(resolved).toContain('href="data:image/png;base64,AAA"');
        expect(sceneToSvg(scene([img]))).not.toContain('<image');
    });

    test('an eigen-media ref href survives escapeXml unchanged (R1)', () => {
        const img: VectorImageElement = {
            ...DEFAULT_ELEMENT_PROPS,
            id: 'img',
            type: 'image',
            x: 0,
            y: 0,
            width: 40,
            height: 40,
            angle: 0,
            index: 'a0',
            corners: 'straight',
            objectFit: 'contain',
            mediaName: "Bob's photo.png",
        };
        const href = eigenMediaHref(img.mediaName);
        const out = sceneToSvg(scene([img]), { resolveMedia: (name) => eigenMediaHref(name) });
        // The stored token equals eigenMediaHref exactly — escapeXml is a no-op on it, so the copy
        // path's rewrite/strip (media-refs) find it by exact-token match.
        expect(out).toContain(`href="${href}"`);
    });

    test('paints in fractional-index order regardless of input order', () => {
        const front = goldenShape({ id: 'front', type: 'rectangle', index: 'a2' });
        const back = goldenShape({ id: 'back', type: 'rectangle', index: 'a0' });
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

// Pressure BC gate + real-pressure divergence. The freedraw element with NO pressure fields must render
// byte-identically to today (simulate path); this pin is computed from the pre-change renderer and stays
// green forever — it is the pixel-BC proof at the data level for old .eigenvector docs.
describe('freedraw pen pressure', () => {
    const freedraw = (over: Partial<VectorLinearElement>): VectorLinearElement => ({
        ...DEFAULT_ELEMENT_PROPS,
        ...LINEAR_PAINT,
        id: 'fd',
        type: 'freedraw',
        x: 0,
        y: 0,
        width: 60,
        height: 20,
        angle: 0,
        seed: 7,
        index: 'a0',
        roundness: 'sharp',
        points: '[[0,0],[15,10],[30,4],[45,18],[60,8]]',
        pressures: '',
        simulatePressure: true,
        ...over,
    });

    const NO_PRESSURE_PIN =
        '<g transform="translate(0 0)"><path d="M 1.01 -1.52 Q 1.01 -1.52 5.17 1.38 9.33 4.28 15.13 3.74 20.93 3.19 28.11 7.1 35.28 11 47.51 8.78 59.75 6.56 59.99 6.56 60.22 6.56 60.45 6.63 60.67 6.71 60.86 6.85 61.05 6.99 61.18 7.18 61.32 7.38 61.38 7.6 61.45 7.83 61.44 8.07 61.43 8.3 61.34 8.52 61.26 8.74 61.1 8.92 60.95 9.1 60.75 9.23 60.55 9.35 60.32 9.4 60.09 9.46 59.86 9.43 59.62 9.41 59.41 9.31 59.19 9.21 59.02 9.05 58.85 8.89 58.73 8.68 58.62 8.48 58.58 8.25 58.54 8.01 58.58 7.78 58.61 7.55 58.72 7.34 58.83 7.13 59 6.96 59.17 6.8 59.38 6.7 59.6 6.6 59.83 6.57 60.07 6.54 60.3 6.59 60.53 6.64 60.73 6.76 60.93 6.88 61.09 7.06 61.24 7.24 61.33 7.46 61.42 7.67 61.44 7.91 61.45 8.15 61.39 8.37 61.33 8.6 61.2 8.8 61.07 8.99 60.88 9.14 60.69 9.28 60.47 9.36 60.25 9.44 60.25 9.44 60.25 9.44 47.25 11.58 34.25 13.73 27.57 10.01 20.9 6.29 14.41 6.75 7.92 7.22 3.45 4.37 -1.01 1.52 -1.18 1.38 -1.35 1.23 -1.48 1.05 -1.6 0.88 -1.69 0.67 -1.77 0.47 -1.8 0.25 -1.83 0.03 -1.8 -0.19 -1.78 -0.41 -1.71 -0.62 -1.63 -0.82 -1.51 -1.01 -1.39 -1.19 -1.22 -1.34 -1.06 -1.49 -0.87 -1.59 -0.68 -1.7 -0.46 -1.75 -0.25 -1.81 -0.03 -1.81 0.19 -1.82 0.41 -1.77 0.62 -1.72 0.82 -1.62 1.01 -1.52 1.01 -1.52 L 1.01 -1.52 Z" fill="#1e1e1e" stroke="none"/></g>';

    test('BC pin — a freedraw with NO pressure fields renders exactly as today (simulate)', () => {
        expect(elementToSvg(freedraw({}))).toBe(NO_PRESSURE_PIN);
    });

    test('real per-point pressures render a different, deterministic path', () => {
        const withPressure = freedraw({ pressures: '[0.1,0.9,0.2,0.8,0.3]', simulatePressure: false });
        const out = elementToSvg(withPressure);
        // Real pressures with simulatePressure:false must diverge from the simulate output…
        expect(out).not.toBe(NO_PRESSURE_PIN);
        // …and the same element renders identically twice (deterministic getStroke input).
        expect(out).toBe(elementToSvg(freedraw({ pressures: '[0.1,0.9,0.2,0.8,0.3]', simulatePressure: false })));
    });

    test('simulatePressure:true ignores stored pressures (BC — same as no pressures)', () => {
        expect(elementToSvg(freedraw({ pressures: '[0.1,0.9,0.2,0.8,0.3]', simulatePressure: true }))).toBe(
            NO_PRESSURE_PIN,
        );
    });
});

// The cartoon-roughness (r≥2) endpoint pinning: preserveVertices now holds for every LINEAR element, so a
// sketchy line's on-curve vertices land EXACTLY on the stored points (only the control points wander — that
// IS the sketch look). Pre-fix (preserveVertices off at r≥2) the endpoints themselves drifted ~2–3px, which
// forked the head off the shaft end. This is the deliberate drift from Excalidraw the golden also pins.
describe('linear preserveVertices at cartoon roughness', () => {
    const verts: [number, number][] = [
        [0, 0],
        [100, 0],
        [100, 40],
    ];
    const lineAt = (seed: number): VectorElement => ({
        ...DEFAULT_ELEMENT_PROPS,
        ...LINEAR_PAINT,
        id: 'L',
        type: 'line',
        x: 40,
        y: 40,
        width: 100,
        height: 40,
        angle: 0,
        seed,
        index: 'a0',
        roughness: 2,
        roundness: 'sharp',
        points: JSON.stringify(verts),
        pressures: '',
        simulatePressure: true,
    });

    test('r=2 line: every rendered subpath endpoint sits exactly on a stored vertex, across seeds', () => {
        const near = (v: [number, number]) =>
            verts.find((s) => Math.abs(s[0] - v[0]) < 1e-9 && Math.abs(s[1] - v[1]) < 1e-9);
        for (const seed of [1, 2, 7, 42, 99]) {
            const d = elementToSvg(lineAt(seed)).match(/ d="([^"]+)"/)?.[1];
            expect(d).toBeDefined();
            // Each roughjs stroke pass is a subpath; strip the command letters and read its first (move) and
            // last (segment-end) coordinate pair — both are on-curve vertices, exact when preserveVertices holds.
            for (const sub of (d as string).split('M').filter(Boolean)) {
                const n = sub
                    .replace(/[A-Za-z]/g, ' ')
                    .trim()
                    .split(/[\s,]+/)
                    .map(Number);
                expect(near([n[0], n[1]])).toBeDefined();
                expect(near([n[n.length - 2], n[n.length - 1]])).toBeDefined();
            }
        }
    });
});

// The gradient contract WeasyPrint forces (phase-0 evidence A): the <linearGradient> lives in the
// element's OWN fragment with an element-scoped id, because a url(#…) reference into a different <svg>
// renders nothing. Solid fills reference it from `fill=`, sketch fills (hachure/cross-hatch/zigzag are
// stroked paths) from `stroke=`.
describe('gradient fills', () => {
    const gradient = '{"type":"gradient","from":"#ff0000","to":"#0000ff","angle":45}';

    test('a solid-styled gradient shape emits one element-scoped linearGradient and points fill at it', () => {
        const svg = elementToSvg(goldenShape({ id: 'g1', type: 'rectangle', fill: gradient, fillStyle: 'solid' }));
        expect(svg).toContain('<linearGradient id="fill-g1"');
        expect(svg).toContain('fill="url(#fill-g1)"');
    });

    test('a hachure gradient paints the sketch STROKES with the same gradient', () => {
        const svg = elementToSvg(goldenShape({ id: 'g2', type: 'rectangle', fill: gradient, fillStyle: 'hachure' }));
        expect(svg).toContain('<linearGradient id="fill-g2"');
        expect(svg).toContain('stroke="url(#fill-g2)"');
    });

    test('ids are element-scoped so two gradient shapes never collide', () => {
        const svg = sceneToSvg(
            scene([
                goldenShape({ id: 'a', type: 'rectangle', fill: gradient }),
                goldenShape({ id: 'b', type: 'ellipse', fill: gradient, x: 200 }),
            ]),
        );
        expect(svg).toContain('id="fill-a"');
        expect(svg).toContain('id="fill-b"');
    });

    test('a closed line fills with its own gradient too', () => {
        const svg = elementToSvg({
            ...DEFAULT_ELEMENT_PROPS,
            ...LINEAR_PAINT,
            id: 'gl',
            type: 'line',
            x: 0,
            y: 0,
            width: 80,
            height: 60,
            angle: 0,
            seed: 3,
            index: 'a0',
            roundness: 'sharp',
            fill: gradient,
            points: '[[0,0],[80,0],[40,60],[0,0]]',
            pressures: '',
            simulatePressure: true,
        });
        expect(svg).toContain('<linearGradient id="fill-gl"');
        expect(svg).toContain('url(#fill-gl)');
    });

    test('a hostile element id cannot escape the id attribute', () => {
        const svg = elementToSvg(goldenShape({ id: '"><script>', type: 'rectangle', fill: gradient }));
        expect(svg).not.toContain('<script>');
    });

    test('a transparent fill emits no defs', () => {
        expect(elementToSvg(goldenShape({ id: 'g3', type: 'rectangle' }))).not.toContain('linearGradient');
    });
});

describe('elementToSvg options', () => {
    test('positioned:false drops the translate/rotate group so a layer box can carry it', () => {
        const el = goldenShape({ id: 'p', type: 'rectangle', x: 40, y: 60, angle: 30 });
        expect(elementToSvg(el)).toContain('transform="translate(40 60) rotate(30');
        expect(elementToSvg(el, { positioned: false })).not.toContain('translate(');
    });

    test('positioned:false is per-element — a scene always places its elements', () => {
        const svg = sceneToSvg(scene([goldenShape({ id: 'p', type: 'rectangle', x: 40, y: 60 })]), {
            positioned: false,
        });
        expect(svg).toContain('transform="translate(40 60)"');
    });
});
