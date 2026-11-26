// The toolbar puts the previous and next arrows after the title, beside the view choice, on a computer and a phone
// alike, so on a phone they sit away from the column's back arrow.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { createElement } = await import('react');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { LayoutContext } = await import('@workspace/ui/components/layout/app');
const { CalendarToolbar } = await import('../../components/calendar-toolbar');

let unmount = async () => {};
afterEach(() => unmount());

// The toolbar's buttons and title in document order, each by its accessible name or text.
async function renderToolbar(isMobile: boolean): Promise<string[]> {
    const toolbar = () =>
        createElement(CalendarToolbar, { mode: 'week', focus: new Date(2026, 10, 26), onCreateEvent: () => {} });
    const router = createRouter({
        routeTree: createRootRoute({ component: toolbar }),
        history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    await router.load();
    const layout = {
        appName: '',
        setAppName: () => {},
        documentTitle: '',
        setDocumentTitle: () => {},
        sidebarOpen: false,
        setSidebarOpen: () => {},
        sidebarColumnShown: false,
        sidebarMode: 'collapsible' as const,
        sidebarHidden: false,
        setSidebarHidden: () => {},
        isMobile,
        isTablet: false,
    };
    const rendered = await renderInDocument(
        createElement(LayoutContext.Provider, { value: layout }, createElement(RouterProvider, { router })),
    );
    unmount = rendered.unmount;
    return [...rendered.container.querySelectorAll('button, .eigen-toolbar-title')].map(
        (element) => element.getAttribute('aria-label') ?? element.textContent ?? '',
    );
}

test('on a computer the arrows follow Today and the title, before the view choice', async () => {
    const order = await renderToolbar(false);
    expect(order[0]).toBe('Today');
    expect(order[1]).toContain('Nov 2026');
    expect(order.slice(2, 4)).toEqual(['Previous week', 'Next week']);
    expect(order.length).toBe(5);
});

test('on a phone the arrows follow the title, beside the view menu', async () => {
    const order = await renderToolbar(true);
    expect(order[0]).toContain('Nov 2026');
    expect(order.slice(1)).toEqual(['Previous week', 'Next week', 'View options']);
});
