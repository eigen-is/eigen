import { describe, expect, test } from 'bun:test';
import type { VectorFrame } from '@workspace/lib/vector';
import { SLIDE_SIZES } from '@workspace/lib/vector';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { SlideStrip } = await import('../../../components/slides/slide-panel');

const frames: VectorFrame[] = ['f1', 'f2'].map((id, i) => ({
    id,
    index: `a${i}`,
    name: '',
    ...SLIDE_SIZES['16:9'],
    background: '',
}));

// The editor owns the current slide; this harness owns it the same way, so a tap re-renders the strip.
function Strip() {
    const [activeFrameId, setActiveFrameId] = useState('f1');
    return createElement(SlideStrip, { frames, elements: [], activeFrameId, onSelectFrame: setActiveFrameId });
}

// Its own file, not the rail's: dnd-kit swallows the first click for 50 ms after a drag ends, and the
// rail's drag tests would leave that guard on a shared document.
describe('SlideStrip', () => {
    test('tapping a slide in the phone strip makes it current', () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        act(() => root.render(createElement(Strip)));
        const slides = [...container.querySelectorAll('button')];
        expect(slides).toHaveLength(2);
        expect(slides[1].getAttribute('aria-current')).toBeNull();
        act(() => void slides[1].dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(slides[1].getAttribute('aria-current')).toBe('true');
        expect(slides[0].getAttribute('aria-current')).toBeNull();
        act(() => root.unmount());
        container.remove();
    });
});
