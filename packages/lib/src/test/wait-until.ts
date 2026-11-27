// Waits until what a test reads holds, for work that lands after a promise chain or a timer in the product rather than
// after a frame, such as an upload's answer or a panel's debounced read. React draws after every turn. Past the deadline
// the wait fails with what it waited for, so a broken change reads as a failure, not as a test that timed out.

const DEADLINE_MS = 2_000;

export async function waitUntil(holds: () => boolean, what: string): Promise<void> {
    // React loads only now, after the test installed happy-dom.
    const { act } = await import('react');
    const deadline = performance.now() + DEADLINE_MS;
    while (!holds()) {
        if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await act(() => new Promise((resolve) => setTimeout(resolve)));
    }
}
