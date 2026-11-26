// A click away from a page with something at risk waits on "Discard changes?", the question a form asks before a close
// drops what was typed. Once nothing is at risk while it asks, such as after a save landed or the page went away, the
// click goes on by itself instead of being dropped. A navigation that passes ignoreBlocker, as a save's own does, goes
// at once. A search-only change asks too, as Admin's ?userId= switch must, but the editors' unsynced-edits guard lets
// one through, since the editor stays mounted and nothing is lost.
import { expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const { act, createElement, useState } = await import('react');
const router = await import('@tanstack/react-router');
const { LeaveGuard } = await import('../../../../components/layout/app/leave-guard');
const { UnsyncedEditsGuard } = await import('../../../../components/layout/app/unsynced-edits-guard');

let setActive: (active: boolean) => void = () => {};
let setShown: (shown: boolean) => void = () => {};

// The guard on a page at /, where something is at risk from the start, and a page at /elsewhere to leave for.
let guard: typeof LeaveGuard = LeaveGuard;
function GuardedPage(): ReactNode {
    const [active, setActiveState] = useState(true);
    const [shown, setShownState] = useState(true);
    setActive = setActiveState;
    setShown = setShownState;
    return shown ? createElement(guard, { active }) : null;
}

async function openPage({ ignoreBlocker = false, to = '/elsewhere', with: Guard = LeaveGuard } = {}) {
    guard = Guard;
    const root = router.createRootRoute({ component: router.Outlet });
    const here = router.createRoute({
        getParentRoute: () => root,
        path: '/',
        validateSearch: (search: Record<string, unknown>): { chat?: string } =>
            typeof search.chat === 'string' ? { chat: search.chat } : {},
        component: GuardedPage,
    });
    const elsewhere = router.createRoute({ getParentRoute: () => root, path: '/elsewhere', component: () => 'Away' });
    const memory = router.createRouter({
        routeTree: root.addChildren([here, elsewhere]),
        history: router.createMemoryHistory({ initialEntries: ['/'] }),
    });
    await memory.load();
    await renderInDocument(createElement(router.RouterProvider, { router: memory }));
    await act(async () => {
        memory.navigate({ to, ignoreBlocker });
    });
    return () => memory.state.location.href;
}

const asking = () => document.body.textContent?.includes('Discard changes?') ?? false;

test('a click away waits on the question while something is at risk', async () => {
    const at = await openPage();
    expect(asking()).toBe(true);
    expect(at()).toBe('/');
    const question = document.querySelector('[role="dialog"]');
    expect(question?.textContent).toContain('What you changed is not saved.');
    const labels = [...(question?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Keep editing', 'Discard']));
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

test('a navigation that passes ignoreBlocker goes at once', async () => {
    const at = await openPage({ ignoreBlocker: true });
    expect(asking()).toBe(false);
    expect(at()).toBe('/elsewhere');
});

test("a search-only change waits on the question too, as a page form's draft stays with its page", async () => {
    const at = await openPage({ to: '/?chat=thread.eigenchat' });
    expect(asking()).toBe(true);
    expect(at()).toBe('/');
});

test('the unsynced-edits guard lets a search-only change through, and still asks before the page goes', async () => {
    const stays = await openPage({ to: '/?chat=thread.eigenchat', with: UnsyncedEditsGuard });
    expect(document.body.textContent).not.toContain('Leave without syncing?');
    expect(stays()).toBe('/?chat=thread.eigenchat');

    const leaves = await openPage({ with: UnsyncedEditsGuard });
    expect(document.body.textContent).toContain('Leave without syncing?');
    expect(leaves()).toBe('/');
});
