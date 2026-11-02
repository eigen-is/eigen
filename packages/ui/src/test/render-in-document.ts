// Renders a component tree under a fresh QueryClient into a container in the document. Call `installHappyDom()`
// first: it loads React and react-dom once the DOM globals are in place, and after each test it unmounts every root
// rendered here, so a test that timed out mid-render leaves no dialog behind for the next one.
import type { ReactElement, act as reactAct } from 'react';
import type { Root } from 'react-dom/client';

// Each live root's unmount. A root joins the moment renderInDocument is called, so one whose test ended mid-render is
// still here, and one whose test ended before React loaded never renders.
const liveRoots = new Set<() => Promise<void>>();

export async function renderInDocument(
    element: ReactElement,
): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
    const container = document.createElement('div');
    let mounted: { root: Root; act: typeof reactAct } | undefined;
    // A second call, such as the test's own afterEach after unmountAllRoots, does nothing.
    const unmount = async () => {
        if (!liveRoots.delete(unmount)) return;
        if (mounted) {
            const { root, act } = mounted;
            await act(async () => root.unmount());
        }
        container.remove();
    };
    liveRoots.add(unmount);

    const [{ QueryClient, QueryClientProvider }, { act, createElement }, { createRoot }] = await loadReact();
    // Its test ended while React loaded.
    if (!liveRoots.has(unmount)) return { container, unmount };
    document.body.append(container);
    const root = createRoot(container);
    mounted = { root, act };
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client: new QueryClient() }, element));
    });
    return { container, unmount };
}

// installHappyDom calls this as soon as the globals are in place, so the first test doesn't pay for these imports
// inside its timeout. Later calls get the loaded modules.
export const loadReact = () =>
    Promise.all([import('@tanstack/react-query'), import('react'), import('react-dom/client')]);

// installHappyDom runs this after each test. It leaves the rest of the body alone: a test with roots of its own unmounts
// them after this, and React can't unmount a portal that was taken out from under it.
export async function unmountAllRoots(): Promise<void> {
    for (const unmount of [...liveRoots]) await unmount();
}
