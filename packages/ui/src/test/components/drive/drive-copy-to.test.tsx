// When Copy to… copies only part of a selection, the picker stays open, and confirming again copies only
// the items that failed, so the ones that copied don't land twice.
import { afterEach, expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const session = { user: { id: 'user-1', email: 'editor@example.com' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
mock.module('../../../components/drive/drive-location-field', () => ({ DriveLocationField: () => null }));

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

// The source ids the copy route was asked for, in order. The source `bad` always fails.
const posted: string[] = [];
g.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    const sourceId = /\/path\/([^/]+)\/copy$/.exec(url)?.[1];
    if (!sourceId) return Response.json([]);
    posted.push(sourceId);
    if (sourceId === 'bad') return new Response('Server error', { status: 500 });
    return Response.json(drivePath({ id: `copy-of-${sourceId}`, name: 'copy.txt', mimeType: 'text/plain' }));
};

const { act, createElement } = await import('react');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { CommandPaletteProvider } = await import(
    '../../../components/layout/app/command-palette/command-palette-provider'
);
const { DRIVE_CAPABILITIES } = await import('../../../components/drive/drive-capabilities');
const { useDriveActionRunner } = await import('../../../components/drive/drive-action-runner');

let unmount = async () => {};
afterEach(() => unmount());

const items = ['good', 'bad'].map((id) =>
    drivePath({ id, name: `${id}.txt`, mimeType: 'text/plain', ownerId: 'user-1', parentId: 'root' }),
);

let run: (items: DrivePath[]) => void = () => {};

function Probe() {
    const runner = useDriveActionRunner({
        ownerId: 'user-1',
        mountId: 'default',
        currentPath: null,
        capabilities: DRIVE_CAPABILITIES.browse,
        onOpen: () => {},
    });
    run = (items) => runner.run('copy-to', items);
    return runner.dialogs;
}

async function copyHere() {
    const button = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Copy here');
    if (!button) throw new Error('no copy button');
    await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
}

test('confirming again after a partial failure copies only the failed item', async () => {
    const router = createRouter({
        routeTree: createRootRoute({
            component: () => createElement(CommandPaletteProvider, null, createElement(Probe)),
        }),
        history: createMemoryHistory(),
    });
    await router.load();
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));
    await act(async () => run(items));
    await copyHere();
    expect(posted).toEqual(['good', 'bad']);
    posted.length = 0;
    await copyHere();
    expect(posted).toEqual(['bad']);
});
