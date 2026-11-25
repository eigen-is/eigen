// A click away from a page with something at risk waits on "Leave without saving?". Once nothing is at risk while it
// asks, such as after a save landed or the page went away, the click goes on by itself instead of being dropped.
import { expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const router = await import('@tanstack/react-router');
const { LeaveGuard } = await import('../../../../components/layout/app/leave-guard');

let setActive: (active: boolean) => void = () => {};
let setShown: (shown: boolean) => void = () => {};

// The guard on a page at /, where something is at risk from the start, and a page at /elsewhere to leave for.
function GuardedPage(): ReactNode {
    const [active, setActiveState] = useState(true);
    const [shown, setShownState] = useState(true);
    setActive = setActiveState;
    setShown = setShownState;
    return shown
        ? createElement(LeaveGuard, { active, title: 'Leave without saving?', description: 'It is not saved.' })
        : null;
}

async function openPage() {
    const root = router.createRootRoute({ component: router.Outlet });
    const here = router.createRoute({ getParentRoute: () => root, path: '/', component: GuardedPage });
    const elsewhere = router.createRoute({ getParentRoute: () => root, path: '/elsewhere', component: () => 'Away' });
    const memory = router.createRouter({
        routeTree: root.addChildren([here, elsewhere]),
        history: router.createMemoryHistory({ initialEntries: ['/'] }),
    });
    await memory.load();
    await renderInDocument(createElement(router.RouterProvider, { router: memory }));
    await act(async () => {
        memory.navigate({ to: '/elsewhere' });
    });
    return () => memory.state.location.pathname;
}

const asking = () => document.body.textContent?.includes('Leave without saving?') ?? false;

test('a click away waits on the question while something is at risk', async () => {
    const at = await openPage();
    expect(asking()).toBe(true);
    expect(at()).toBe('/');
});

test('the click goes on once nothing is at risk while the question is open', async () => {
    const at = await openPage();
    await act(async () => setActive(false));
    expect(at()).toBe('/elsewhere');
});

test('the click goes on once the guard goes away while the question is open', async () => {
    const at = await openPage();
    await act(async () => setShown(false));
    expect(at()).toBe('/elsewhere');
});
