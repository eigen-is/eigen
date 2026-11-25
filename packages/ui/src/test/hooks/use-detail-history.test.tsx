// A detail its URL names opens with a push, so back closes it, and a switch to another item replaces that entry. Close
// goes back when the entry is the detail's own push and replaces otherwise, as on a deep link, so back after a close
// never reopens the item.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '../happy-dom';
import { renderInDocument } from '../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const router = await import('@tanstack/react-router');
const { useDetailHistory } = await import('../../hooks/use-detail-history');

type Detail = ReturnType<typeof useDetailHistory<string>>;
type History = ReturnType<typeof router.createMemoryHistory>;

let detail: Detail | undefined;
let unmount = async () => {};
afterEach(() => unmount());

// A page at / whose ?item= names the open detail, as a host route's own param.
function Page() {
    const { item } = router.useSearch({ strict: false });
    const navigate = router.useNavigate();
    detail = useDetailHistory(item, (next, { replace, state }) =>
        navigate({ to: '/', search: { item: next }, replace, state }),
    );
    return item ?? 'closed';
}

async function openPage(history: History) {
    const root = router.createRootRoute({ component: router.Outlet });
    const page = router.createRoute({
        getParentRoute: () => root,
        path: '/',
        validateSearch: (search: Record<string, unknown>): { item?: string } =>
            typeof search.item === 'string' ? { item: search.item } : {},
        component: Page,
    });
    const memory = router.createRouter({ routeTree: root.addChildren([page]), history });
    await memory.load();
    const rendered = await renderInDocument(createElement(router.RouterProvider, { router: memory }));
    unmount = rendered.unmount;
    return {
        shown: () => rendered.container.textContent,
        index: () => history.location.state.__TSR_index,
        pushed: () => 'detailPush' in history.location.state,
    };
}

async function run(action: (detail: Detail) => void) {
    await act(async () => {
        if (detail) action(detail);
    });
    // A back settles on the history's next tick, then the router loads the entry it lands on.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
}

test('opening from closed pushes an entry that carries the flag', async () => {
    const page = await openPage(router.createMemoryHistory({ initialEntries: ['/'] }));
    await run((d) => d.open('a'));
    expect(page.shown()).toBe('a');
    expect(page.index()).toBe(1);
    expect(page.pushed()).toBe(true);
});

test('a switch replaces the entry and keeps its flag', async () => {
    const page = await openPage(router.createMemoryHistory({ initialEntries: ['/'] }));
    await run((d) => d.open('a'));
    await run((d) => d.open('b'));
    expect(page.shown()).toBe('b');
    expect(page.index()).toBe(1);
    expect(page.pushed()).toBe(true);
});

test('close after its own push goes back', async () => {
    const page = await openPage(router.createMemoryHistory({ initialEntries: ['/'] }));
    await run((d) => d.open('a'));
    await run((d) => d.open('b'));
    await run((d) => d.close());
    expect(page.shown()).toBe('closed');
    expect(page.index()).toBe(0);
});

test('close on a deep link replaces, and back after it does not reopen the item', async () => {
    const history = router.createMemoryHistory({ initialEntries: ['/', '/?item=a'] });
    const page = await openPage(history);
    expect(page.shown()).toBe('a');
    await run((d) => d.close());
    expect(page.shown()).toBe('closed');
    expect(page.index()).toBe(1);
    await run(() => history.back());
    expect(page.index()).toBe(0);
    expect(page.shown()).toBe('closed');
});

test('on a browser history, close after its own push goes back', async () => {
    const page = await openPage(router.createBrowserHistory());
    const start = page.index();
    await run((d) => d.open('a'));
    expect(window.location.search).toBe('?item=a');
    expect(page.index()).toBe(start + 1);
    await run((d) => d.close());
    expect(window.location.search).toBe('');
    expect(page.index()).toBe(start);
    expect(page.shown()).toBe('closed');
});
