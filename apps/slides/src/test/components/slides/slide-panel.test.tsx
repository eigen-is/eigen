import { describe, expect, test } from 'bun:test';
import type { SlideSize, VectorFrame } from '@workspace/lib/vector';
import { SLIDE_SIZES } from '@workspace/lib/vector';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SlidePanel } = await import('../../../components/slides/slide-panel');

const deck = (size: SlideSize): VectorFrame[] =>
    ['f1', 'f2'].map((id, i) => ({ id, index: `a${i}`, name: '', ...SLIDE_SIZES[size], background: '' }));

// The editor owns the drag id; this harness owns it the same way, so the overlay mounts on a real drag.
function Rail({ frames }: { frames: VectorFrame[] }) {
    const [dragActiveId, setDragActiveId] = useState<string | null>(null);
    return createElement(SlidePanel, {
        frames,
        elements: [],
        activeFrameId: 'f1',
        onSelectFrame: () => {},
        onDragStart: (event) => setDragActiveId(String(event.active.id)),
        onDragEnd: () => setDragActiveId(null),
        dragActiveId,
    });
}

function pointer(type: string, target: EventTarget, clientY: number) {
    const event = new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, button: 0 });
    // happy-dom's PointerEvent drops the coordinates of its init dict; the sensor measures the drag from them.
    Object.defineProperties(event, { clientX: { value: 0 }, clientY: { value: clientY } });
    act(() => void target.dispatchEvent(event));
}

// The overlay a drag picks up, shaped like the slide it carries.
function dragOverlayRatio(size: SlideSize): string {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(createElement(Rail, { frames: deck(size) })));
    const slide = container.querySelector('[aria-roledescription="sortable"]');
    if (!slide) throw new Error('the rail rendered no sortable slide');
    pointer('pointerdown', slide, 10);
    pointer('pointermove', document, 40);
    const overlay = container.querySelector<HTMLElement>('.border-primary');
    const ratio = overlay?.style.aspectRatio ?? '';
    pointer('pointerup', document, 40);
    act(() => root.unmount());
    container.remove();
    return ratio.replaceAll(' ', '');
}

describe('SlidePanel drag overlay', () => {
    test('a 16:9 slide drags as a 16:9 card', () => {
        expect(dragOverlayRatio('16:9')).toBe('1920/1080');
    });

    test('a 4:3 slide drags as a 4:3 card', () => {
        expect(dragOverlayRatio('4:3')).toBe('1920/1440');
    });
});
