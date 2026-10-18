// The Headers and footers panel edits each band in an editor of its own, shows the first page's bands only with Different
// first page, and places Google's page-number presets: a number on the right, once per band, "not on the first page" by
// turning Different first page on, numbering the other pages' band and taking the number off the first page's. Its
// toolbar acts on the band last focused.
import { afterEach, expect, mock, test } from 'bun:test';
import type { BandRoot, PageSetup } from '@workspace/lib/docs/eigendoc';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const Y = await import('yjs');
const { act, createElement, useState } = await import('react');
const { AuthProvider } = await import('@workspace/lib/auth');
const { DEFAULT_PAGE_SETUP, PAGE_ROOT } = await import('@workspace/lib/docs/eigendoc');
const { DRIVE_MIME_DOC } = await import('@workspace/lib/types/drive');
const { drivePath } = await import('@workspace/ui/test/drive-path');
const { useBandEditors, useDocMedia } = await import('../../../components/docs/doc-editor');
const { HeadersFootersPanel, PAGE_NUMBER_PRESETS } = await import('../../../components/docs/headers-footers-panel');
const { usePageSetup } = await import('../../../components/docs/hooks/use-page-setup');
const { createDocUndoManager, writePageSetup } = await import('../../../components/docs/page-setup');

type Request = Parameters<typeof HeadersFootersPanel>[0]['request'];

let unmount = async () => {};
afterEach(() => unmount());

const onSetupChange = mock((_from: PageSetup, _to: PageSetup) => {});

// The editor's wiring: the band editors live beside the panel, which reads the page map and writes it through
// writePageSetup.
function Host({ doc, request }: { doc: InstanceType<typeof Y.Doc>; request: Request }) {
    const setup = usePageSetup(doc);
    const [undoManager] = useState(() => createDocUndoManager(doc));
    const media = useDocMedia(drivePath({ name: 'Letter', mimeType: DRIVE_MIME_DOC }));
    const editors = useBandEditors({ media, yDoc: doc, provider: null, editable: true });
    return createElement(HeadersFootersPanel, {
        editors,
        media,
        setup,
        onSetupChange: (from, to) => {
            onSetupChange(from, to);
            writePageSetup(doc, undoManager, from, to);
        },
        request,
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

// A page-number preset by its band's row and its button.
const presetButton = (band: 'Header' | 'Footer', label: 'Every page' | 'From page 2') =>
    [...document.querySelectorAll<HTMLButtonElement>(`[aria-label="${band} page numbers"] button`)].find(
        (b) => b.textContent === label,
    );

async function pickPreset(band: 'Header' | 'Footer', label: 'Every page' | 'From page 2') {
    const target = presetButton(band, label);
    if (!target) throw new Error(`no ${band} ${label} preset`);
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

// Google's four pictures, as two short rows the panel's width holds.
test('the presets are a header row and a footer row of Every page and From page 2', async () => {
    await render(new Y.Doc());
    const rows = [...document.querySelectorAll('[aria-label$=" page numbers"]')].map((row) => [
        row.getAttribute('aria-label'),
        ...[...row.querySelectorAll('button')].map((b) => b.textContent),
    ]);
    expect(rows).toEqual([
        ['Header page numbers', 'Every page', 'From page 2'],
        ['Footer page numbers', 'Every page', 'From page 2'],
    ]);
});

test.each([
    ['Header', 'header'],
    ['Footer', 'footer'],
] as const)('%s › Every page numbers every page on the right, once', async (preset, root) => {
    const doc = new Y.Doc();
    await render(doc);
    await pickPreset(preset, 'Every page');
    await pickPreset(preset, 'Every page');
    expect(doc.getXmlFragment(root).toString()).toBe(RIGHT_NUMBER);
    expect(onSetupChange).not.toHaveBeenCalled();

    // With a first page of its own, that page gets the number too, below what its band already holds.
    const letterhead = new Y.XmlElement('paragraph');
    letterhead.insert(0, [new Y.XmlText('Acme')]);
    doc.getXmlFragment(`${root}First`).insert(0, [letterhead]);
    await turnDifferentFirstPageOn(doc);
    await pickPreset(preset, 'Every page');
    expect(doc.getXmlFragment(root).toString()).toBe(RIGHT_NUMBER);
    expect(doc.getXmlFragment(`${root}First`).toString()).toBe(`<paragraph>Acme</paragraph>${RIGHT_NUMBER}`);
});

test('From page 2 turns Different first page on and numbers the other pages alone', async () => {
    const doc = new Y.Doc();
    await render(doc);
    await pickPreset('Footer', 'From page 2');
    expect(onSetupChange.mock.calls).toEqual([
        [DEFAULT_PAGE_SETUP, { ...DEFAULT_PAGE_SETUP, differentFirstPage: true }],
    ]);
    expect(doc.getXmlFragment('footer').toString()).toBe(RIGHT_NUMBER);
    expect(doc.getXmlFragment('footerFirst').length).toBe(0);
});

// Google's Show on first page off: the first page shows no number, in its header or its footer.
test('From page 2 takes the page number off the first page and keeps what else it holds', async () => {
    const doc = new Y.Doc();
    doc.getMap(PAGE_ROOT).set('differentFirstPage', true);
    await render(doc);
    await pickPreset('Header', 'Every page');
    await act(async () => band('headerFirst')?.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    await click('Page count');
    expect(doc.getXmlFragment('headerFirst').toString()).toContain('<pagenumber kind="page">');

    await pickPreset('Footer', 'From page 2');
    expect(onSetupChange).not.toHaveBeenCalled();
    expect(doc.getXmlFragment('headerFirst').toString()).not.toContain('<pagenumber kind="page">');
    expect(doc.getXmlFragment('headerFirst').toString()).toContain('<pagenumber kind="pages">');
    expect(doc.getXmlFragment('header').toString()).toBe(RIGHT_NUMBER);
    expect(doc.getXmlFragment('footer').toString()).toBe(RIGHT_NUMBER);
    expect(doc.getXmlFragment('footerFirst').toString()).not.toContain('pagenumber');
});

// Insert › Page elements › Page numbers opens the panel with its preset.
test('a request carrying a preset places it as the panel opens', async () => {
    const doc = new Y.Doc();
    await render(doc, { band: 'header', preset: PAGE_NUMBER_PRESETS[0] });
    expect(doc.getXmlFragment('header').toString()).toBe(RIGHT_NUMBER);
});

test('Format › Page numbers opens the panel on its presets', async () => {
    await render(new Y.Doc(), { section: 'pageNumbers' });
    expect(document.activeElement === presetButton('Header', 'Every page')).toBe(true);
});

test('the toolbar inserts into the band last focused', async () => {
    const doc = new Y.Doc();
    await render(doc);
    await act(async () => band('footer')?.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    await click('Page count');
    expect(doc.getXmlFragment('footer').toString()).toContain('<pagenumber kind="pages">');
    expect(doc.getXmlFragment('header').toString()).not.toContain('pagenumber');
});

test('once Different first page goes off, the toolbar acts on the other pages’ band instead of a hidden one', async () => {
    const doc = new Y.Doc();
    doc.getMap(PAGE_ROOT).set('differentFirstPage', true);
    await render(doc, { band: 'headerFirst' });
    await act(async () => doc.getMap(PAGE_ROOT).set('differentFirstPage', false));
    await click('Page count');
    expect(doc.getXmlFragment('header').toString()).toContain('<pagenumber kind="pages">');
    expect(doc.getXmlFragment('headerFirst').toString()).not.toContain('pagenumber');
});
