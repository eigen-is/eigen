// Headers and footers are edited in place, as in Google Docs: a writer on a desktop or a tablet double-clicks a margin,
// or picks Insert › Page elements, Format › Headers and footers or a page-number preset, and the caret goes into the
// band on the page. While a band is edited the toolbar and the menus act on it, the body stays as it is and editable, and
// Esc or a click in the body leaves. A viewer and a phone see the bands read-only, with no way in.
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { TiptapEditorHTMLElement } from '@tiptap/core';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import { getFontFamily } from '@workspace/lib/constants/fonts';
import type { BandRoot } from '@workspace/lib/docs/eigendoc';
import { stubCanvasImageFonts } from '@workspace/ui/test/canvas-image';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { menuRows } from '@workspace/ui/test/menu-rows';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import { answerUploads } from '../../fixtures/answered-upload';
import { withBrowserFrames } from '../../fixtures/browser-frames';
import { waitUntil } from '../../fixtures/wait-until';

// happy-dom lays nothing out: a test that needs the editor's width stubs it and fires these.
let resizes: (() => void)[] = [];
const window = installHappyDom({ onResizeObserver: (resize) => resizes.push(resize) });

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { NodeSelection } = await import('@tiptap/pm/state');
const { act, createElement, useState } = await import('react');
const { formatForDisplay } = await import('@tanstack/react-hotkeys');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const realAuth = await import('@workspace/lib/auth');
const realCollab = await import('@workspace/lib/collab');
const { BAND_ROOTS, PAGE_ROOT, STYLE_ROOT } = await import('@workspace/lib/docs/eigendoc');
const { DRIVE_MIME_CHAT, DRIVE_MIME_DOC } = await import('@workspace/lib/types/drive');
const { CommandPaletteProvider } = await import('@workspace/ui');
const { useCommandPalette } = await import('@workspace/lib/command-palette');
const { LayoutContext } = await import('@workspace/ui/components/layout/app/layout-context');
const { PreviewProvider } = await import('@workspace/ui/components/preview-provider');
const { drivePath } = await import('@workspace/ui/test/drive-path');
const download = await import('@workspace/lib/download');
const { newChartSpecParts, sampleChartSpec } = await import('@workspace/lib/charts');
const fonts = stubCanvasImageFonts();

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
const { MediaResolverProvider } = await import('@workspace/lib/drive');

const path = drivePath({ name: 'Letter', mimeType: DRIVE_MIME_DOC });

// Every request answers empty, but the chat folder, which lists one thread, and an upload, which answers when the test
// lets it.
const thread = { ...path, id: 'chat-a', name: 'thread-1.eigenchat', parentId: 'chat', mimeType: DRIVE_MIME_CHAT };
const finishUpload = answerUploads(path);
let commentRows: object[] = [];
spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
        async (input: RequestInfo | URL) => {
            if (String(input).includes('/folder/chat')) return Response.json([thread]);
            if (String(input).endsWith('/comments')) return Response.json(commentRows);
            return Response.json([]);
        },
        { preconnect: fetch.preconnect },
    ),
);

beforeEach(() => {
    provider.destroy();
    doc = new Y.Doc();
    provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
    commentRows = [];
    // The outline's shown or hidden, which the browser remembers.
    localStorage.clear();
});

let unmount = async () => {};
afterEach(() => unmount());

let setCanWrite = (_canWrite: boolean) => {};

// What the command palette holds, such as the open doc's comment search, read beside the editor.
let palette: ReturnType<typeof useCommandPalette> | null = null;
function PaletteProbe() {
    palette = useCommandPalette();
    return null;
}

const WRITER = { canWrite: true, isMobile: false };

async function render({
    canWrite,
    isMobile,
    mediaFolderId = null,
    chatFolderId = null,
    initialChatName,
    width = 1920,
}: {
    canWrite: boolean;
    isMobile: boolean;
    mediaFolderId?: string | null;
    chatFolderId?: string | null;
    // A `?chat=` landing, such as a notification's link.
    initialChatName?: string;
    // The toolbar folds its menus by the window's width, the panes by the layout's isMobile.
    width?: number;
}) {
    window.happyDOM.setViewport({ width, height: 1000 });
    // Only this render's observers, as an unmounted one observes nothing.
    resizes = [];
    function Editor() {
        const [writer, setWriter] = useState(canWrite);
        setCanWrite = setWriter;
        // The editor route provides the document's media resolver.
        return createElement(MediaResolverProvider, {
            ownerId: path.ownerId,
            mountId: path.mountId,
            mediaFolderId,
            chatFolderId,
            children: createElement(CollaborativeEditor, {
                path,
                canWrite: writer,
                mediaFolderId,
                chatFolderId,
                onAccessDialogOpen: () => {},
                initialChatName,
            }),
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
                        createElement(CommandPaletteProvider, null, createElement(Editor), createElement(PaletteProbe)),
                    ),
                ),
        }),
        history: createMemoryHistory(),
    });
    await router.load();
    ({ unmount } = await renderInDocument(createElement(RouterProvider, { router })));
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

// An action, with Tiptap's frame run as a browser runs it: after React has drawn what the action changed. happy-dom runs
// a frame before act lets React draw, when the band the caret goes to is not editable yet.
const inBrowserFrames = (action: () => void) => withBrowserFrames(() => act(async () => action()));

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

// The labels on a margin's rules, top to bottom.
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
        [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')]
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

const pageBox = () => document.querySelector<HTMLElement>('[data-document]');
const pageStyles = () => [...document.querySelectorAll('style')].map((style) => style.textContent ?? '').join('\n');

test("a page-less doc draws no paper and no bands, never scales, and its text column is the reader's Narrow", async () => {
    write('header', 'Acme');
    doc.getMap(PAGE_ROOT).set('pageless', true);
    await render({ ...WRITER, width: 390 });
    expect(pageBox()?.hasAttribute('data-pageless')).toBe(true);
    expect(pageBox()?.className).not.toMatch(/rounded|shadow/);
    expect(pageBox()?.style.transform).toBe('');
    expect(margin('header')).toBeNull();
    expect(band('header')).toBeNull();
    expect(pageStyles()).toContain('max-width: 696px');
    // The paper still prints: the page's own @page rule stays.
    expect(pageStyles()).toContain('@page { size: 210mm 297mm');
});

test('each reader draws a page-less doc at their own text width, which the doc never holds', async () => {
    doc.getMap(PAGE_ROOT).set('pageless', true);
    localStorage.setItem('eigen-docs-text-width:u1', 'wide');
    await render(WRITER);
    expect(pageStyles()).toContain('max-width: 1056px');
    expect(Object.keys(doc.getMap(PAGE_ROOT).toJSON())).toEqual(['pageless']);
});

// The page-less column the editor lays out in a scroll box `width` px wide, as its left edge and its width.
async function pagelessColumnAt(width: number) {
    const scrollBox = pageBox()?.parentElement;
    if (!scrollBox) throw new Error('no scroll box');
    scrollBox.getBoundingClientRect = () => new DOMRect(0, 0, width, 900);
    await act(async () => {
        for (const resize of resizes) resize();
    });
    const column = pageStyles().match(/\[data-pageless\] \{ width: (\d+)px; margin-left: (\d+)px/);
    return { left: Number(column?.[2]), width: Number(column?.[1]) };
}

test('the outline over the left of a page-less doc narrows its column, at Wide and at Full', async () => {
    doc.getMap(PAGE_ROOT).set('pageless', true);
    localStorage.setItem('eigen-docs-text-width:u1', 'full');
    await render(WRITER);
    expect(await pagelessColumnAt(1440)).toEqual({ left: 48, width: 1344 });
    await unmount();

    localStorage.setItem('eigen-docs-outline', 'shown');
    await render(WRITER);
    // The outline's 240 px cover the scroll box's 16 px gutter too, which leaves that gutter between it and the text.
    expect(await pagelessColumnAt(1440)).toEqual({ left: 240, width: 1152 });
    await unmount();

    localStorage.setItem('eigen-docs-text-width:u1', 'wide');
    await render(WRITER);
    expect(await pagelessColumnAt(1440)).toEqual({ left: 240, width: 1008 });
    // Room enough beside it, a Wide column stays centred.
    expect(await pagelessColumnAt(1920)).toEqual({ left: 432, width: 1056 });
});

test("a switch to page-less, a collaborator's too, leaves the band being edited and hides the bands", async () => {
    await render(WRITER);
    await doubleClick('header');
    expect(editing()).toEqual(['header']);
    await act(async () => doc.getMap(PAGE_ROOT).set('pageless', true));
    expect(editing()).toEqual([]);
    expect(margin('header')).toBeNull();
    await openMenu('Insert');
    expect(menuItems()).not.toContain(`Page break${formatForDisplay('Mod+Enter')}`);
    // The menus act on the body again, whose schema holds the chart a band's leaves out.
    const chart = [...document.querySelectorAll('[role="menuitem"]')].find(
        (item) => item.textContent?.trim() === 'Chart',
    );
    expect(chart?.hasAttribute('data-disabled')).toBe(false);
    await openSubmenu('Page elements');
    expect(menuItems().filter((item) => item === 'Header' || item === 'Footer')).toEqual([]);
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

// Google leaves the body as it is while a header or footer is edited.
test('the body is not dimmed while a band is edited', async () => {
    await render(WRITER);
    await doubleClick('header');
    expect(document.querySelector('.tiptap-wrapper')?.className).not.toContain('opacity');
});

// Google's bar has solid light-grey lines on its top and bottom edges.
test('the band bar has solid edges', async () => {
    await render(WRITER);
    await doubleClick('header');
    const classes = document.querySelector('[data-band-rule]')?.className ?? '';
    expect(classes).toContain('border-y');
    expect(classes).not.toContain('dashed');
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

// Radix hands focus back a tick after a menu unmounts, and by then Tiptap has destroyed the editors of a document that
// closed with it, Insert › Equation's pick waiting for that tick too.
test('a document closed with the body’s or a band’s menu open throws nothing', async () => {
    const errors: unknown[] = [];
    const onError = (event: InstanceType<typeof window.Event>) => errors.push('error' in event ? event.error : event);
    window.addEventListener('error', onError);
    try {
        await render(WRITER);
        await openMenu('Insert');
        await unmount();
        await render(WRITER);
        await openMenu('Insert');
        await withBrowserFrames(() =>
            act(async () => {
                [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
                    .find((item) => item.textContent?.trim() === 'Equation')
                    ?.click();
                await unmount();
            }),
        );
        await render(WRITER);
        await doubleClick('header');
        await openMenu('Options');
        await withBrowserFrames(unmount);
    } finally {
        window.removeEventListener('error', onError);
    }
    expect(errors).toEqual([]);
});

test('Options › Page setup… keeps focus in the dialog it opens', async () => {
    await render(WRITER);
    await doubleClick('header');
    await openMenu('Options');
    await pick('Page setup…');
    expect(document.activeElement?.closest('[role="dialog"]')).not.toBeNull();
});

// Google's Header format… and Footer format… open one dialog, which writes the page as Page setup does.
test('Options › Footer format… sets the footer’s distance from the bottom, which the page draws and ⌘Z takes back', async () => {
    await render(WRITER);
    await doubleClick('footer');
    await openMenu('Options');
    expect(menuItems()).not.toContain('Header format…');
    await pick('Footer format…');
    const field = [...document.querySelectorAll('label')].find(
        (l) => l.textContent === 'Footer (centimeters from bottom)',
    );
    const input = field && document.getElementById(field.htmlFor);
    if (!(input instanceof HTMLInputElement)) throw new Error('no footer distance field');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '0.8');
    await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
    await inBrowserFrames(() => button('Apply')?.click());

    expect(doc.getMap(PAGE_ROOT).get('footerDistance')).toBe(8);
    expect(margin('footer')?.style.paddingBottom).toBe('8mm');
    await pressEscape(bandView('footer'));
    await act(async () => void bodyView()?.editor?.commands.undo());
    expect(doc.getMap(PAGE_ROOT).get('footerDistance')).toBeUndefined();
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
    // The card shows once the panel has read its anchor, 200 ms after the body's last change.
    const card = () =>
        [...document.querySelectorAll<HTMLElement>('.line-clamp-2')].find(
            (title) => title.textContent === 'Check this',
        );
    await waitUntil(() => card() !== undefined, 'the comment card');
    await act(async () => card()?.click());
    expect(editing()).toEqual([]);
});

test('a link to a comment whose text was deleted opens it as deleted, its thread still there', async () => {
    const stored = new Y.Map<unknown>();
    stored.set('title', 'Check this');
    stored.set('chatName', 'thread-1.eigenchat');
    doc.getMap('comments').set('c1', stored);
    write('default', 'Hello');
    await render({ ...WRITER, chatFolderId: 'chat', initialChatName: 'thread-1.eigenchat' });
    await waitUntil(
        () => document.body.textContent?.includes('This comment was deleted') === true,
        'the deleted state',
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Check this');
    expect(document.querySelector('[role="dialog"] [contenteditable="true"]')).toBeNull();
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

test('a table selected in the body closes its panel as a band is entered', async () => {
    await render(WRITER);
    await act(async () => void bodyView()?.editor?.commands.insertTable({ rows: 2, cols: 2 }));
    expect(document.body.textContent).toContain('Columns');
    await doubleClick('header');
    expect(document.body.textContent).not.toContain('Columns');
});

const headerEditor = () => {
    const header = bandView('header')?.editor;
    if (!header) throw new Error('no header editor');
    return header;
};

const columns = (root: string) => doc.getXmlFragment(root).toString().split('<tableheader').length - 1;

test('a table in the band being edited opens the table panel, which writes the band, its own undo taking it back', async () => {
    write('default', 'Hello');
    await render(WRITER);
    await doubleClick('header');
    const header = headerEditor();
    await act(async () => void header.commands.insertTable({ rows: 2, cols: 2 }));
    yUndoPluginKey.getState(header.state)?.undoManager.stopCapturing();
    expect(document.body.textContent).toContain('Columns');

    // The panel sits outside the page, so a press in it leaves the band edited.
    const after = button('After');
    await act(async () => void after?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await act(async () => after?.click());
    expect(editing()).toEqual(['header']);
    expect(columns('header')).toBe(3);
    expect(doc.getXmlFragment('default').toString()).toBe('<paragraph>Hello</paragraph>');

    await openMenu('Edit');
    await pick(`Undo${formatForDisplay('Mod+Z')}`);
    expect(columns('header')).toBe(2);
});

test('an image in the band being edited opens the Image panel, aligned only, writing the band', async () => {
    await render(WRITER);
    await doubleClick('header');
    const header = headerEditor();
    await act(async () => {
        header.commands.insertContent({ type: 'figure', attrs: { src: 'data:image/png;base64,', width: 100 } });
        header.commands.setNodeSelection(1);
    });
    const toggles = [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')];
    expect(toggles.map((t) => t.getAttribute('aria-label'))).toEqual(['Align left', 'Align center', 'Align right']);

    await act(async () => toggles[2]?.click());
    expect(doc.getXmlFragment('header').toString()).toContain('alignment="right"');
    expect(editing()).toEqual(['header']);
});

// A loaded image selected in `root`'s editor, its grips drawn.
async function selectedImage(root: BandRoot | 'default') {
    const view = root === 'default' ? bodyView() : bandView(root);
    const editor = view?.editor;
    if (!view || !editor) throw new Error(`no ${root} editor`);
    await act(async () => {
        editor.commands.insertContentAt(1, { type: 'figure', attrs: { src: 'data:image/png;base64,', width: 100 } });
        editor.commands.setNodeSelection(1);
    });
    const img = view.querySelector('.figure img');
    if (!img) throw new Error('no image');
    Object.defineProperties(img, { naturalWidth: { value: 200 }, naturalHeight: { value: 100 } });
    await act(async () => void img.dispatchEvent(new Event('load')));
    expect(view.querySelectorAll('.eigen-selection-handle').length).toBeGreaterThan(0);
    return view;
}

// The grips draw from the editable flag as the image renders, which nothing re-renders: the image is deselected.
test('an image selected in the band being edited drops its grips as the band is left', async () => {
    await render(WRITER);
    await doubleClick('header');
    const view = await selectedImage('header');
    await pressEscape(view);
    expect(editing()).toEqual([]);
    expect(view.querySelectorAll('.eigen-selection-handle').length).toBe(0);
});

test('an image selected in the body drops its grips as write access goes', async () => {
    write('default', 'Hello');
    await render(WRITER);
    const view = await selectedImage('default');
    await act(async () => setCanWrite(false));
    expect(view.querySelectorAll('.eigen-selection-handle').length).toBe(0);
});

test('an equation a click selects in the band being edited opens the Equation panel, which writes the band', async () => {
    await render(WRITER);
    await doubleClick('header');
    const header = headerEditor();
    await act(async () => void header.commands.insertEquation());
    // Inserted, it is selected as by an arrow, which opens no panel.
    expect(document.querySelector('textarea[aria-label="LaTeX"]')).toBeNull();
    await act(async () => void header.commands.setTextSelection(1));
    await act(async () =>
        header.view.dispatch(
            header.state.tr.setSelection(NodeSelection.create(header.state.doc, 1)).setMeta('pointer', true),
        ),
    );
    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="LaTeX"]');
    expect(field).not.toBeNull();

    await act(async () => button('On its own line')?.click());
    expect(doc.getXmlFragment('header').toString()).toContain('display="true"');
    expect(doc.getXmlFragment('default').toString()).not.toContain('equation');
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

test('in a band, Insert greys out the page break, and an image goes into the band and lands there after leaving', async () => {
    await render({ ...WRITER, mediaFolderId: 'media' });
    await openMenu('Insert');
    expect(menuItems()).toContain(`Page break${formatForDisplay('Mod+Enter')}`);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    await doubleClick('header');
    await openMenu('Insert');
    const greyed = (name: string) =>
        [...document.querySelectorAll('[role="menuitem"]')]
            .find((item) => item.textContent?.trim().startsWith(name))
            ?.getAttribute('aria-disabled');
    expect(['Page break', 'Code block', 'Equation'].map(greyed)).toEqual(['true', 'true', 'true']);
    expect(greyed('Table')).not.toBe('true');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('no image input');
    Object.defineProperty(input, 'files', { value: [new File(['png'], 'logo.png', { type: 'image/png' })] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(doc.getXmlFragment('header').toString()).toContain('mediaName="pending:');
    expect(doc.getXmlFragment('default').toString()).not.toContain('figure');

    await pressEscape(bandView('header'));
    await act(async () => finishUpload('logo-1.png'));
    await waitUntil(
        () => doc.getXmlFragment('header').toString().includes('mediaName="logo-1.png"'),
        'the uploaded name',
    );
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
    expect(page()?.style.getPropertyValue('--doc-font-family')).toBe(getFontFamily('Source Serif 4'));

    await openMenu('Edit');
    await pick(`Undo${formatForDisplay('Mod+Z')}`);
    expect(doc.getMap(STYLE_ROOT).toJSON()).toEqual({});
    expect(page()?.style.getPropertyValue('--doc-font-size')).toBe('');
});

const updateNormal = () =>
    [...document.querySelectorAll('[role="menuitem"]')].find(
        (item) => item.textContent?.trim() === "Update 'Normal text' to match",
    );

// A heading's or a title's look is its own, and a band's undo is its own, so neither updates the body's Normal.
test("Update 'Normal text' to match is offered in a paragraph of the body only", async () => {
    const heading = new Y.XmlElement('heading');
    heading.setAttribute('level', '2');
    const run = new Y.XmlText();
    run.insert(0, 'Title');
    heading.insert(0, [run]);
    doc.getXmlFragment('default').insert(0, [heading]);
    write('default', 'Hello');
    await render(WRITER);
    const normalTextMenu = async () => {
        await openMenu('Format');
        await openSubmenu('Paragraph styles');
        await openSubmenu('Normal text');
    };
    await normalTextMenu();
    expect(updateNormal()?.getAttribute('aria-disabled')).toBe('true');
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    await doubleClick('header');
    await normalTextMenu();
    expect(updateNormal()?.getAttribute('aria-disabled')).toBe('true');
});

// The page owns the paper's background, so it is the layers' stacking context: a figure behind the text draws on the
// paper, under the header band's text as under the body's.
test('the page stacks the figures in front of and behind the text', async () => {
    await render(WRITER);
    expect(document.querySelector('[data-document]')?.classList.contains('isolate')).toBe(true);
});

test('a viewer sees the Normal the doc stores', async () => {
    doc.getMap(STYLE_ROOT).set('size', 12);
    await render({ canWrite: false, isMobile: false });
    expect(document.querySelector<HTMLElement>('[data-document]')?.style.getPropertyValue('--doc-font-size')).toBe(
        '12pt',
    );
});

function writeFigure() {
    const paragraph = new Y.XmlElement('paragraph');
    const figure = new Y.XmlElement('figure');
    figure.setAttribute('mediaName', 'chart.png');
    paragraph.insert(0, [figure]);
    doc.getXmlFragment('default').insert(0, [paragraph]);
}

// Google's image menu holds Cut and Copy; Delete, red, goes last and alone, as every Eigen menu draws it.
test('a right-click on an image offers a writer Cut, Copy and Delete, and Delete takes the image out', async () => {
    writeFigure();
    await render(WRITER);
    const figure = bodyView()?.querySelector('.figure');
    if (!figure) throw new Error('no figure');
    await act(async () => figure.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(menuRows()).toEqual(['Cut', 'Copy', '—', 'Delete']);
    expect(document.querySelector('[role="menuitem"][data-variant="destructive"]')?.textContent?.trim()).toBe('Delete');

    await pick('Delete');
    expect(doc.getXmlFragment('default').toString()).not.toContain('figure');
});

test('a right-click on an image offers Add comment where comments are on, which comments on the image', async () => {
    writeFigure();
    await render({ ...WRITER, chatFolderId: 'chats' });
    const figure = bodyView()?.querySelector('.figure');
    if (!figure) throw new Error('no figure');
    await act(async () => figure.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(menuRows()).toEqual(['Cut', 'Copy', '—', 'Add comment', '—', 'Delete']);

    await pick('Add comment');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('New comment');
});

// A viewer with nothing to download or comment on keeps the browser's own menu.
test("a viewer's right-click on an image with no rows for it opens no menu", async () => {
    writeFigure();
    await render({ canWrite: false, isMobile: false });
    const figure = bodyView()?.querySelector('.figure');
    if (!figure) throw new Error('no figure');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => figure.dispatchEvent(event));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(event.defaultPrevented).toBe(false);
});

// happy-dom lays nothing out to hit-test, so the pointer lands at `pos`, else at the target's start.
const rightClick = async (target: Element | null | undefined, pos?: number) => {
    if (!target) throw new Error('nothing to right-click');
    const view = target.closest<TiptapEditorHTMLElement>('.ProseMirror')?.editor?.view;
    const hit =
        view && spyOn(view, 'posAtCoords').mockReturnValue({ pos: pos ?? view.posAtDOM(target, 0), inside: -1 });
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    await act(async () => target.dispatchEvent(event));
    hit?.mockRestore();
    return event;
};

const bodyEditor = () => {
    const body = bodyView()?.editor;
    if (!body) throw new Error('no body editor');
    return body;
};

const count = (root: string, tag: string) => doc.getXmlFragment(root).toString().split(`<${tag}`).length - 1;

// A 2×2 table in the body, its header row on top; the caret waits in its first cell.
async function bodyTable() {
    await act(async () => void bodyEditor().commands.insertTable({ rows: 2, cols: 2 }));
}

// The second row's first cell: a body cell, away from the caret insertTable leaves in the header row.
const bodyCell = (root: ParentNode | null | undefined = bodyView()) => root?.querySelector('td p');

const TABLE_ROWS = [
    'Insert row above',
    'Insert row below',
    'Insert column left',
    'Insert column right',
    '—',
    'Distribute columns',
    '—',
    'Merge cells',
    'Unmerge cells',
    '—',
    'Toggle header row',
    'Cell background color',
    'All borders',
    'Outer borders',
    'No borders',
];

// Google's table menu, in Eigen's group order: the clipboard, the inserts, the table's format, the comment, then the
// deletes, red and last.
test('a right-click in a table cell offers a writer the table menu, its deletes red and last', async () => {
    await render(WRITER);
    await bodyTable();
    const event = await rightClick(bodyCell());
    expect(event.defaultPrevented).toBe(true);
    expect(menuRows()).toEqual([
        'Cut',
        'Copy',
        'Paste',
        '—',
        ...TABLE_ROWS,
        '—',
        'Delete row',
        'Delete column',
        'Delete table',
    ]);
    expect(
        [...document.querySelectorAll('[role="menuitem"][data-variant="destructive"]')].map((item) =>
            item.textContent?.trim(),
        ),
    ).toEqual(['Delete row', 'Delete column', 'Delete table']);
});

test('a right-click on a cell whose pointer resolves between the cells still offers the table menu', async () => {
    await render(WRITER);
    await bodyTable();
    const cell = bodyCell()?.closest('td');
    const view = bodyView()?.editor?.view;
    if (!cell || !view) throw new Error('no cell');
    // Table start, outside every cell.
    const tablePos = view.posAtDOM(cell.closest('table') ?? cell, 0) - 1;
    const hit = spyOn(view, 'posAtCoords').mockReturnValue({ pos: tablePos, inside: -1 });
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
    await act(async () => cell.dispatchEvent(event));
    hit.mockRestore();
    expect(event.defaultPrevented).toBe(true);
    expect(menuRows()).toContain('Delete table');
});

test('the table menu acts on the cell right-clicked', async () => {
    await render(WRITER);
    await bodyTable();
    await rightClick(bodyCell());
    await pick('Insert row above');
    expect(count('default', 'tablerow')).toBe(3);
    // Above the cell right-clicked, not the header row the caret was in: the header row stays first.
    expect(doc.getXmlFragment('default').toString()).toMatch(/^<table[^>]*><tablerow><tableheader/);

    await rightClick(bodyCell());
    await pick('Insert column right');
    expect(count('default', 'tableheader')).toBe(3);

    await rightClick(bodyCell());
    await pick('Delete row');
    expect(count('default', 'tablerow')).toBe(2);

    await rightClick(bodyCell());
    await pick('Delete column');
    expect(count('default', 'tableheader')).toBe(2);

    await rightClick(bodyCell());
    await pick('Toggle header row');
    expect(count('default', 'tableheader')).toBe(0);

    await rightClick(bodyCell());
    await pick('No borders');
    // The cell's four sides, and the facing side of each cell beside it.
    expect(
        doc
            .getXmlFragment('default')
            .toString()
            .match(/border(Top|Right|Bottom|Left)="none"/g),
    ).toHaveLength(6);

    await rightClick(bodyCell());
    await pick('Delete table');
    expect(count('default', 'table')).toBe(0);
});

test('a right-click inside a cell selection keeps it, so Merge cells merges it', async () => {
    const { CellSelection } = await import('@tiptap/pm/tables');
    await render(WRITER);
    await bodyTable();
    const body = bodyEditor();
    const cells: number[] = [];
    body.state.doc.descendants((node, pos) => {
        if (node.type.name === 'tableCell') cells.push(pos);
    });
    await act(async () =>
        body.view.dispatch(body.state.tr.setSelection(CellSelection.create(body.state.doc, cells[0], cells[1]))),
    );
    await rightClick(bodyCell());
    await pick('Merge cells');
    expect(doc.getXmlFragment('default').toString()).toContain('colspan="2"');
});

test('a right-click inside a text selection in a cell keeps it, so Copy copies it', async () => {
    await render(WRITER);
    await bodyTable();
    const body = bodyEditor();
    await act(async () => void body.commands.insertContentAt(body.state.selection.from, 'Total'));
    await act(async () => void body.commands.setTextSelection({ from: 5, to: 7 }));
    await rightClick(bodyView()?.querySelector('th p'), 6);
    expect(body.state.selection.from).toBe(5);
    expect(body.state.selection.to).toBe(7);
});

// The menu fires the native cut and copy ⌘X and ⌘C fire, as Edit › Cut and Copy do.
test.each([
    ['Cut', 'cut', 'Mod+X'],
    ['Copy', 'copy', 'Mod+C'],
])('the table menu’s %s runs the native %s', async (label, command, shortcut) => {
    const execCommand = mock((_command: string) => true);
    document.execCommand = execCommand;
    await render(WRITER);
    await bodyTable();
    await rightClick(bodyCell());
    await pick(`${label}${formatForDisplay(shortcut)}`);
    expect(execCommand.mock.calls).toEqual([[command]]);
});

// No ClipboardEvent reaches a menu row, so Paste reads the clipboard itself and hands it to the editor's own paste.
test('the table menu’s Paste pastes what the clipboard holds into the cell', async () => {
    const read = mock(async () => [{ types: ['text/plain'], getType: async () => new Blob(['pasted']) }]);
    Object.defineProperty(navigator, 'clipboard', { value: { read }, configurable: true });
    await render(WRITER);
    await bodyTable();
    await rightClick(bodyCell());
    await pick(`Paste${formatForDisplay('Mod+V')}`);
    await waitUntil(
        () => doc.getXmlFragment('default').toString().includes('<tablecell colspan="1" rowspan="1"><paragraph>pasted'),
        'the pasted text',
    );
    expect(read).toHaveBeenCalled();
});

test('the table menu offers Add comment on a cell’s text, where a comment anchors', async () => {
    await render({ ...WRITER, chatFolderId: 'chats' });
    await bodyTable();
    const body = bodyEditor();
    await act(async () => void body.commands.insertContentAt(body.state.selection.from, 'Total'));
    await act(async () => void body.commands.setTextSelection({ from: 3, to: 8 }));
    await rightClick(bodyView()?.querySelector('th p'));
    expect(menuRows()).toEqual([
        'Cut',
        'Copy',
        'Paste',
        '—',
        ...TABLE_ROWS,
        '—',
        'Add comment',
        '—',
        'Delete row',
        'Delete column',
        'Delete table',
    ]);
    await pick('Add comment');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('New comment');
});

test("a viewer's right-click in a table cell opens no menu and leaves the browser's", async () => {
    await render({ canWrite: false, isMobile: false });
    await bodyTable();
    const event = await rightClick(bodyCell());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(event.defaultPrevented).toBe(false);
});

test('a right-click in a table in the band being edited opens its menu, which writes the band', async () => {
    write('default', 'Hello');
    await render(WRITER);
    await doubleClick('header');
    await act(async () => void headerEditor().commands.insertTable({ rows: 2, cols: 2 }));
    await rightClick(bodyCell(bandView('header')));
    await pick('Insert row below');
    expect(count('header', 'tablerow')).toBe(3);
    expect(doc.getXmlFragment('default').toString()).toBe('<paragraph>Hello</paragraph>');
});

const EQUATION_ROWS = ['Cut', 'Copy', '—', 'Edit equation', '—', 'Style'];

// An empty equation in the body, after the text.
async function bodyEquation(as = WRITER) {
    write('default', 'x');
    await render(as);
    await act(async () => void bodyEditor().chain().setTextSelection(2).insertEquation().run());
}

test('a right-click on an equation offers a writer its menu, Delete equation red and last', async () => {
    await bodyEquation();
    const event = await rightClick(bodyView()?.querySelector('.equation'));
    expect(event.defaultPrevented).toBe(true);
    expect(menuRows()).toEqual([...EQUATION_ROWS, '—', 'Delete equation']);
    expect(document.querySelector('[role="menuitem"][data-variant="destructive"]')?.textContent?.trim()).toBe(
        'Delete equation',
    );
    // Style is the panel's row: its two options in a submenu, the display it has checked.
    await openSubmenu('Style');
    expect(
        [...document.querySelectorAll('[role="menuitemradio"]')].map((row) => [
            row.textContent?.trim(),
            row.getAttribute('aria-checked'),
        ]),
    ).toEqual([
        ['In line with text', 'true'],
        ['On its own line', 'false'],
    ]);
});

test('the equation menu sets its display, opens its panel and deletes it', async () => {
    await bodyEquation();
    await rightClick(bodyView()?.querySelector('.equation'));
    await openSubmenu('Style');
    await pick('On its own line');
    expect(doc.getXmlFragment('default').toString()).toContain('display="true"');

    await rightClick(bodyView()?.querySelector('.equation'));
    await pick('Edit equation');
    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="LaTeX"]');
    expect(field).not.toBeNull();
    expect(document.activeElement === field).toBe(true);

    await rightClick(bodyView()?.querySelector('.equation'));
    await pick('Delete equation');
    expect(doc.getXmlFragment('default').toString()).toBe('<paragraph>x</paragraph>');
});

// A right-click selects as a click does, so a table's cell around the equation leaves its panel shut.
test('a right-click on an equation in a table cell opens the Equation panel', async () => {
    await render(WRITER);
    await bodyTable();
    const body = bodyEditor();
    await act(async () => void body.commands.insertEquation());
    await act(async () => void body.commands.setTextSelection(body.state.selection.from));
    expect(document.body.textContent).toContain('Columns');
    await rightClick(bodyView()?.querySelector('.equation'));
    expect(menuRows()).toEqual([...EQUATION_ROWS, '—', 'Delete equation']);
    expect(document.querySelector('textarea[aria-label="LaTeX"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Columns');
});

test('the equation menu’s Cut cuts the equation it was opened on', async () => {
    let cut: string | undefined;
    document.execCommand = mock((_command: string) => {
        cut = bodyEditor().state.selection.content().content.firstChild?.type.name;
        return true;
    });
    await bodyEquation();
    await act(async () => void bodyEditor().commands.setTextSelection(1));
    await rightClick(bodyView()?.querySelector('.equation'));
    await pick(`Cut${formatForDisplay('Mod+X')}`);
    expect(cut).toBe('equation');
});

test('the equation menu offers Add comment where comments are on', async () => {
    write('default', 'x');
    await render({ ...WRITER, chatFolderId: 'chats' });
    await act(async () => void bodyEditor().chain().setTextSelection(2).insertEquation().run());
    await rightClick(bodyView()?.querySelector('.equation'));
    expect(menuRows()).toEqual([...EQUATION_ROWS, '—', 'Add comment', '—', 'Delete equation']);
});

test("a viewer's right-click on an equation opens no menu", async () => {
    await bodyEquation({ canWrite: false, isMobile: false });
    const event = await rightClick(bodyView()?.querySelector('.equation'));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(event.defaultPrevented).toBe(false);
});

test('a right-click on an equation in the band being edited opens its menu, which writes the band', async () => {
    await render(WRITER);
    await doubleClick('header');
    await act(async () => void headerEditor().commands.insertEquation());
    await rightClick(bandView('header')?.querySelector('.equation'));
    // Comments anchor in the body only.
    expect(menuRows()).toEqual([...EQUATION_ROWS, '—', 'Delete equation']);
    await openSubmenu('Style');
    await pick('On its own line');
    expect(doc.getXmlFragment('header').toString()).toContain('display="true"');
    expect(doc.getXmlFragment('default').toString()).not.toContain('equation');
});

// "see " then "the docs" linked to eigen.is, with `selection` set in the body.
async function linkedBody(selection: number | { from: number; to: number }) {
    await act(async () => {
        bodyEditor().commands.setContent({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'see ' },
                        {
                            type: 'text',
                            text: 'the docs',
                            marks: [{ type: 'link', attrs: { href: 'https://eigen.is' } }],
                        },
                    ],
                },
            ],
        });
        bodyEditor().commands.setTextSelection(selection);
    });
}

const LINK_ROWS = ['Open link', '—', 'Copy link', '—', 'Edit link', 'Remove link'];

// The menu follows the pointer, not the selection: a caret elsewhere would otherwise leave the browser's own menu.
test('a writer right-clicking a link with only a caret gets its rows, and Remove link unlinks all of it', async () => {
    await render({ ...WRITER, chatFolderId: 'chats' });
    await linkedBody(1);
    const event = await rightClick(bodyView()?.querySelector('a'));
    expect(event.defaultPrevented).toBe(true);
    expect(menuRows()).toEqual(LINK_ROWS);
    await pick('Remove link');
    expect(bodyView()?.querySelector('a')).toBeNull();
    expect(bodyEditor().getText()).toBe('see the docs');
});

test('a link right-clicked with its text selected offers Add comment after its rows', async () => {
    await render({ ...WRITER, chatFolderId: 'chats' });
    await linkedBody({ from: 5, to: 13 });
    await rightClick(bodyView()?.querySelector('a'));
    expect(menuRows()).toEqual([...LINK_ROWS, '—', 'Add comment']);
});

test('Edit link opens the Edit link dialog on the whole link', async () => {
    await render(WRITER);
    await linkedBody(1);
    await rightClick(bodyView()?.querySelector('a'));
    await pick('Edit link');
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Edit link');
    expect(document.querySelector<HTMLInputElement>('#link-text')?.value).toBe('the docs');
    expect(document.querySelector<HTMLInputElement>('#link-address')?.value).toBe('https://eigen.is');
});

test.each([
    ["a viewer's right-click on a link", { canWrite: false, isMobile: false }, 'a'],
    ["a writer's right-click on plain text with only a caret", WRITER, 'p'],
])('%s leaves the browser its own menu', async (_, who, selector) => {
    await render({ ...who, chatFolderId: 'chats' });
    await linkedBody(1);
    const event = await rightClick(bodyView()?.querySelector(selector), selector === 'p' ? 2 : undefined);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(event.defaultPrevented).toBe(false);
});

// A chart's look is attributes of its node beside the spec's parts; its labels draw in the look's color. No size draws
// it at CHART_DEFAULT_SIZE, 600 × 371.
function writeChart() {
    const paragraph = new Y.XmlElement('paragraph');
    const chart = new Y.XmlElement('chart');
    const parts = newChartSpecParts({ ...sampleChartSpec('column'), title: { text: 'Light / dark' } });
    for (const [key, text] of Object.entries(parts)) chart.setAttribute(key, text);
    chart.setAttribute('color', '#123456');
    paragraph.insert(0, [chart]);
    doc.getXmlFragment('default').insert(0, [paragraph]);
}

async function rightClickChart() {
    const chart = bodyView()?.querySelector('.figure');
    if (!chart) throw new Error('no chart');
    await act(async () => chart.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
}

test('a right-click on a chart offers a writer Download image beside Cut, Copy and Delete', async () => {
    writeChart();
    await render(WRITER);
    await rightClickChart();
    expect(menuRows()).toEqual(['Cut', 'Copy', '—', 'Download image', '—', 'Delete']);
});

test("a viewer's Download image saves the chart in its look on white, its font embedded, named for its title", async () => {
    const saved = spyOn(download, 'downloadBlob').mockImplementation(() => {});
    try {
        writeChart();
        await render({ canWrite: false, isMobile: false });
        await rightClickChart();
        expect(menuRows()).toEqual(['Copy', '—', 'Download image']);
        fonts.takeFetched();
        await pick('Download image');
        await waitUntil(() => saved.mock.calls.length > 0, 'the download');
        expect(saved).toHaveBeenCalledTimes(1);
        const [blob, name] = saved.mock.calls[0];
        expect(name).toBe('Light dark.svg');
        const svg = await blob.text();
        expect(svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" width="620" height="391"');
        expect(svg).toContain('fill="#ffffff"');
        expect(svg).toContain('>Light / dark<');
        expect(svg).toContain('fill="#123456"');
        expect(fonts.takeFetched()).toEqual(['inter/Inter-Variable.latin.woff2']);
        expect(svg).toContain('font-family: "Inter"');
    } finally {
        saved.mockRestore();
    }
});

// A block text box holding "Inside", at the start of the body.
function writeTextBox() {
    const paragraph = new Y.XmlElement('paragraph');
    const box = new Y.XmlElement('textBox');
    box.setAttribute('id', 'box-1');
    const inside = new Y.XmlElement('paragraph');
    inside.insert(0, [new Y.XmlText('Inside')]);
    box.insert(0, [inside]);
    paragraph.insert(0, [box]);
    doc.getXmlFragment('default').insert(0, [paragraph]);
}

test('a right-click on a text box offers Add comment, which opens the new comment form', async () => {
    writeTextBox();
    await render({ ...WRITER, chatFolderId: 'chats' });
    const box = bodyView()?.querySelector('.figure');
    if (!box) throw new Error('no text box');
    await act(async () => box.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    await pick('Add comment');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('New comment');
});

test('a right-click on a text box offers a writer Cut, Copy and Delete, and Delete takes the box out', async () => {
    writeTextBox();
    await render(WRITER);
    const box = bodyView()?.querySelector('.figure');
    if (!box) throw new Error('no text box');
    await act(async () => box.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    expect(menuRows()).toEqual(['Cut', 'Copy', '—', 'Delete']);

    await pick('Delete');
    expect(doc.getXmlFragment('default').toString()).not.toContain('textbox');
});

// A card titled "Check this", with its thread's chat name.
function writeCard() {
    const card = new Y.Map<unknown>();
    card.set('title', 'Check this');
    card.set('chatName', 'thread-1');
    doc.getMap('comments').set('c1', card);
}

const commentsPanelShown = () =>
    [...document.querySelectorAll('.eigen-toolbar-title')].some((title) => title.textContent === 'Comments');
const cardDialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? '';

test.each([
    ['an image', writeFigure],
    ['a chart', writeChart],
    ['a text box', writeTextBox],
])('the comment mark on %s opens its card beside the comments panel', async (_, writeNode) => {
    writeNode();
    const paragraph = doc.getXmlFragment('default').get(0);
    const node = paragraph instanceof Y.XmlElement ? paragraph.get(0) : null;
    if (!(node instanceof Y.XmlElement)) throw new Error('no node');
    node.setAttribute('commentCardId', 'c1');
    writeCard();
    await render({ ...WRITER, chatFolderId: 'chats' });
    const mark = bodyView()?.querySelector<HTMLElement>('button[aria-label="Open comment"]');
    if (!mark) throw new Error('no comment mark');
    await act(async () => mark.click());
    expect(commentsPanelShown()).toBe(true);
    expect(cardDialogText()).toContain('Check this');
});

// An equation in a paragraph of its own, at the start of the body.
function writeEquation() {
    const paragraph = new Y.XmlElement('paragraph');
    const equation = new Y.XmlElement('equation');
    equation.setAttribute('mathml', '<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi></math>');
    paragraph.insert(0, [equation]);
    doc.getXmlFragment('default').insert(0, [paragraph]);
}

// A comment's hover card, over the body only: the highlighted text and each node's corner mark show the card after a
// pause, leaving the body hides it, and a click on it opens the card as a click on the text does.
const moveOver = (target: Element) =>
    act(async () => target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
const hoverCardShown = () =>
    document.querySelector('[data-slot="popover-content"]')?.textContent?.includes('Check this');
// Longer than the pause before a card opens.
const pastOpenDelay = () => act(() => new Promise((resolve) => setTimeout(resolve, 400)));

test('a hover over commented text shows its card, and leaving the body hides it', async () => {
    write('default', 'Hello', { comment: { cardId: 'c1' } });
    writeCard();
    await render(WRITER);
    const span = bodyView()?.querySelector('.comment-highlight');
    if (!span) throw new Error('no highlight');
    await moveOver(span);
    await waitUntil(() => hoverCardShown() === true, 'the hover card');

    await act(async () =>
        span.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })),
    );
    await waitUntil(() => !hoverCardShown(), 'the hover card to close');
});

test.each([
    ['an image', writeFigure],
    ['a chart', writeChart],
    ['a text box', writeTextBox],
    ['an equation', writeEquation],
])('a hover over the comment mark on %s shows its card, through its node view', async (_, writeNode) => {
    writeNode();
    const paragraph = doc.getXmlFragment('default').get(0);
    const node = paragraph instanceof Y.XmlElement ? paragraph.get(0) : null;
    if (!(node instanceof Y.XmlElement)) throw new Error('no node');
    node.setAttribute('commentCardId', 'c1');
    writeCard();
    await render(WRITER);
    const mark = bodyView()?.querySelector('button[data-comment-id="c1"]');
    if (!mark) throw new Error('no comment mark');
    await moveOver(mark);
    await waitUntil(() => hoverCardShown() === true, 'the hover card');
});

test('a press within the pause shows no card, as for a drag-select that starts on the text', async () => {
    write('default', 'Hello', { comment: { cardId: 'c1' } });
    writeCard();
    await render(WRITER);
    const span = bodyView()?.querySelector('.comment-highlight');
    if (!span) throw new Error('no highlight');
    await moveOver(span);
    await act(async () => span.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await pastOpenDelay();
    expect(hoverCardShown()).toBeFalsy();
});

test('a click on the hover card opens the card beside the comments panel', async () => {
    write('default', 'Hello', { comment: { cardId: 'c1' } });
    writeCard();
    await render({ ...WRITER, chatFolderId: 'chats' });
    const span = bodyView()?.querySelector('.comment-highlight');
    if (!span) throw new Error('no highlight');
    await moveOver(span);
    await waitUntil(() => hoverCardShown() === true, 'the hover card');
    const card = document.querySelector<HTMLElement>('[data-slot="popover-content"] .line-clamp-2');
    await act(async () => card?.click());
    expect(commentsPanelShown()).toBe(true);
    expect(cardDialogText()).toContain('Check this');
    expect(hoverCardShown()).toBeFalsy();
});

test('a resolved comment shows no card from its text, while a corner mark still does', async () => {
    write('default', 'Hello', { comment: { cardId: 'c1' } });
    writeEquation();
    const paragraph = doc.getXmlFragment('default').get(0);
    const equation = paragraph instanceof Y.XmlElement ? paragraph.get(0) : null;
    if (!(equation instanceof Y.XmlElement)) throw new Error('no equation');
    equation.setAttribute('commentCardId', 'c1');
    writeCard();
    commentRows = [{ chatName: 'thread-1', status: 'resolved', messageCount: 0 }];
    await render(WRITER);
    await waitUntil(() => bodyEditor().storage.comment.resolvedIds.has('c1'), 'the resolved card');

    const span = bodyView()?.querySelector('.comment-highlight');
    const mark = bodyView()?.querySelector('button[data-comment-id="c1"]');
    if (!span || !mark) throw new Error('no anchors');
    await moveOver(span);
    await pastOpenDelay();
    expect(hoverCardShown()).toBeFalsy();

    await moveOver(mark);
    await waitUntil(() => hoverCardShown() === true, 'the hover card');
});

test('a mark in a band shows no card, as only the body reports a hover', async () => {
    write('header', 'Hello', { comment: { cardId: 'c1' } });
    writeCard();
    await render(WRITER);
    const span = bandView('header')?.querySelector('.comment-highlight');
    if (!span) throw new Error('no highlight');
    await moveOver(span);
    await pastOpenDelay();
    expect(hoverCardShown()).toBeFalsy();
});

// Insert › Footnote and Insert › Text box open the new story with the caret in it; typing lands in the story, and Esc
// hands the caret back to the body.
test.each([
    ['a note', 'footnote', ['Page elements', `Footnote${formatForDisplay('Mod+Alt+F')}`]],
    ['a text box', 'textbox', ['Text box']],
])('%s inserted from the Insert menu takes what is typed, and Esc leaves it', async (_, tag, path) => {
    write('default', 'Hello');
    await render(WRITER);
    await act(async () => void bodyEditor().commands.setTextSelection(6));
    await openMenu('Insert');
    for (const label of path.slice(0, -1)) await openSubmenu(label);
    await pick(path[path.length - 1]);
    const story = document.activeElement?.closest<TiptapEditorHTMLElement>('.ProseMirror');
    if (!story?.editor || story === bodyView()) throw new Error('no story open');
    await act(async () => void story.editor?.commands.insertContent('Typed'));
    expect(doc.getXmlFragment('default').toString()).toMatch(new RegExp(`<${tag}[^>]*>.*Typed.*</${tag}>`));

    await pressEscape(story);
    expect(document.activeElement === bodyView()).toBe(true);
});

// The outline: Tools › Show outline on a desktop, remembered per browser, and the kebab's pane on a phone.
const OUTLINE_DOC = {
    type: 'doc',
    content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Intro' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Method' }] },
    ],
};

const outlineShown = () =>
    [...document.querySelectorAll('.eigen-toolbar-title')].some((title) => title.textContent === 'Outline');
const outlineEntry = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('nav[aria-label="Outline"] button')].find(
        (entry) => entry.textContent === label,
    );

test('the outline is hidden at first, and Tools › Show outline shows and hides it, remembered after a reload', async () => {
    await render(WRITER);
    expect(outlineShown()).toBe(false);

    await openMenu('Tools');
    await pick('Show outline');
    expect(outlineShown()).toBe(true);

    await unmount();
    await render(WRITER);
    expect(outlineShown()).toBe(true);

    await openMenu('Tools');
    await pick('Show outline');
    expect(outlineShown()).toBe(false);
    await unmount();
    await render(WRITER);
    expect(outlineShown()).toBe(false);
});

// A column beside the scroll box would narrow it and re-center the page, so the outline lies over the box instead.
test('the outline lies over the scroll box, as a panel does, so the page keeps its place', async () => {
    await render(WRITER);
    await openMenu('Tools');
    await pick('Show outline');
    const title = [...document.querySelectorAll('.eigen-toolbar-title')].find((t) => t.textContent === 'Outline');
    const scroller = bodyView()?.closest('.overflow-y-scroll');
    expect(scroller?.parentElement).toBeTruthy();
    expect(title?.closest('.pointer-events-none')?.parentElement).toBe(scroller?.parentElement);
});

test.each([
    ['a writer', WRITER],
    ['a viewer', { canWrite: false, isMobile: false }],
])('a click on an outline entry puts the caret at the start of its heading, for %s', async (_who, who) => {
    await render(who);
    await act(async () => void bodyView()?.editor?.commands.setContent(OUTLINE_DOC));
    await openMenu('Tools');
    await pick('Show outline');

    await inBrowserFrames(() => outlineEntry('Method')?.click());
    const { $from } = bodyView()?.editor?.state.selection ?? {};
    expect([$from?.parent.textContent, $from?.parentOffset]).toEqual(['Method', 0]);
});

test('a jump scrolls its heading to a small margin below the top of the view, so a note number above it shows', async () => {
    await render(WRITER);
    await act(async () => void bodyView()?.editor?.commands.setContent(OUTLINE_DOC));
    await openMenu('Tools');
    await pick('Show outline');
    const scroller = bodyView()?.closest<HTMLElement>('.overflow-y-scroll');
    const heading = [...(bodyView()?.querySelectorAll('h2') ?? [])].find((h) => h.textContent === 'Method');
    if (!scroller || !heading) throw new Error('no scroller or heading');
    spyOn(scroller, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 100, 800, 900));
    spyOn(heading, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 700, 600, 30));
    const scrollBy = spyOn(scroller, 'scrollBy').mockImplementation(() => {});

    await inBrowserFrames(() => outlineEntry('Method')?.click());
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith({ top: 700 - 100 - 24 });
});

test('a jump to a heading leaves the band being edited', async () => {
    await render(WRITER);
    await act(async () => void bodyView()?.editor?.commands.setContent(OUTLINE_DOC));
    await openMenu('Tools');
    await pick('Show outline');
    await doubleClick('header');
    expect(editing()).toEqual(['header']);

    await inBrowserFrames(() => outlineEntry('Method')?.click());
    expect(editing()).toEqual([]);
    expect(bodyView()?.editor?.state.selection.$from.parent.textContent).toBe('Method');
});

const PHONE = { canWrite: true, isMobile: true, width: 390 };

test("on a phone the kebab's Show outline opens a pane over the editor, and a tap jumps and closes it", async () => {
    await render(PHONE);
    await act(async () => void bodyView()?.editor?.commands.setContent(OUTLINE_DOC));
    expect(outlineShown()).toBe(false);
    expect(menuTrigger('Tools')).toBeUndefined();

    await openMenu('More actions');
    await pick('Show outline');
    expect(outlineShown()).toBe(true);
    expect(document.querySelector('.tiptap-wrapper')?.closest('.hidden')).not.toBeNull();

    await inBrowserFrames(() => outlineEntry('Method')?.click());
    expect(outlineShown()).toBe(false);
    expect(document.querySelector('.tiptap-wrapper')?.closest('.hidden')).toBeNull();
    expect(bodyView()?.editor?.state.selection.$from.parent.textContent).toBe('Method');

    // A phone's pane opens closed again on the next visit.
    await openMenu('More actions');
    await pick('Show outline');
    await unmount();
    await render(PHONE);
    expect(outlineShown()).toBe(false);
});

// The Table of contents panel's own row.
const tocPanelShown = () => [...document.querySelectorAll('span.w-14')].some((label) => label.textContent === 'Format');

const selectedTableOfContents = () => {
    const { selection } = bodyEditor().state;
    return selection instanceof NodeSelection && selection.node.type.name === 'tableOfContents';
};

// "Intro" in the body, the caret at its end, and a table of contents inserted there.
async function bodyTableOfContents(as = WRITER) {
    write('default', 'Intro');
    await render(as);
    await act(async () => void bodyEditor().chain().setTextSelection(6).insertTableOfContents().run());
    await act(async () => void bodyEditor().commands.setTextSelection(3));
}

const tocLine = () => bodyView()?.querySelector('nav[data-type="table-of-contents"]');

// Mid-paragraph, where the insert alone would leave the caret in the paragraph's second half.
test('Insert › Table of contents leaves the new one selected, so its panel opens', async () => {
    write('default', 'Intro');
    await render(WRITER);
    await act(async () => void bodyEditor().commands.setTextSelection(3));
    await openMenu('Insert');
    await pick('Table of contents');
    expect(selectedTableOfContents()).toBe(true);
    expect(tocPanelShown()).toBe(true);
});

// The comments panel holds the slot the new node's panel needs, so the insert closes it.
test('Insert › Table of contents shows its panel over an open comments panel', async () => {
    write('default', 'Intro');
    await render(WRITER);
    await act(async () => button('Comments')?.click());
    await openMenu('Insert');
    await pick('Table of contents');
    expect(selectedTableOfContents()).toBe(true);
    expect(tocPanelShown()).toBe(true);
});

test('Insert › Chart shows its panel over an open comments panel', async () => {
    write('default', 'Intro');
    await render(WRITER);
    await act(async () => button('Comments')?.click());
    await openMenu('Insert');
    await openSubmenu('Chart');
    await pick('Column');
    expect(button('Edit data')).toBeDefined();
});

test('a right-click on a table of contents selects it and offers its options, the clipboard and its delete', async () => {
    await bodyTableOfContents();
    expect(tocPanelShown()).toBe(false);
    const event = await rightClick(tocLine());
    expect(event.defaultPrevented).toBe(true);
    expect(menuRows()).toEqual(['Cut', 'Copy', '—', 'Table of contents options', '—', 'Delete table of contents']);
    expect(selectedTableOfContents()).toBe(true);
    expect(tocPanelShown()).toBe(true);

    await pick('Delete table of contents');
    expect(doc.getXmlFragment('default').toString()).not.toContain('tableOfContents');
});

// The comments panel holds the slot until Table of contents options closes it.
test('Table of contents options shows the panel over an open comments panel', async () => {
    await bodyTableOfContents();
    await act(async () => button('Comments')?.click());
    await rightClick(tocLine());
    expect(tocPanelShown()).toBe(false);
    await pick('Table of contents options');
    expect(selectedTableOfContents()).toBe(true);
    expect(tocPanelShown()).toBe(true);
});

test('a phone, with no panel, offers no Table of contents options', async () => {
    await bodyTableOfContents({ canWrite: true, isMobile: true });
    await rightClick(tocLine());
    expect(menuRows()).toEqual(['Cut', 'Copy', '—', 'Delete table of contents']);
});

test("a viewer's right-click on a table of contents opens no menu and leaves the browser's", async () => {
    write('default', 'Intro');
    const toc = new Y.XmlElement('tableOfContents');
    doc.getXmlFragment('default').insert(0, [toc]);
    await render({ canWrite: false, isMobile: false });
    const event = await rightClick(tocLine());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(event.defaultPrevented).toBe(false);
});

// The palette's comment search reveals a thread by its chat name: the card opens over the comments panel, and on a
// desktop the caret goes to its anchor in the body. On a phone the comments pane takes the screen.
test.each([
    ['a desktop', WRITER],
    ['a phone', PHONE],
])('on %s a comment search hit opens its card over the comments panel', async (_, as) => {
    write('default', 'Intro');
    write('default', 'Hello', { comment: { cardId: 'c1' } });
    writeCard();
    await render({ ...as, chatFolderId: 'chats' });
    await waitUntil(() => palette?.docCommentSearch != null, 'the comment search');
    await act(async () => palette?.docCommentSearch?.reveal('thread-1'));
    expect(commentsPanelShown()).toBe(true);
    expect(cardDialogText()).toContain('Check this');
    // The caret goes to the anchor, at the start of the second paragraph, only where the body shows.
    expect(bodyEditor().state.selection.from).toBe(as.isMobile ? 1 : 8);
    expect(bodyView()?.closest('.hidden') != null).toBe(as.isMobile);
});
