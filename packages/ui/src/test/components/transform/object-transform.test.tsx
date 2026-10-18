// A resize shows the box's size below it while the grip is held, in the host's units unless the host words it.
import { afterEach, expect, test } from 'bun:test';
import type { Box } from '@workspace/lib/vector';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { ObjectTransform } = await import('../../../components/transform/object-transform');

let unmount = async () => {};
afterEach(() => unmount());

const BOX: Box = { x: 0, y: 0, width: 300.4, height: 150.6, angle: 0 };

async function pressGrip(props: { formatSize?: (box: Box) => string } = {}) {
    ({ unmount } = await renderInDocument(
        createElement(ObjectTransform, {
            box: BOX,
            boxToStyle: () => ({}),
            screenDeltaToScene: (dx: number, dy: number) => ({ dx, dy }),
            showRotate: false,
            onTransform: () => {},
            onCommit: () => {},
            ...props,
        }),
    ));
    const grip = document.querySelector('.eigen-selection-handle');
    if (!grip) throw new Error('no grip');
    // happy-dom has no pointer capture.
    Object.defineProperty(grip, 'setPointerCapture', { value: () => {} });
    await act(async () => {
        grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
    });
    return document.querySelector('.top-full')?.textContent;
}

test('a resize shows the size rounded in the host units', async () => {
    expect(await pressGrip()).toBe('300 × 151');
});

test('a host that words the size shows its words', async () => {
    expect(await pressGrip({ formatSize: ({ width, height }) => `${width} by ${height}` })).toBe('300.4 by 150.6');
});
