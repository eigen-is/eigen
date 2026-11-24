import { afterEach, expect, test } from 'bun:test';
import { DRAG_THRESHOLD_PX } from '@workspace/lib/constants/drag';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { usePointerDrag } = await import('../../hooks/use-pointer-drag');

let unmount = async () => {};
afterEach(() => unmount());

// Presses a target that starts a drag with `threshold` and returns what the caller heard, in order.
async function press(threshold?: number) {
    const heard: string[] = [];
    function Harness() {
        const startDrag = usePointerDrag();
        return createElement('div', {
            id: 'target',
            onPointerDown: (e: React.PointerEvent) =>
                startDrag(e, {
                    threshold,
                    move: (me) => heard.push(`move ${me.clientX}`),
                    end: () => heard.push('end'),
                    cancel: () => heard.push('cancel'),
                }),
        });
    }
    ({ unmount } = await renderInDocument(createElement(Harness)));
    const target = document.getElementById('target');
    if (!target) throw new Error('no target');
    // happy-dom has no pointer capture.
    Object.defineProperty(target, 'setPointerCapture', { value: () => {} });
    await act(async () => {
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 }));
    });
    return heard;
}

const moveTo = (clientX: number) =>
    act(async () => {
        document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX, clientY: 0 }));
    });
const release = () =>
    act(async () => {
        document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    });

test('a press that stays under the default threshold ends as a click', async () => {
    const heard = await press();
    await moveTo(DRAG_THRESHOLD_PX - 1);
    await release();
    expect(heard).toEqual(['end']);
});

test('a press past the threshold moves and ends', async () => {
    const heard = await press();
    await moveTo(DRAG_THRESHOLD_PX - 1);
    await moveTo(DRAG_THRESHOLD_PX);
    await moveTo(DRAG_THRESHOLD_PX + 3);
    await release();
    expect(heard).toEqual([`move ${DRAG_THRESHOLD_PX}`, `move ${DRAG_THRESHOLD_PX + 3}`, 'end']);
});

test('a zero threshold is live from the first move', async () => {
    const heard = await press(0);
    await moveTo(1);
    await release();
    expect(heard).toEqual(['move 1', 'end']);
});

test('Escape cancels, and the release after it ends nothing', async () => {
    const heard = await press();
    await moveTo(20);
    await act(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await release();
    expect(heard).toEqual(['move 20', 'cancel']);
});

test('a cancelled pointer after travel cancels and never ends', async () => {
    const heard = await press();
    await moveTo(20);
    await act(async () => {
        document.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
    });
    await release();
    expect(heard).toEqual(['move 20', 'cancel']);
});
