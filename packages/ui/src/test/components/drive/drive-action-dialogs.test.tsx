// A dialog the Drive action runner opens for a set of items keeps those items while it closes: the delete dialog
// still names how many it moves to trash, never "0 items", and Email collaborators fades out like the others
// instead of vanishing at once.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { DriveActionId } from '@workspace/lib/types/drive-actions';
import { closingDialog, holdClosingDialogs } from '../../closing-dialog';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const session = { user: { id: 'user-1', email: 'editor@example.com' } };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realMedia = { ...(await import('@workspace/lib/media')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
// On touch a delete asks first, which is what opens the dialog here.
mock.module('@workspace/lib/media', () => ({ ...realMedia, useIsCoarsePointer: () => true }));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/media', () => realMedia);
});

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
// The path ids the delete route was asked for, in order. The server refuses `bad`.
const deleted: string[] = [];
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const id = /\/path\/([^/]+)$/.exec(url)?.[1];
    if (!id || init?.method !== 'DELETE') return Response.json([]);
    deleted.push(id);
    return id === 'bad' ? new Response('No access', { status: 403 }) : Response.json({ success: true });
};

const { act, createElement } = await import('react');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { CommandPaletteProvider } = await import(
    '../../../components/layout/app/command-palette/command-palette-provider'
);
const { DRIVE_CAPABILITIES } = await import('../../../components/drive/drive-capabilities');
const { UploadProvider } = await import('../../../components/upload-provider/upload-provider');
const { useDriveActionRunner } = await import('../../../components/drive/drive-action-runner');

let unmount = async () => {};
let release = () => {};
afterEach(async () => {
    await unmount();
    release();
});

const files = ['a', 'b', 'c'].map((id) =>
    drivePath({ id, name: `${id}.txt`, mimeType: 'text/plain', ownerId: 'user-1', parentId: 'root' }),
);
const sharedDoc = drivePath({
    name: 'Plan.eigendoc',
    mimeType: 'application/eigendoc',
    type: 'doc',
    ownerId: 'user-1',
    parentId: 'root',
    acl: [{ id: 'friend@example.com', read: true, write: true }],
});

let run: (id: DriveActionId, items: DrivePath[]) => void = () => {};

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

async function openDialogOf(id: DriveActionId, items: DrivePath[]) {
    release = holdClosingDialogs();
    const router = createRouter({
        routeTree: createRootRoute({
            component: () =>
                createElement(UploadProvider, null, createElement(CommandPaletteProvider, null, createElement(Probe))),
        }),
        history: createMemoryHistory(),
    });
    await router.load();
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));
    await act(async () => run(id, items));
}

async function click(label: string) {
    const button = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === label);
    if (!button) throw new Error(`no ${label} button`);
    await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

// Runs the action, cancels the dialog it opens, and returns that dialog as it fades out.
async function cancelDialogOf(id: DriveActionId, items: DrivePath[]) {
    await openDialogOf(id, items);
    await click('Cancel');
    return closingDialog();
}

test('the delete dialog keeps its count and its text while it closes', async () => {
    const dialog = await cancelDialogOf('trash', files);
    expect(dialog?.querySelector('h2')?.textContent).toBe('Move 3 items to trash');
    expect(dialog?.querySelector('p')?.textContent).toStartWith('This will move 3 items to trash.');
});

test('after a partial failure the delete dialog asks about the failed item, again and while it closes', async () => {
    const items = ['good', 'bad', 'other'].map((id) =>
        drivePath({ id, name: `${id}.txt`, mimeType: 'text/plain', ownerId: 'user-1', parentId: 'root' }),
    );
    await openDialogOf('trash', items);
    deleted.length = 0;
    await click('Move to trash');
    expect(deleted).toEqual(['good', 'bad', 'other']);
    deleted.length = 0;
    await click('Move to trash');
    expect(deleted).toEqual(['bad']);
    await click('Cancel');
    expect(closingDialog()?.querySelector('h2')?.textContent).toBe('Move to trash');
});

test('Email collaborators stays mounted while it closes', async () => {
    const dialog = await cancelDialogOf('email-collaborators', [sharedDoc]);
    expect(dialog?.querySelector('h2')?.textContent).toBe('Email collaborators');
});
