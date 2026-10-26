// A resize shows the box's size below it while the grip is held, in the host's units unless the host words it. Every
// gesture ends once for the host, however it ends, so a host's preview never sticks.
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

// Presses a grip, ends the gesture with `end`, and returns what the host heard, in order.
async function gesture(grip: 'resize' | 'rotate', end: () => void) {
    const heard: string[] = [];
    ({ unmount } = await renderInDocument(
        createElement(ObjectTransform, {
            box: BOX,
            boxToStyle: () => ({}),
            screenDeltaToScene: (dx: number, dy: number) => ({ dx, dy }),
            showRotate: true,
            onTransform: () => heard.push('transform'),
            onCommit: () => heard.push('commit'),
            onGestureEnd: () => heard.push('end'),
        }),
    ));
    const target = document.querySelector(grip === 'resize' ? '.eigen-selection-handle' : '.cursor-grab');
    if (!target) throw new Error('no grip');
    Object.defineProperty(target, 'setPointerCapture', { value: () => {} });
    await act(async () => {
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, button: 0 }));
    });
    await act(async () => end());
    return heard;
}

const move = () => document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 40, clientY: 30 }));
const release = () => document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 40, clientY: 30 }));

test.each(['resize', 'rotate'] as const)('a %s that commits ends once, after its commit', async (grip) => {
    const heard = await gesture(grip, () => {
        move();
        release();
        release();
    });
    expect(heard).toEqual(['transform', 'transform', 'commit', 'end']);
});

test.each(['resize', 'rotate'] as const)(
    'a %s cancelled with Escape ends once, after the preview resets',
    async (grip) => {
        const heard = await gesture(grip, () => {
            move();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        });
        expect(heard).toEqual(['transform', 'transform', 'transform', 'end']);
    },
);

test('a press without a move ends once, with no commit', async () => {
    expect(await gesture('resize', release)).toEqual(['transform', 'end']);
});

test('a gesture whose chrome unmounts mid-drag ends once', async () => {
    const heard = await gesture('resize', move);
    await unmount();
    unmount = async () => {};
    expect(heard).toEqual(['transform', 'transform', 'end']);
});
