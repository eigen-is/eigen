import { expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useCoupledSize } = await import('../../../components/properties-panel/use-coupled-size');

type Size = { width?: number; height?: number };
type Change = { changeWidth: (width: number) => void; changeHeight: (height: number) => void };

// Mounts the hook over a box the host keeps, as a panel does, and answers the box after each write.
async function mountCoupled(start: { width: number; height: number }, locked: boolean) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let box: Size = start;
    const writes: Size[] = [];
    let change: Change | undefined;
    const Host = () => {
        change = useCoupledSize(box.width, box.height, locked, (size) => {
            writes.push(size);
            box = { ...box, ...size };
        });
        return null;
    };
    const render = () => act(async () => root.render(createElement(Host)));
    await render();
    return {
        type: async (side: 'width' | 'height', value: number) => {
            if (side === 'width') change?.changeWidth(value);
            else change?.changeHeight(value);
            await render();
        },
        box: () => box,
        writes,
        cleanup: async () => {
            await act(async () => root.unmount());
            container.remove();
        },
    };
}

// The ratio is latched with the box it wrote: re-deriving it off the rounded 25x13 lands on 250x130.
test('a locked width typed up to 250 keeps the 2:1 it started from', async () => {
    const coupled = await mountCoupled({ width: 100, height: 50 }, true);
    for (const typed of [2, 25, 250]) await coupled.type('width', typed);
    expect(coupled.box()).toEqual({ width: 250, height: 125 });
    await coupled.cleanup();
});

test('a locked height derives the width, floored at 1', async () => {
    const coupled = await mountCoupled({ width: 10, height: 400 }, true);
    await coupled.type('height', 8);
    expect(coupled.box()).toEqual({ width: 1, height: 8 });
    await coupled.cleanup();
});

test('an unlocked edit writes the side it edits alone', async () => {
    const coupled = await mountCoupled({ width: 100, height: 50 }, false);
    await coupled.type('height', 80);
    expect(coupled.writes).toEqual([{ height: 80 }]);
    await coupled.cleanup();
});
