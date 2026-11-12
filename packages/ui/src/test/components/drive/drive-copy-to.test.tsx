// When Copy to… or Move to… gets only part of a selection through, the picker stays open, and confirming
// again sends only the items that failed, so a copy doesn't land twice and a moved item isn't moved again.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const session = { user: { id: 'user-1', email: 'editor@example.com' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
// A copy, because mock.module rewrites the loaded module in place, and afterAll puts the original back for the
// field's own test.
const realLocationField = { ...(await import('../../../components/drive/drive-location-field')) };
mock.module('../../../components/drive/drive-location-field', () => ({ DriveLocationField: () => null }));
afterAll(() => mock.module('../../../components/drive/drive-location-field', () => realLocationField));

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

// The source ids the copy or move route was asked for, in order. The source `bad` always fails.
const posted: string[] = [];
g.fetch = async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    const sourceId = /\/path\/([^/]+)\/(?:copy|move)$/.exec(url)?.[1];
    if (!sourceId) return Response.json([]);
    posted.push(sourceId);
    if (sourceId === 'bad') return new Response('No access', { status: 403 });
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

const items = ['good', 'bad', 'other'].map((id) =>
    drivePath({ id, name: `${id}.txt`, mimeType: 'text/plain', ownerId: 'user-1', parentId: 'root' }),
);

let run: (id: 'copy-to' | 'move-to', items: DrivePath[]) => void = () => {};

function Probe() {
    const runner = useDriveActionRunner({
        ownerId: 'user-1',
        mountId: 'default',
        currentPath: null,
        capabilities: DRIVE_CAPABILITIES.browse,
        onOpen: () => {},
    });
    run = (id, items) => runner.run(id, items);
    return runner.dialogs;
}

async function confirm(label: string) {
    const button = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === label);
    if (!button) throw new Error(`no ${label} button`);
    await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
}

test.each([
    ['copy-to', 'Copy here'],
    ['move-to', 'Move here'],
] as const)('%s: confirming again after a partial failure sends only the failed item', async (id, label) => {
    posted.length = 0;
    const router = createRouter({
        routeTree: createRootRoute({
            component: () => createElement(CommandPaletteProvider, null, createElement(Probe)),
        }),
        history: createMemoryHistory(),
    });
    await router.load();
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));
    await act(async () => run(id, items));
    await confirm(label);
    expect(posted).toEqual(['good', 'bad', 'other']);
    posted.length = 0;
    await confirm(label);
    expect(posted).toEqual(['bad']);
});
