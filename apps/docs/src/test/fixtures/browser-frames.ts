// Runs a test's action with each animation frame on a timer, as a browser runs a frame after React has drawn and a menu
// has closed, then waits until every frame it asked for has run. happy-dom runs a frame at once, before the change it
// follows has landed, such as Tiptap's refocus after a menu pick. The wait counts frames, not milliseconds, so a machine
// busy with other suites makes it slower but never cuts it short.

import { spyOn } from 'bun:test';
import { act } from 'react';

export async function withBrowserFrames(action: () => Promise<unknown>): Promise<void> {
    let pending = 0;
    let ran = false;
    const frame = spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
        pending++;
        setTimeout(() => {
            pending--;
            ran = true;
            callback(performance.now());
        });
        return 0;
    });
    try {
        await action();
        // A timer that a frame sets fires before the next turn does. So the frames are done, and what they set going
        // too, once a whole turn passes in which no frame ran or waited.
        do {
            ran = false;
            await act(() => new Promise((resolve) => setTimeout(resolve)));
        } while (pending > 0 || ran);
    } finally {
        frame.mockRestore();
    }
}
