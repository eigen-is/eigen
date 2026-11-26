// The toolbar keeps the previous and next arrows before the title on a computer, and on a phone moves them after it,
// beside the view menu, so they sit away from the column's back arrow.
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

test('on a computer the arrows sit between Today and the title', async () => {
    const order = await renderToolbar(false);
    expect(order.slice(0, 3)).toEqual(['Today', 'Previous week', 'Next week']);
    expect(order[3]).toContain('Nov 2026');
});

test('on a phone the arrows follow the title, beside the view menu', async () => {
    const order = await renderToolbar(true);
    expect(order[0]).toContain('Nov 2026');
    expect(order.slice(1)).toEqual(['Previous week', 'Next week', 'View options']);
});
