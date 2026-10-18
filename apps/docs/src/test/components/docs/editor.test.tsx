// Headers and footers are edited in place, as in Google Docs: a writer on a desktop or a tablet double-clicks a margin,
// or picks Insert › Page elements, Format › Headers and footers or a page-number preset, and the caret goes into the
// band on the page. While a band is edited the toolbar and the menus act on it, the body dims and stays editable, and
// Esc or a click in the body leaves. A viewer and a phone see the bands read-only, with no way in.
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { TiptapEditorHTMLElement } from '@tiptap/core';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import type { BandRoot } from '@workspace/lib/docs/eigendoc';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

const window = installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, useState } = await import('react');
const { formatForDisplay } = await import('@tanstack/react-hotkeys');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const realAuth = await import('@workspace/lib/auth');
const realCollab = await import('@workspace/lib/collab');
const { BAND_ROOTS, PAGE_ROOT, STYLE_ROOT } = await import('@workspace/lib/docs/eigendoc');
const { DRIVE_MIME_DOC } = await import('@workspace/lib/types/drive');
const { CommandPaletteProvider } = await import('@workspace/ui');
const { LayoutContext } = await import('@workspace/ui/components/layout/app/layout-context');
const { PreviewProvider } = await import('@workspace/ui/components/preview-provider');
const { drivePath } = await import('@workspace/ui/test/drive-path');

let doc = new Y.Doc();
let provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
// A synced doc, with no server behind it, fresh for each test.
mock.module('@workspace/lib/collab', () => ({
    ...realCollab,
    useCollabDoc: () => ({
        doc,
        provider,
        offline: false,
        loaded: true,
        storageUnavailable: false,
        storageGone: false,
        unsyncedEdits: false,
    }),
}));
// A writer signed in, without the session check.
const auth = {
    isAuthenticated: true,
    isLoading: false,
    user: {
        id: 'u1',
        name: 'Ada',
        email: 'ada@example.com',
        emailVerified: true,
        createdAt: new Date('2026-09-20T09:00:00Z'),
        updatedAt: new Date('2026-09-20T09:00:00Z'),
    },
    login: async () => ({ success: true }),
    logout: async () => {},
};
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => auth }));
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
    mock.module('@workspace/lib/auth', () => realAuth);
    provider.destroy();
});

const { CollaborativeEditor } = await import('../../../components/docs/editor');

const path = drivePath({ name: 'Letter', mimeType: DRIVE_MIME_DOC });

// Every request answers empty, but an upload, which answers when the test lets it.
let finishUpload = (_name: string) => {};
spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method !== 'POST') return Response.json([]);
            const name = await new Promise<string>((resolve) => {
                finishUpload = resolve;
            });
            return Response.json([{ ...path, id: name, name, parentId: 'media', mimeType: 'image/png' }]);
        },
        { preconnect: fetch.preconnect },
    ),
);

beforeEach(() => {
    provider.destroy();
    doc = new Y.Doc();
    provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
});

let unmount = async () => {};
afterEach(() => unmount());

let setCanWrite = (_canWrite: boolean) => {};

const WRITER = { canWrite: true, isMobile: false };

async function render({
    canWrite,
    isMobile,
    mediaFolderId = null,
}: {
    canWrite: boolean;
    isMobile: boolean;
    mediaFolderId?: string | null;
}) {
    window.happyDOM.setViewport({ width: 1920, height: 1000 });
    function Editor() {
        const [writer, setWriter] = useState(canWrite);
        setCanWrite = setWriter;
        return createElement(CollaborativeEditor, {
            path,
            canWrite: writer,
            mediaFolderId,
            chatFolderId: null,
            onAccessDialogOpen: () => {},
        });
    }
    const router = createRouter({
        routeTree: createRootRoute({
            component: () =>
                createElement(
                    LayoutContext,
                    { value: { ...LAYOUT, isMobile } },
                    createElement(
                        PreviewProvider,
                        null,
                        createElement(CommandPaletteProvider, null, createElement(Editor)),
                    ),
                ),
        }),
        history: createMemoryHistory(),
    });
    await router.load();
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));
    await frames();
}

const LAYOUT = {
    appName: 'Docs',
    setAppName: () => {},
    documentTitle: '',
    setDocumentTitle: () => {},
    sidebarOpen: false,
    setSidebarOpen: () => {},
    sidebarColumnShown: false,
    sidebarMode: 'none' as const,
    sidebarHidden: true,
    setSidebarHidden: () => {},
    isMobile: false,
    isTablet: false,
};

// Tiptap puts the caret in an editor a frame after its command.
const frames = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

// An action, with Tiptap's frame run as a browser runs it: after React has drawn what the action changed. happy-dom runs
// a frame before act lets React draw, when the band the caret goes to is not editable yet.
async function inBrowserFrames(action: () => void) {
    const frame = spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
        setTimeout(() => callback(performance.now()));
        return 0;
    });
    try {
        await act(async () => action());
        await frames();
    } finally {
        frame.mockRestore();
    }
}

function write(root: string, text: string, attributes: Record<string, unknown> = {}) {
    const paragraph = new Y.XmlElement('paragraph');
    const run = new Y.XmlText();
    run.insert(0, text, attributes);
    paragraph.insert(0, [run]);
    doc.getXmlFragment(root).insert(doc.getXmlFragment(root).length, [paragraph]);
}

const margin = (edge: 'header' | 'footer') => document.querySelector<HTMLElement>(`[data-page-margin="${edge}"]`);
const band = (root: BandRoot) => document.querySelector<HTMLElement>(`[data-page-band="${root}"]`);
const bandView = (root: BandRoot) =>
    document.querySelector<TiptapEditorHTMLElement>(`[data-page-band="${root}"] .ProseMirror`);
const bodyView = () => document.querySelector<TiptapEditorHTMLElement>('.tiptap-wrapper .ProseMirror');

// The bands that take the caret now.
const editing = () => BAND_ROOTS.filter((root) => bandView(root)?.getAttribute('contenteditable') === 'true');

// The labels on a margin's dashed rules, top to bottom.
const labels = (edge: 'header' | 'footer') =>
    [...(margin(edge)?.querySelectorAll('[data-band-label]') ?? [])].map((label) => label.textContent);

const doubleClick = (edge: 'header' | 'footer') =>
    inBrowserFrames(() => margin(edge)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));

const pressEscape = (target: Element | null) =>
    inBrowserFrames(() => target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

const clickCheckbox = () => inBrowserFrames(() => document.querySelector<HTMLElement>('[role="checkbox"]')?.click());

const menuTrigger = (label: string) =>
    [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(
        (button) => button.textContent === label || button.getAttribute('aria-label') === label,
    );

async function openMenu(label: string) {
    const trigger = menuTrigger(label);
    await act(async () => {
        trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    });
}

const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim());

async function openSubmenu(label: string) {
    const trigger = [...document.querySelectorAll('[role="menuitem"]')].find(
        (item) => item.textContent?.trim() === label,
    );
    await act(async () => {
        trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });
}

// A browser runs the frame after the menu closed and before it unmounts.
const pick = (label: string) =>
    inBrowserFrames(() =>
        [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
            .find((entry) => entry.textContent?.trim() === label)
            ?.click(),
    );

const button = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('button')].find(
        (b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label,
    );

test('a double-click in the top margin edits the header in place, and one in the bottom margin the footer', async () => {
    await render(WRITER);
    expect(editing()).toEqual([]);

    await doubleClick('header');
    expect(editing()).toEqual(['header']);
    expect(document.activeElement === bandView('header')).toBe(true);
    expect(labels('header')).toEqual(['Header']);

    await doubleClick('footer');
    expect(editing()).toEqual(['footer']);
    expect(document.activeElement === bandView('footer')).toBe(true);
    expect([labels('header'), labels('footer')]).toEqual([[], ['Footer']]);
});

test('a single click in a margin enters nothing', async () => {
    write('header', 'Acme');
    await render(WRITER);
    await act(async () => band('header')?.querySelector('p')?.click());
    await act(async () => margin('footer')?.click());
    expect(editing()).toEqual([]);
});

test('a band with content shows on the page in full, read-only; an empty one takes no room', async () => {
    write('footer', 'Acme');
    await render(WRITER);
    expect([band('header')?.hidden, band('footer')?.hidden]).toEqual([true, false]);
    expect(band('footer')?.textContent).toBe('Acme');
    expect(band('footer')?.className).not.toMatch(/opacity/);
});

test('an empty margin tells a writer to double-click; one with a band shows the band instead', async () => {
    write('footer', 'Acme');
    await render(WRITER);
    expect(margin('header')?.textContent).toBe('Double-click to add a header');
    expect(margin('footer')?.textContent).toBe('Acme');
});

test('Insert › Page elements, Format › Headers and footers and a page-number preset edit the band in place', async () => {
    await render(WRITER);
    await openMenu('Insert');
    await openSubmenu('Page elements');
    await pick('Footer');
    expect(editing()).toEqual(['footer']);
    expect(document.activeElement === bandView('footer')).toBe(true);

    await openMenu('Format');
    await pick('Headers and footers');
    expect(editing()).toEqual(['header']);
    expect(document.activeElement === bandView('header')).toBe(true);

    await openMenu('Insert');
    await openSubmenu('Page elements');
    await openSubmenu('Page numbers');
    await pick('In the footer');
    expect(doc.getXmlFragment('footer').toString()).toContain('<pagenumber kind="page">');
    expect(editing()).toEqual(['footer']);
});

test('with Different first page, a preset in the header edits page 1’s header, as a double-click does', async () => {
    doc.getMap(PAGE_ROOT).set('differentFirstPage', true);
    await render(WRITER);
    await openMenu('Insert');
    await openSubmenu('Page elements');
    await openSubmenu('Page numbers');
    await pick('In the header');
    expect(editing()).toEqual(['headerFirst']);
});

test('Esc leaves the band and puts the caret back in the body where it was', async () => {
    write('default', 'Hello world');
    await render(WRITER);
    await act(async () => void bodyView()?.editor?.commands.setTextSelection(4));
    await doubleClick('header');
    expect(editing()).toEqual(['header']);

    await pressEscape(bandView('header'));
    expect(editing()).toEqual([]);
    expect(document.activeElement === bodyView()).toBe(true);
    expect(bodyView()?.editor?.state.selection.from).toBe(4);
});

test('the body stays editable while a band is edited, and a mousedown in it leaves the band', async () => {
    await render(WRITER);
    await doubleClick('header');
    expect(bodyView()?.getAttribute('contenteditable')).toBe('true');

    await act(async () => bodyView()?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(editing()).toEqual([]);
});

// A press that focuses nothing would take the caret out of the band and leave it edited, with Esc and typing reaching
// nothing.
test('a press beside the body and the band keeps the caret in the band', async () => {
    await render(WRITER);
    await doubleClick('header');
    const press = (target: Element | null | undefined) =>
        target?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const page = document.querySelector('[data-document]');
    expect([
        press(page),
        press(page?.parentElement),
        press(margin('header')),
        press(margin('header')?.querySelector('[data-band-label]')),
        press(margin('footer')),
    ]).toEqual([false, false, false, false, false]);
    expect(editing()).toEqual(['header']);
    expect(press(bandView('header')?.querySelector('p'))).toBe(true);
});

test('the dimmed body prints at full strength', async () => {
    await render(WRITER);
    await doubleClick('header');
    expect(document.querySelector('.tiptap-wrapper')?.className).toContain('print:opacity-100');
});

test('a menu closed with Esc hands focus back to the band being edited, and Options to the band too', async () => {
    await render(WRITER);
    await doubleClick('header');
    for (const menu of ['Format', 'Options']) {
        await openMenu(menu);
        await inBrowserFrames(() =>
            document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
        );
        expect(document.activeElement === bandView('header')).toBe(true);
    }
});

test('Options › Page setup… keeps focus in the dialog it opens', async () => {
    await render(WRITER);
    await doubleClick('header');
    await openMenu('Options');
    await pick('Page setup…');
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
});

// Y's undo manager moves the undone step onto the redo stack after the transaction that undid it, so with a step still
// left to undo that transaction changes nothing the menu draws; only a focus or a selection after it redrew the menu.
test('Redo is offered once one of a band’s two edits is undone, focus elsewhere', async () => {
    await render(WRITER);
    await doubleClick('header');
    const header = bandView('header')?.editor;
    if (!header) throw new Error('no header editor');
    await act(async () => void header.commands.insertContent('Acme'));
    yUndoPluginKey.getState(header.state)?.undoManager.stopCapturing();
    await act(async () => void header.commands.insertContent(' Inc'));
    await act(async () => bandView('header')?.blur());
    await act(async () => void header.commands.undo());
    expect(doc.getXmlFragment('header').toString()).toBe('<paragraph>Acme</paragraph>');
    await openMenu('Edit');
    const redo = [...document.querySelectorAll('[role="menuitem"]')].find((item) =>
        item.textContent?.trim().startsWith('Redo'),
    );
    expect(redo?.hasAttribute('data-disabled')).toBe(false);
});

test('⌘F leaves the band: find searches the body', async () => {
    await render(WRITER);
    await doubleClick('header');
    await inBrowserFrames(() => button(`Find in document (${formatForDisplay('Mod+F')})`)?.click());
    expect(editing()).toEqual([]);
});

test('a click on a comment card leaves the band for the comment’s anchor in the body', async () => {
    const stored = new Y.Map<unknown>();
    stored.set('title', 'Check this');
    doc.getMap('comments').set('c1', stored);
    write('default', 'Hello', { comment: { cardId: 'c1' } });
    await render(WRITER);
    await doubleClick('header');
    await act(async () => button('Comments')?.click());
    // The panel lists the anchors the body holds, read 200 ms after its last change.
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    // The card is titled by its anchor's text.
    const card = [...document.querySelectorAll<HTMLElement>('.line-clamp-2')].find(
        (title) => title.textContent === 'Hello',
    );
    expect(card).toBeDefined();
    await act(async () => card?.click());
    expect(editing()).toEqual([]);
});

test('word count from a band counts the body, and gives focus back to the band', async () => {
    write('default', 'one two three');
    write('header', 'Acme');
    await render(WRITER);
    await doubleClick('header');
    await openMenu('Tools');
    await pick(`Word count${formatForDisplay('Mod+Shift+C')}`);
    const words = [...document.querySelectorAll('[role="dialog"] dt')].find((dt) => dt.textContent === 'Words');
    expect(words?.nextElementSibling?.textContent).toBe('3');
    await inBrowserFrames(() => button('OK')?.click());
    expect(document.activeElement === bandView('header')).toBe(true);
});

test('the table panel stays closed while a band is edited', async () => {
    await render(WRITER);
    await act(async () => void bodyView()?.editor?.commands.insertTable({ rows: 2, cols: 2 }));
    expect(document.body.textContent).toContain('Columns');
    await doubleClick('header');
    expect(document.body.textContent).not.toContain('Columns');
});

// The trigger draws the paragraph's alignment, so its first icon names it.
const alignIcon = () => menuTrigger('Align')?.querySelector('svg')?.getAttribute('class');

test('the toolbar, the menus and undo act on the band being edited', async () => {
    write('default', 'Hello');
    write('header', 'Acme', { bold: {} });
    await render(WRITER);
    expect(button(`Bold (${formatForDisplay('Mod+B')})`)?.getAttribute('data-variant')).toBe('ghost');

    await doubleClick('header');
    expect(button(`Bold (${formatForDisplay('Mod+B')})`)?.getAttribute('data-variant')).toBe('secondary');

    await openMenu('Format');
    await openSubmenu('Align and indent');
    await pick('Center');
    expect(doc.getXmlFragment('header').toString()).toContain('textAlign="center"');
    expect(doc.getXmlFragment('default').toString()).not.toContain('textAlign');
    expect(alignIcon()).toMatch(/text-align-center/);

    await openMenu('Edit');
    await pick(`Undo${formatForDisplay('Mod+Z')}`);
    expect(doc.getXmlFragment('header').toString()).not.toContain('textAlign');

    await pressEscape(bandView('header'));
    expect(button(`Bold (${formatForDisplay('Mod+B')})`)?.getAttribute('data-variant')).toBe('ghost');
});

test('in a band, Insert offers no page break, and an image goes into the band and lands there after leaving', async () => {
    await render({ ...WRITER, mediaFolderId: 'media' });
    await openMenu('Insert');
    expect(menuItems()).toContain(`Page break${formatForDisplay('Mod+Enter')}`);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    await doubleClick('header');
    await openMenu('Insert');
    expect(menuItems().filter((item) => item?.startsWith('Page break'))).toEqual([]);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('no image input');
    Object.defineProperty(input, 'files', { value: [new File(['png'], 'logo.png', { type: 'image/png' })] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(doc.getXmlFragment('header').toString()).toContain('mediaName="pending:');
    expect(doc.getXmlFragment('default').toString()).not.toContain('figure');

    await pressEscape(bandView('header'));
    await act(async () => {
        finishUpload('logo-1.png');
        await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(doc.getXmlFragment('header').toString()).toContain('mediaName="logo-1.png"');
});

test('Different first page stacks both headers, keeps what was typed in the other pages’ one and edits the new first page’s', async () => {
    write('header', 'Acme');
    await render(WRITER);
    await doubleClick('header');
    await clickCheckbox();
    expect(doc.getMap(PAGE_ROOT).get('differentFirstPage')).toBe(true);
    expect(doc.getXmlFragment('header').toString()).toBe('<paragraph>Acme</paragraph>');
    expect(editing()).toEqual(['headerFirst']);
    expect(document.activeElement === bandView('headerFirst')).toBe(true);
    expect(labels('header')).toEqual(['First page header', 'Header']);

    await doubleClick('footer');
    expect(editing()).toEqual(['footer']);
    expect(labels('footer')).toEqual(['Footer', 'First page footer']);

    // Off again, the first page's footer goes and the caret stays in the other pages'.
    await clickCheckbox();
    expect(doc.getMap(PAGE_ROOT).get('differentFirstPage')).toBe(false);
    expect([editing(), labels('footer')]).toEqual([['footer'], ['Footer']]);
});

test.each([
    ['header', 'headerFirst', 'header'],
    ['footer', 'footer', 'footerFirst'],
] as const)('with both %ss stacked, a press in either one puts the caret there', async (edge, entered, other) => {
    doc.getMap(PAGE_ROOT).set('differentFirstPage', true);
    await render(WRITER);
    await doubleClick(edge);
    expect(editing()).toEqual([entered]);
    const press = (root: BandRoot) =>
        inBrowserFrames(() =>
            bandView(root)
                ?.querySelector('p')
                ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })),
        );

    await press(other);
    expect(editing()).toEqual([other]);
    expect(document.activeElement === bandView(other)).toBe(true);

    await press(entered);
    expect(editing()).toEqual([entered]);
    expect(document.activeElement === bandView(entered)).toBe(true);
});

test('a collaborator’s untick of Different first page hands page 1’s header over to the other pages’', async () => {
    doc.getMap(PAGE_ROOT).set('differentFirstPage', true);
    await render(WRITER);
    await doubleClick('header');
    expect(editing()).toEqual(['headerFirst']);
    await act(async () => void doc.getMap(PAGE_ROOT).set('differentFirstPage', false));
    expect([editing(), labels('header')]).toEqual([['header'], ['Header']]);
});

test('a band emptied while it is edited stays on the page until left', async () => {
    write('header', 'Acme');
    await render(WRITER);
    await doubleClick('header');
    await act(async () => void bandView('header')?.editor?.commands.clearContent());
    expect(band('header')?.hidden).toBe(false);

    await pressEscape(bandView('header'));
    expect(band('header')?.hidden).toBe(true);
});

test('Options › Remove header empties the header and leaves it', async () => {
    write('header', 'Acme');
    await render(WRITER);
    await doubleClick('header');
    await openMenu('Options');
    await pick('Remove header');
    expect(doc.getXmlFragment('header').toString()).not.toContain('Acme');
    expect(editing()).toEqual([]);
    expect(document.activeElement === bodyView()).toBe(true);
});

test('losing write access leaves the band', async () => {
    await render(WRITER);
    await doubleClick('header');
    await act(async () => setCanWrite(false));
    expect(editing()).toEqual([]);
});

test.each([
    ['a viewer', { canWrite: false, isMobile: false }],
    ['a phone', { canWrite: true, isMobile: true }],
])('%s sees the bands read-only, with no way in', async (_, who) => {
    write('header', 'Acme');
    await render(who);
    expect(band('header')?.textContent).toBe('Acme');
    await doubleClick('header');
    await doubleClick('footer');
    expect(editing()).toEqual([]);
    expect(margin('footer')?.textContent).toBe('');
    await openMenu('Insert');
    expect(menuItems()).not.toContain('Page elements');
});

// Format › Paragraph styles › Normal text, as Google has it: the doc's Normal is the caret's look, the body and the bands
// draw it from the page, and ⌘Z takes it back.
test("Update 'Normal text' to match writes the doc's Normal, the page draws it, and Undo takes it back", async () => {
    write('default', 'Hello', { textStyle: { fontFamily: 'Source Serif 4', fontSize: 14 } });
    await render(WRITER);
    const page = () => document.querySelector<HTMLElement>('[data-document]');
    expect(page()?.style.getPropertyValue('--doc-font-size')).toBe('');

    await openMenu('Format');
    await openSubmenu('Paragraph styles');
    await openSubmenu('Normal text');
    await pick("Update 'Normal text' to match");
    expect(doc.getMap(STYLE_ROOT).toJSON()).toEqual({ font: 'Source Serif 4', size: 14 });
    expect(page()?.style.getPropertyValue('--doc-font-size')).toBe('14pt');
    expect(page()?.style.getPropertyValue('--doc-font-family')).toBe("'Source Serif 4', serif");

    await openMenu('Edit');
    await pick(`Undo${formatForDisplay('Mod+Z')}`);
    expect(doc.getMap(STYLE_ROOT).toJSON()).toEqual({});
    expect(page()?.style.getPropertyValue('--doc-font-size')).toBe('');
});

test('a viewer sees the Normal the doc stores', async () => {
    doc.getMap(STYLE_ROOT).set('size', 12);
    await render({ canWrite: false, isMobile: false });
    expect(document.querySelector<HTMLElement>('[data-document]')?.style.getPropertyValue('--doc-font-size')).toBe(
        '12pt',
    );
});
