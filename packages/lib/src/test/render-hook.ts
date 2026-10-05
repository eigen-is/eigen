// One React root for every hook that has to be rendered to be observed. Call `installHappyDom()` first:
// react-dom renders into its document.
import type { QueryClient } from '@tanstack/react-query';

export async function renderHook<T>(
    use: () => T,
    queryClient: QueryClient,
): Promise<{ latest: T; unmount: () => Promise<void> }> {
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { QueryClientProvider } = await import('@tanstack/react-query');

    const seen: { latest: T | null } = { latest: null };
    function Harness() {
        seen.latest = use();
        return null;
    }
    const root = createRoot(document.createElement('div'));
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness, null)));
    });
    // Unmount inside act too: React's scheduler would otherwise run the teardown after the test,
    // when the DOM globals are already gone.
    const unmount = async () => {
        await act(async () => {
            root.unmount();
        });
    };
    return { latest: seen.latest as T, unmount };
}
