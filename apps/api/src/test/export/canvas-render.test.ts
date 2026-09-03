import { describe, expect, test } from 'bun:test';
import type { VectorElement, VectorScene } from '@workspace/lib/vector';
import { drawingPage, emptyPage, renderCanvasPage } from '../../lib/export/canvas/render';
import { buildGoldenVectorScene, GOLDEN_MEDIA_NAME } from '../fixtures/golden-documents';

// Box fields only: a Partial of the whole union would widen `type` on the spread below and stop the
// result being a VectorElement at all.
type BoxOverride = Partial<Pick<VectorElement, 'x' | 'y' | 'width' | 'height' | 'angle' | 'opacity'>>;

// One element out of the shared golden scene, so the box arithmetic is pinned against a fixture
// every other server test already reads.
function sceneOf(id: string, over: BoxOverride = {}): VectorScene {
    const golden = buildGoldenVectorScene();
    const elements = golden.elements.filter((el) => el.id === id).map((el) => ({ ...el, ...over }));
    return { ...golden, elements };
}

const DATA_URI = 'data:image/png;base64,AAA';
const resolveMedia = () => DATA_URI;
// Every page here but the image ones draws no media; drawingPage takes the resolver either way.
const noMedia = () => null;

describe('drawingPage', () => {
    test('sizes the page to the content bounds plus the serializer padding', () => {
        // v-rect is 100x60 at (0,0); sceneToSvg pads a drawing by 10 on every side.
        const page = drawingPage(sceneOf('v-rect'), noMedia);
        expect(page).not.toBeNull();
        expect(page?.width).toBe(120);
        expect(page?.height).toBe(80);
        expect(page?.originX).toBe(-10);
        expect(page?.originY).toBe(-10);
    });

    test('an empty drawing has no page', () => {
        expect(
            drawingPage({ elements: [], frames: [], meta: { background: 'transparent', gridSize: 20 } }, noMedia),
        ).toBeNull();
    });

    test('a transparent scene background is no background at all', () => {
        expect(drawingPage(sceneOf('v-rect'), noMedia)?.background).toBeNull();
    });

    test('an opaque scene background becomes a solid fill', () => {
        const scene = sceneOf('v-rect');
        const page = drawingPage({ ...scene, meta: { ...scene.meta, background: '#ffffff' } }, noMedia);
        expect(page?.background).toEqual({ type: 'solid', color: '#ffffff' });
    });

    test('layers are the scene layers, in fractional-index order', () => {
        const page = drawingPage(buildGoldenVectorScene(), resolveMedia);
        expect(page?.layers.map((l) => l.id)).toEqual([
            'v-rect',
            'v-ellipse',
            'v-text',
            'v-freedraw',
            'v-line',
            'v-arrow',
            'v-image',
            'v-elbow',
            'v-gradient',
        ]);
    });
});

describe('emptyPage', () => {
    test('is the given box with the scene background and nothing on it', () => {
        const scene = sceneOf('v-rect');
        const page = emptyPage({ ...scene, meta: { ...scene.meta, background: '#ffffff' } }, 960, 120);
        expect(page).toEqual({
            width: 960,
            height: 120,
            originX: 0,
            originY: 0,
            background: { type: 'solid', color: '#ffffff' },
            layers: [],
        });
        expect(renderCanvasPage(page, 1)).toContain('width:960px;height:120px;background-color:#ffffff');
    });
});

describe('renderCanvasPage', () => {
    test('the page box is the scene box times the scale, and the scene wrapper carries the offset', () => {
        const page = drawingPage(sceneOf('v-rect'), noMedia);
        if (!page) throw new Error('expected a page');
        const html = renderCanvasPage(page, 1);
        expect(html).toContain(
            '<div class="canvas-page" style="position:relative;overflow:hidden;width:120px;height:80px"',
        );
        expect(html).toContain('transform:scale(1) translate(10px,10px);transform-origin:0 0');
    });

    test('scale multiplies the page box but never the layer geometry', () => {
        const page = drawingPage(sceneOf('v-rect'), noMedia);
        if (!page) throw new Error('expected a page');
        const html = renderCanvasPage(page, 0.5);
        expect(html).toContain('width:60px;height:40px');
        expect(html).toContain('transform:scale(0.5) translate(10px,10px)');
        // The layer is still authored in scene pixels — the scene wrapper is what shrinks it.
        expect(html).toContain('width:100px;height:60px;transform:translate(0px,0px)');
    });

    test('an awkward scale keeps its full precision, so the scene fills the page box exactly', () => {
        // 2850 wide + 2*10 padding = 2870; 960 / 2870 = 0.334494…, which rounded to 2 dp would
        // shrink the scene by 1.34% and leave a gutter down the right edge of every preview.
        const page = drawingPage(sceneOf('v-rect', { width: 2850 }), noMedia);
        if (!page) throw new Error('expected a page');
        expect(page.width).toBe(2870);
        const scale = 960 / page.width;
        const html = renderCanvasPage(page, scale);
        expect(html).toContain('width:960px');
        expect(html).toContain(`transform:scale(${scale}) `);
        expect(html).not.toContain('scale(0.33)');
    });

    test('a layer box is the live canvas box: translate to the origin, rotate about the centre', () => {
        const page = drawingPage(sceneOf('v-rect', { x: 12, y: 34, angle: 30, opacity: 50 }), noMedia);
        if (!page) throw new Error('expected a page');
        const html = renderCanvasPage(page, 1);
        expect(html).toContain('transform:translate(12px,34px) rotate(30deg);opacity:0.5');
    });

    test('an svg layer is an overflow-visible viewport holding the kind fragment', () => {
        const page = drawingPage(sceneOf('v-rect'), noMedia);
        if (!page) throw new Error('expected a page');
        const html = renderCanvasPage(page, 1);
        expect(html).toContain('<svg xmlns="http://www.w3.org/2000/svg" overflow="visible"');
        expect(html).toContain('overflow:visible');
        // roughjs drew the rectangle inside it.
        expect(html).toContain('<path ');
    });

    test('a rich text layer is the styled div, with no svg viewport around it', () => {
        const page = drawingPage(sceneOf('v-text'), noMedia);
        if (!page) throw new Error('expected a page');
        const html = renderCanvasPage(page, 1);
        expect(html).toContain('<p>Vector &lt;sketch&gt;</p>');
        expect(html).toContain('font-family:');
        expect(html).not.toContain('<svg');
        expect(html).not.toContain('<foreignObject');
    });

    test('an image layer resolves its media to the href the resolver returns', () => {
        const page = drawingPage(sceneOf('v-image'), resolveMedia);
        if (!page) throw new Error('expected a page');
        expect(renderCanvasPage(page, 1)).toContain(DATA_URI);
    });

    test('an image whose media does not resolve contributes no layer', () => {
        const page = drawingPage(sceneOf('v-image'), noMedia);
        expect(page?.layers).toEqual([]);
        expect(GOLDEN_MEDIA_NAME).toBe('pixel.png');
    });

    test('a page background paints on the page box', () => {
        const scene = sceneOf('v-rect');
        const page = drawingPage({ ...scene, meta: { ...scene.meta, background: '#fef3c7' } }, noMedia);
        if (!page) throw new Error('expected a page');
        expect(renderCanvasPage(page, 1)).toContain('background-color:#fef3c7');
    });

    test('is deterministic run to run', () => {
        const page = drawingPage(buildGoldenVectorScene(), resolveMedia);
        if (!page) throw new Error('expected a page');
        expect(renderCanvasPage(page, 1)).toBe(renderCanvasPage(page, 1));
    });
});
