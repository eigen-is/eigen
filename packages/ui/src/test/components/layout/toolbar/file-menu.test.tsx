// The File menu draws its Rename, Share, Email collaborators and delete rows from the Drive action catalog,
// gated as Drive gates them, and hands the command palette the same rows. A guest may not mail people
// through the server, a reader may not share, and an item shared with the viewer is removed, not trashed.
// Make a copy lands beside the file as Drive's Duplicate does, and greys out where Duplicate would not apply.
// Open recent lists the viewer's recent files of the app's own kind, without the open one. A visitor without a login
// keeps only the editor's own rows, such as Print, and no File menu when the editor has none.
import { afterEach, expect, mock, test } from 'bun:test';
import type { PaletteSelectionActions } from '@workspace/lib/types/command-palette';
import type { DrivePath } from '@workspace/lib/types/drive';
import { installHappyDom } from '../../../happy-dom';
import { openSubmenu } from '../../../menu-rows';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

// What the copy route was asked for: the source id and the body.
const copies: { sourceId: string; body: unknown }[] = [];
// What the recent route answers, newest first.
let recent: DrivePath[] = [];
g.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (/\/recent(\?|$)/.test(url)) return Response.json(recent);
    const sourceId = /\/path\/([^/]+)\/copy$/.exec(url)?.[1];
    if (!sourceId) return Response.json([]);
    copies.push({ sourceId, body: JSON.parse(String(init?.body)) });
    return Response.json(drivePath({ id: `copy-of-${sourceId}`, name: 'Copy of Plan', mimeType: DRIVE_MIME_DOC }));
};

let isGuest = false;
const EDITOR = { id: 'user-1', email: 'editor@example.com' };
const session: { user: typeof EDITOR | null } = { user: EDITOR };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => isGuest }));

const { act, createElement } = await import('react');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { DropdownMenuItem } = await import('../../../../components/dropdown-menu');
const { useCommandPalette } = await import('@workspace/lib/command-palette');
const { DRIVE_MIME_DOC, DRIVE_MIME_SHEETS } = await import('@workspace/lib/types/drive');
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
afterEach(async () => {
    await unmountLast();
    session.user = EDITOR;
});

const plan = drivePath({ name: 'Plan', mimeType: DRIVE_MIME_DOC, ownerId: 'user-1', parentId: 'root' });
const sharedWithMe = drivePath({
    name: 'Their plan',
    mimeType: DRIVE_MIME_DOC,
    ownerId: 'user-2',
    parentId: 'root',
    acl: [{ id: 'editor@example.com', read: true, write: true }],
});

// Opens the File menu on the item and returns its rows, and the ids of the rows it handed the palette.
async function openFileMenu(path: DrivePath = plan, canWrite = true, editorRows?: string[]) {
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
        onExport: () => {},
        createLabel: 'New doc',
        createType: 'doc',
        children: editorRows?.map((row) => createElement(DropdownMenuItem, { key: row }, row)),
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
    // Lets the recent list arrive.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
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
    expect(rows.slice(0, 5)).toEqual(['New doc', 'Open…', 'Open recent', 'Import…', 'Make a copy']);
});

test('Open recent lists the recent docs without the open one, and no sheet', async () => {
    isGuest = false;
    recent = [
        plan,
        drivePath({ id: 'budget', name: 'Budget', mimeType: DRIVE_MIME_SHEETS }),
        drivePath({ id: 'notes', name: 'Notes.eigendoc', mimeType: DRIVE_MIME_DOC }),
        drivePath({ id: 'memo', name: 'Memo.eigendoc', mimeType: DRIVE_MIME_DOC }),
    ];
    expect((await openFileMenu(plan)).disabled).not.toContain('Open recent');
    await openSubmenu('Open recent');
    const submenu = [...document.querySelectorAll('[role="menu"]')].at(-1);
    const rows = [...(submenu?.querySelectorAll('[role="menuitem"]') ?? [])].map((row) => row.textContent?.trim());
    expect(rows).toEqual(['Notes', 'Memo']);
});

test('Open recent greys out with no other doc to list, and a guest has none', async () => {
    isGuest = false;
    recent = [plan];
    expect((await openFileMenu(plan)).disabled).toContain('Open recent');
    isGuest = true;
    expect((await openFileMenu(plan)).rows).not.toContain('Open recent');
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

test('a visitor keeps only the editor rows, such as Print, and no Download, copy or version history', async () => {
    session.user = null;
    const { rows, palette } = await openFileMenu(plan, false, ['Page setup…', 'Print']);
    expect(rows).toEqual(['Page setup…', 'Print']);
    expect(palette).toEqual([]);
});

test('a visitor gets no File menu where the editor has no rows of its own', async () => {
    session.user = null;
    await openFileMenu(plan, false);
    const trigger = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent === 'File',
    );
    expect(trigger).toBeUndefined();
});

test('a reader keeps Download and the rows around the editor rows', async () => {
    const { rows } = await openFileMenu(plan, false, ['Print']);
    expect(rows).toContain('Download');
    expect(rows).toContain('New doc');
    expect(rows).toContain('Print');
});
