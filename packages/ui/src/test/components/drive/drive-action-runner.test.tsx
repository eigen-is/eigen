// A guest may not mail people through the server, so Drive offers Email collaborators on a shared item
// to an editor and hides it from a guest editor. A drop the server refuses ends in its toast, not an
// unhandled rejection.
import { afterEach, expect, mock, test } from 'bun:test';
import type { DriveActionRunner } from '../../../components/drive/drive-action-runner';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

let isGuest = false;
const session = { user: { id: 'user-1', email: 'editor@example.com' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => isGuest }));

const { act, createElement } = await import('react');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { CommandPaletteProvider } = await import(
    '../../../components/layout/app/command-palette/command-palette-provider'
);
const { DRIVE_CAPABILITIES } = await import('../../../components/drive/drive-capabilities');
const { useDriveActionRunner } = await import('../../../components/drive/drive-action-runner');

let unmount = async () => {};
afterEach(() => unmount());

const sharedDoc = drivePath({
    name: 'Plan.eigendoc',
    mimeType: 'application/eigendoc',
    type: 'doc',
    ownerId: 'user-1',
    parentId: 'root',
    acl: [{ id: 'friend@example.com', read: true, write: true }],
});

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
// The move requests sent, by path id. The server refuses every move.
const moves: string[] = [];
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const moved = /\/path\/([^/]+)\/move$/.exec(url)?.[1];
    if (!moved || init?.method !== 'PUT') return Response.json([]);
    moves.push(moved);
    return new Response('No access', { status: 403 });
};

async function renderRunner() {
    const seen: { runner: DriveActionRunner | null } = { runner: null };
    function Probe() {
        seen.runner = useDriveActionRunner({
            ownerId: 'user-1',
            mountId: 'default',
            currentPath: null,
            capabilities: DRIVE_CAPABILITIES.browse,
            onOpen: () => {},
        });
        return null;
    }
    const router = createRouter({
        routeTree: createRootRoute({
            component: () => createElement(CommandPaletteProvider, null, createElement(Probe)),
        }),
        history: createMemoryHistory(),
    });
    await router.load();
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));
    if (!seen.runner) throw new Error('the runner did not render');
    return seen.runner;
}

const offeredIds = async () => (await renderRunner()).actionsFor([sharedDoc]).map((action) => action.id);

test('an editor can email the collaborators', async () => {
    isGuest = false;
    expect(await offeredIds()).toContain('email-collaborators');
});

test('a guest editor can not', async () => {
    isGuest = true;
    expect(await offeredIds()).not.toContain('email-collaborators');
});

test('a drop the server refuses leaves no unhandled rejection', async () => {
    isGuest = false;
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
        const runner = await renderRunner();
        // As a drop does, which keeps nothing onMove returns.
        await act(async () => {
            runner.onMove?.(sharedDoc, 'folder-1');
        });
        // The refusal settles the mutation a few ticks after the response, and an unhandled one is reported a tick later.
        await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
        expect([moves, unhandled]).toEqual([[sharedDoc.id], []]);
    } finally {
        process.off('unhandledRejection', record);
    }
});
