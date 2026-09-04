import { describe, expect, test } from 'bun:test';
import { FRAME_HEIGHT, FRAME_WIDTH, serializeBackgroundFill, type VectorFrame } from '@workspace/lib/vector';
import { renderToStaticMarkup } from 'react-dom/server';
import { canvasSurfaceClass, FramePage } from '../../../components/vector/paper';

const frame = (over: Partial<VectorFrame> = {}): VectorFrame => ({
    id: 'f1',
    index: 'a0',
    name: 'Slide 1',
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    background: serializeBackgroundFill({ type: 'solid', color: '#ffffff' }),
    ...over,
});

describe('canvasSurfaceClass', () => {
    test('the infinite canvas IS the paper: the surface pins light', () => {
        expect(canvasSurfaceClass(false)).toContain('eigen-paper');
    });

    test('a framed canvas letterboxes the page: the surface around it follows the theme', () => {
        const surface = canvasSurfaceClass(true);
        expect(surface).toContain('bg-muted');
        expect(surface).not.toContain('eigen-paper');
    });
});

describe('FramePage', () => {
    test('the page card is the light island, painted with the frame background', () => {
        const html = renderToStaticMarkup(
            <FramePage frame={frame()} zoom={1} resolveMediaUrl={() => null}>
                <span>slide body</span>
            </FramePage>,
        );
        expect(html).toContain('eigen-paper');
        expect(html).toContain('background-color:#ffffff');
        expect(html).toContain('slide body');
    });

    test('the rounded clip counter-scales the zoom, so the corner is constant on screen', () => {
        const html = renderToStaticMarkup(
            <FramePage frame={frame()} zoom={0.5} resolveMediaUrl={() => null}>
                {null}
            </FramePage>,
        );
        expect(html).toContain('border-radius:16px');
    });
});
