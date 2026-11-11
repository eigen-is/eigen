// The File menu draws its Rename, Share, Email collaborators and delete rows from the Drive action catalog,
// gated as Drive gates them, and hands the command palette the same rows. A guest may not mail people
// through the server, a reader may not share, and an item shared with the viewer is removed, not trashed.
// Make a copy lands beside the file as Drive's Duplicate does, and greys out where Duplicate would not apply.
import { afterEach, expect, mock, test } from 'bun:test';
import type { PaletteSelectionActions } from '@workspace/lib/types/command-palette';
import type { DrivePath } from '@workspace/lib/types/drive';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

// What the copy route was asked for: the source id and the body.
const copies: { sourceId: string; body: unknown }[] = [];
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const sourceId = /\/path\/([^/]+)\/copy$/.exec(url)?.[1];
    if (!sourceId) return Response.json([]);
    copies.push({ sourceId, body: JSON.parse(String(init?.body)) });
    return Response.json(drivePath({ id: `copy-of-${sourceId}`, name: 'Copy of Plan', mimeType: DRIVE_MIME_DOC }));
};

let isGuest = false;
const session = { user: { id: 'user-1', email: 'editor@example.com' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => isGuest }));

const { act, createElement } = await import('react');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { useCommandPalette } = await import('@workspace/lib/command-palette');
const { DRIVE_MIME_DOC } = await import('@workspace/lib/types/drive');
const { drivePath } = await import('../../../drive-path');
const { CommandPaletteProvider } = await import(
    '../../../../components/layout/app/command-palette/command-palette-provider'
);
const { FileMenu } = await import('../../../../components/layout/toolbar/file-menu');
const { Menubar } = await import('../../../../components/menubar');

let unmount = async () => {};
// Each render unmounts the one before, so a test can open several in turn.
const unmountLast = async () => {
    await unmount();
    unmount = async () => {};
};
afterEach(unmountLast);

const plan = drivePath({ name: 'Plan', mimeType: DRIVE_MIME_DOC, ownerId: 'user-1', parentId: 'root' });
const sharedWithMe = drivePath({
    name: 'Their plan',
    mimeType: DRIVE_MIME_DOC,
    ownerId: 'user-2',
    parentId: 'root',
    acl: [{ id: 'editor@example.com', read: true, write: true }],
});

// Opens the File menu on the item and returns its rows, and the ids of the rows it handed the palette.
async function openFileMenu(path: DrivePath = plan, canWrite = true) {
    await unmountLast();
    const published: { actions: PaletteSelectionActions } = { actions: null };
    function Reader() {
        published.actions = useCommandPalette().selectionActions;
        return null;
    }
    const menu = createElement(FileMenu, {
        path,
        canWrite,
        onAccessDialogOpen: () => {},
        onImport: () => {},
        createLabel: 'New doc',
        createType: 'doc',
    });
    const router = createRouter({
        routeTree: createRootRoute({
            component: () =>
                createElement(CommandPaletteProvider, null, createElement(Menubar, null, menu), createElement(Reader)),
        }),
        history: createMemoryHistory(),
    });
    await router.load();
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));

    const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent === 'File',
    );
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    const items = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')];
    const rows = items.map((item) => item.textContent?.trim());
    const disabled = items.filter((item) => item.hasAttribute('data-disabled')).map((item) => item.textContent?.trim());
    return { rows, disabled, palette: (published.actions ?? []).map(({ action }) => action.id) };
}

test('an editor can email the collaborators of an item someone else can see', async () => {
    isGuest = false;
    expect((await openFileMenu(sharedWithMe)).rows).toContain('Email collaborators');
});

test('a guest editor can not', async () => {
    isGuest = true;
    const { rows } = await openFileMenu(sharedWithMe);
    expect(rows).toContain('Rename');
    expect(rows).not.toContain('Email collaborators');
});

test('a private item has no collaborators to mail', async () => {
    isGuest = false;
    expect((await openFileMenu(plan)).rows).not.toContain('Email collaborators');
});

test('an item shared with the viewer is removed, not trashed', async () => {
    isGuest = false;
    const { rows } = await openFileMenu(sharedWithMe);
    expect(rows).toContain('Remove shared item');
    expect(rows).not.toContain('Move to trash');
    expect((await openFileMenu(plan)).rows).toContain('Move to trash');
});

test('a reader may not share, rename or delete', async () => {
    isGuest = false;
    const { rows } = await openFileMenu(plan, false);
    expect(rows).not.toContain('Share');
    expect(rows).not.toContain('Rename');
    expect(rows).not.toContain('Move to trash');
    expect((await openFileMenu(plan, true)).rows).toContain('Share');
});

test('the palette gets the rows the menu draws, plus the link and the mail', async () => {
    isGuest = false;
    expect((await openFileMenu(plan)).palette).toEqual(['rename', 'share', 'copy-link', 'mail-to', 'trash']);
    expect((await openFileMenu(plan, false)).palette).toEqual(['copy-link', 'mail-to']);
});

test('Make a copy follows Import, in the group that makes and opens files', async () => {
    isGuest = false;
    const { rows } = await openFileMenu(plan);
    expect(rows.slice(0, 4)).toEqual(['New doc', 'Open…', 'Import…', 'Make a copy']);
});

test('Make a copy shows greyed out for a reader and for an item shared with the viewer', async () => {
    isGuest = false;
    expect((await openFileMenu(plan)).disabled).not.toContain('Make a copy');
    for (const { rows, disabled } of [await openFileMenu(plan, false), await openFileMenu(sharedWithMe)]) {
        expect(rows).toContain('Make a copy');
        expect(disabled).toContain('Make a copy');
    }
});

test('Make a copy copies the file beside itself as "Copy of" its name', async () => {
    isGuest = false;
    copies.length = 0;
    await openFileMenu(plan);
    const row = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find(
        (item) => item.textContent?.trim() === 'Make a copy',
    );
    await act(async () => row?.click());
    expect(copies).toEqual([
        {
            sourceId: plan.id,
            body: { targetOwnerId: 'user-1', targetMountId: 'default', targetParentId: 'root', name: 'Copy of Plan' },
        },
    ]);
});
