// The Headers and footers panel edits each band in an editor of its own, shows the first page's bands only with Different
// first page, and places Google's page-number presets: a number on the right, "not on the first page" by turning
// Different first page on and numbering the other pages' band alone. Its toolbar acts on the band last focused.
import { afterEach, expect, mock, test } from 'bun:test';
import type { BandRoot, PageSetup } from '@workspace/lib/docs/eigendoc';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, useEffect, useState } = await import('react');
const { AuthProvider } = await import('@workspace/lib/auth');
const { DEFAULT_PAGE_SETUP, PAGE_ROOT } = await import('@workspace/lib/docs/eigendoc');
const { DRIVE_MIME_DOC } = await import('@workspace/lib/types/drive');
const { drivePath } = await import('@workspace/ui/test/drive-path');
const { HeadersFootersPanel, PAGE_NUMBER_PRESETS } = await import('../../../components/docs/headers-footers-panel');
const { usePageSetup } = await import('../../../components/docs/hooks/use-page-setup');
const { createDocUndoManager, writePageSetup } = await import('../../../components/docs/page-setup');

type Request = Parameters<typeof HeadersFootersPanel>[0]['request'];

let unmount = async () => {};
afterEach(() => unmount());

const onSetupChange = mock((_from: PageSetup, _to: PageSetup) => {});

// The editor's wiring: the panel reads the page map and writes it through writePageSetup.
function Host({ doc, request }: { doc: InstanceType<typeof Y.Doc>; request: Request }) {
    const setup = usePageSetup(doc);
    const [provider] = useState(() => new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false }));
    const [undoManager] = useState(() => createDocUndoManager(doc));
    useEffect(() => () => provider.destroy(), [provider]);
    return createElement(HeadersFootersPanel, {
        path: drivePath({ name: 'Letter', mimeType: DRIVE_MIME_DOC }),
        yDoc: doc,
        provider,
        setup,
        onSetupChange: (from, to) => {
            onSetupChange(from, to);
            writePageSetup(doc, undoManager, from, to);
        },
        request,
        textColumnWidth: () => 600,
        onClose: () => {},
    });
}

async function render(doc: InstanceType<typeof Y.Doc>, request: Request = { band: 'header' }) {
    onSetupChange.mockClear();
    ({ unmount } = await renderInDocument(createElement(AuthProvider, null, createElement(Host, { doc, request }))));
}

const turnDifferentFirstPageOn = (doc: InstanceType<typeof Y.Doc>) =>
    act(async () => doc.getMap(PAGE_ROOT).set('differentFirstPage', true));

// The labels of the band editors, top to bottom.
const bandLabels = () => [...document.querySelectorAll('[data-band]')].map((band) => band.getAttribute('aria-label'));

const band = (root: BandRoot) => document.querySelector<HTMLElement>(`[data-band="${root}"] .ProseMirror`);

const button = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label,
    );

async function click(label: string) {
    const target = button(label);
    if (!target) throw new Error(`no ${label} button`);
    await act(async () => target.click());
}

const RIGHT_NUMBER = '<paragraph textAlign="right"><pagenumber kind="page"></pagenumber></paragraph>';

test('a header and a footer, and the first page’s pair above them once Different first page is on', async () => {
    const doc = new Y.Doc();
    await render(doc);
    expect(bandLabels()).toEqual(['Header', 'Footer']);

    const label = [...document.querySelectorAll('label')].find((l) => l.textContent === 'Different first page');
    await act(async () => document.getElementById(label?.htmlFor ?? '')?.click());
    expect(onSetupChange.mock.calls).toEqual([
        [DEFAULT_PAGE_SETUP, { ...DEFAULT_PAGE_SETUP, differentFirstPage: true }],
    ]);
    expect(bandLabels()).toEqual(['First page header', 'First page footer', 'Header', 'Footer']);
});

test.each([
    ['In the header', 'header'],
    ['In the footer', 'footer'],
] as const)('%s numbers every page on the right', async (preset, root) => {
    const doc = new Y.Doc();
    await render(doc);
    await click(preset);
    expect(doc.getXmlFragment(root).toString()).toBe(RIGHT_NUMBER);
    expect(onSetupChange).not.toHaveBeenCalled();

    // With a first page of its own, that page gets the number too, below what its band already holds.
    const letterhead = new Y.XmlElement('paragraph');
    letterhead.insert(0, [new Y.XmlText('Acme')]);
    doc.getXmlFragment(`${root}First`).insert(0, [letterhead]);
    await turnDifferentFirstPageOn(doc);
    await click(preset);
    expect(doc.getXmlFragment(`${root}First`).toString()).toBe(`<paragraph>Acme</paragraph>${RIGHT_NUMBER}`);
});

test('not on the first page turns Different first page on and numbers the other pages alone', async () => {
    const doc = new Y.Doc();
    await render(doc);
    await click('In the footer, not on the first page');
    expect(onSetupChange.mock.calls).toEqual([
        [DEFAULT_PAGE_SETUP, { ...DEFAULT_PAGE_SETUP, differentFirstPage: true }],
    ]);
    expect(doc.getXmlFragment('footer').toString()).toBe(RIGHT_NUMBER);
    expect(doc.getXmlFragment('footerFirst').length).toBe(0);
});

// Insert › Page elements › Page numbers opens the panel with its preset.
test('a request carrying a preset places it as the panel opens', async () => {
    const doc = new Y.Doc();
    await render(doc, { band: 'header', preset: PAGE_NUMBER_PRESETS[0] });
    expect(doc.getXmlFragment('header').toString()).toBe(RIGHT_NUMBER);
});

test('the toolbar inserts into the band last focused', async () => {
    const doc = new Y.Doc();
    await render(doc);
    await act(async () => band('footer')?.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    await click('Page count');
    expect(doc.getXmlFragment('footer').toString()).toContain('<pagenumber kind="pages">');
    expect(doc.getXmlFragment('header').toString()).not.toContain('pagenumber');
});
