// Runs a test's action with each animation frame on a timer, as a browser runs a frame after React has drawn and a menu
// has closed, then waits until every frame it asked for has run. happy-dom runs a frame at once, before the change it
// follows has landed, such as Tiptap's refocus after a menu pick. The wait counts frames, not milliseconds, so a machine
// busy with other suites makes it slower but never cuts it short.

import { spyOn } from 'bun:test';

// A frame that asks for itself again never settles. Past this many turns the wait fails with a reason, before the
// test's own timeout would skip the cleanup that puts the real frame functions back.
const MAX_TURNS = 100;

export async function withBrowserFrames(action: () => Promise<unknown>): Promise<void> {
    // React loads only now, after the test installed happy-dom.
    const { act } = await import('react');
    const pending = new Map<number, ReturnType<typeof setTimeout>>();
    let lastId = 0;
    let ran = false;
    const request = spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
        const id = ++lastId;
        pending.set(
            id,
            setTimeout(() => {
                pending.delete(id);
                ran = true;
                callback(performance.now());
            }),
        );
        return id;
    });
    const cancel = spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => {
        clearTimeout(pending.get(id));
        pending.delete(id);
    });
    try {
        await action();
        // A timer that a frame sets fires before the next turn does. So the frames are done, and what they set going
        // too, once a whole turn passes in which no frame ran or waited.
        let turns = 0;
        do {
            if (++turns > MAX_TURNS) throw new Error('frames never settled');
            ran = false;
            await act(() => new Promise((resolve) => setTimeout(resolve)));
        } while (pending.size > 0 || ran);
    } finally {
        // A frame still waiting would otherwise run after the cleanup. A frame it asks for then goes to happy-dom, which
        // runs it at once, so a frame that asks for itself would recurse until the stack overflows.
        for (const timer of pending.values()) clearTimeout(timer);
        request.mockRestore();
        cancel.mockRestore();
    }
}
