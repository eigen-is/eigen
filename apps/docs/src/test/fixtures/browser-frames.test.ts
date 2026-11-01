import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { withBrowserFrames } from './browser-frames';

installHappyDom();

test('waits for a frame that a frame asks for, and for the timer it sets', async () => {
    const order: string[] = [];
    await withBrowserFrames(async () => {
        requestAnimationFrame(() => {
            order.push('frame');
            requestAnimationFrame(() => {
                order.push('next frame');
                setTimeout(() => order.push('timer'));
            });
        });
    });
    expect(order).toEqual(['frame', 'next frame', 'timer']);
});

test('a frame cancelled before it runs never runs and holds up nothing', async () => {
    let ran = false;
    await withBrowserFrames(async () => {
        cancelAnimationFrame(
            requestAnimationFrame(() => {
                ran = true;
            }),
        );
    });
    expect(ran).toBe(false);
});

test('a frame that asks for itself forever fails the wait and puts the real frame functions back', async () => {
    const { requestAnimationFrame: request, cancelAnimationFrame: cancel } = globalThis;
    const again = () => {
        requestAnimationFrame(again);
    };
    await expect(withBrowserFrames(async () => again())).rejects.toThrow('frames never settled');
    expect(globalThis.requestAnimationFrame).toBe(request);
    expect(globalThis.cancelAnimationFrame).toBe(cancel);
});
