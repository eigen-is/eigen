// Renders a component tree under a fresh QueryClient into a container in the document. Call `installHappyDom()`
// first: React and react-dom are imported on the first render, once the DOM globals are in place.
import type { ReactElement } from 'react';

export async function renderInDocument(
    element: ReactElement,
): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { act, createElement } = await import('react');
    const { createRoot } = await import('react-dom/client');

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(createElement(QueryClientProvider, { client: new QueryClient() }, element));
    });
    const unmount = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return { container, unmount };
}
