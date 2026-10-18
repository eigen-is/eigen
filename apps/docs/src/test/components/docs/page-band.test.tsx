// A margin of the page holds its bands, drawn by their live editors: the header 1.27 cm below the paper's top edge and
// the footer ending 1.27 cm above its bottom one, a band taller than the room pushing the body. A margin reaches the
// paper's edges, so a double-click anywhere in it enters, the band under the pointer or the margin's own.
import { afterEach, expect, mock, test } from 'bun:test';
import type { BandRoot } from '@workspace/lib/docs/eigendoc';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const Y = await import('yjs');
const { act, createElement } = await import('react');
const { AuthProvider } = await import('@workspace/lib/auth');
const { BAND_ROOTS, DEFAULT_PAGE_SETUP, PAGE_BAND_CLASS } = await import('@workspace/lib/docs/eigendoc');
const { DRIVE_MIME_DOC } = await import('@workspace/lib/types/drive');
const { drivePath } = await import('@workspace/ui/test/drive-path');
const { useBandEditors, useDocMedia } = await import('../../../components/docs/doc-editor');
const { PageBands } = await import('../../../components/docs/page-band');

type Props = Parameters<typeof PageBands>[0];

let unmount = async () => {};
afterEach(() => unmount());

async function render(
    doc: InstanceType<typeof Y.Doc>,
    { editing = null, ...props }: Pick<Props, 'edge' | 'setup' | 'onEnter'> & { editing?: BandRoot | null },
) {
    function Margin() {
        const editors = useBandEditors({
            media: useDocMedia(drivePath({ name: 'Letter', mimeType: DRIVE_MIME_DOC })),
            yDoc: doc,
            provider: null,
            editable: true,
            editing,
            onLeave: () => {},
        });
        return createElement(PageBands, { editors, editing, controls: null, ...props });
    }
    ({ unmount } = await renderInDocument(createElement(AuthProvider, null, createElement(Margin))));
    const margin = document.querySelector<HTMLElement>('[data-page-margin]');
    if (!margin) throw new Error('no margin');
    return margin;
}

function write(doc: InstanceType<typeof Y.Doc>, root: BandRoot, text: string) {
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText(text)]);
    doc.getXmlFragment(root).insert(doc.getXmlFragment(root).length, [paragraph]);
}

const band = (root: BandRoot) => document.querySelector<HTMLElement>(`[data-page-band="${root}"]`);

test('an empty band takes no room, and draws once a collaborator writes it, read-only', async () => {
    const doc = new Y.Doc();
    await render(doc, { edge: 'header', setup: DEFAULT_PAGE_SETUP });
    expect(band('header')?.hidden).toBe(true);

    await act(async () => write(doc, 'header', 'Acme'));
    expect(band('header')?.hidden).toBe(false);
    expect(band('header')?.textContent).toBe('Acme');
    expect(band('header')?.querySelector('[contenteditable="true"]')).toBeNull();
});

test('the header margin spans the paper to its top edge and starts the band 1.27 cm below it', async () => {
    const margin = await render(new Y.Doc(), {
        edge: 'header',
        setup: { ...DEFAULT_PAGE_SETUP, margin: { top: 20, right: 15, bottom: 25.4, left: 10 } },
    });
    expect([margin.style.margin, margin.style.padding, margin.style.minHeight]).toEqual([
        '-20mm -15mm 0px -10mm',
        '12.7mm 15mm 0px 10mm',
        '20mm',
    ]);
});

test('the footer margin spans the paper to its bottom edge and ends the band 1.27 cm above it', async () => {
    const margin = await render(new Y.Doc(), {
        edge: 'footer',
        setup: { ...DEFAULT_PAGE_SETUP, margin: { top: 20, right: 15, bottom: 25.4, left: 10 } },
    });
    expect([margin.style.margin, margin.style.padding, margin.style.minHeight]).toEqual([
        '0px -15mm -25.4mm -10mm',
        '0px 15mm 12.7mm 10mm',
        '25.4mm',
    ]);
});

// As in the PDF and the docx: a band never sits inside the body's column.
test('at a margin narrower than 1.27 cm a band sits on the margin', async () => {
    const setup = { ...DEFAULT_PAGE_SETUP, margin: { top: 10, right: 15, bottom: 8, left: 10 } };
    const header = await render(new Y.Doc(), { edge: 'header', setup });
    expect(header.style.padding).toBe('10mm 15mm 0px 10mm');
    await unmount();
    const footer = await render(new Y.Doc(), { edge: 'footer', setup });
    expect(footer.style.padding).toBe('0px 15mm 8mm 10mm');
});

// eigen-prose.css drops the last block's space after on PAGE_BAND_CLASS, as the export's bands carry it too.
test("a band's editor carries the page band class", async () => {
    const doc = new Y.Doc();
    write(doc, 'header', 'Acme');
    await render(doc, { edge: 'header', setup: DEFAULT_PAGE_SETUP });
    expect(band('header')?.querySelector('.ProseMirror')?.classList.contains(PAGE_BAND_CLASS)).toBe(true);
});

// Both variants side by side would read as one double header, so a margin shows what the long page's end prints until
// one of its bands is edited. A band's text, without its rule's label.
const shown = (margin: HTMLElement) =>
    [...margin.querySelectorAll<HTMLElement>('[data-page-band]')]
        .filter((b) => !b.hidden)
        .map((b) => b.querySelector('.ProseMirror')?.textContent);

test("with Different first page, the top margin shows page 1's header and the bottom the other pages' footer", async () => {
    const doc = new Y.Doc();
    for (const root of BAND_ROOTS) write(doc, root, root);
    const setup = { ...DEFAULT_PAGE_SETUP, differentFirstPage: true };
    expect(shown(await render(doc, { edge: 'header', setup }))).toEqual(['headerFirst']);
    await unmount();
    expect(shown(await render(doc, { edge: 'footer', setup }))).toEqual(['footer']);
});

test("edited with Different first page, page 1's header tops the margin and the other pages' footer leads its", async () => {
    const doc = new Y.Doc();
    for (const root of BAND_ROOTS) write(doc, root, root);
    const setup = { ...DEFAULT_PAGE_SETUP, differentFirstPage: true };
    expect(shown(await render(doc, { edge: 'header', setup, editing: 'header' }))).toEqual(['headerFirst', 'header']);
    await unmount();
    expect(shown(await render(doc, { edge: 'footer', setup, editing: 'footerFirst' }))).toEqual([
        'footer',
        'footerFirst',
    ]);
});

// The bar takes its room in the margin, so the body moves down by what the margin can't hold and nothing covers it.
test("edited, each band's bar sits in the flow between the band and the body", async () => {
    const setup = { ...DEFAULT_PAGE_SETUP, differentFirstPage: true };
    // A margin's rows top to bottom, a bar as 'bar'.
    const rows = (margin: HTMLElement) =>
        [...margin.querySelectorAll<HTMLElement>('[data-page-band]')].flatMap((b) =>
            [...b.children].map((row) => (row.hasAttribute('data-band-rule') ? 'bar' : b.dataset.pageBand)),
        );
    const bars = (margin: HTMLElement) => [...margin.querySelectorAll<HTMLElement>('[data-band-rule]')];

    const header = await render(new Y.Doc(), { edge: 'header', setup, editing: 'header' });
    expect(rows(header)).toEqual(['headerFirst', 'bar', 'header', 'bar']);
    for (const bar of bars(header)) expect(bar.className).not.toMatch(/(^|\s)-m[tby]-/);
    await unmount();

    const footer = await render(new Y.Doc(), { edge: 'footer', setup, editing: 'footer' });
    expect(rows(footer)).toEqual(['bar', 'footer', 'bar', 'footerFirst']);
    for (const bar of bars(footer)) expect(bar.className).not.toMatch(/(^|\s)-m[tby]-/);
});

test('a double-click enters the band under the pointer, or none in particular beside the bands', async () => {
    const doc = new Y.Doc();
    write(doc, 'headerFirst', 'Acme');
    const onEnter = mock((_root: BandRoot | undefined, _at: { left: number; top: number }) => {});
    const margin = await render(doc, {
        edge: 'header',
        setup: { ...DEFAULT_PAGE_SETUP, differentFirstPage: true },
        onEnter,
    });
    await act(async () =>
        band('headerFirst')
            ?.querySelector('p')
            ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 30, clientY: 40 })),
    );
    await act(async () => margin.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(onEnter.mock.calls).toEqual([
        ['headerFirst', { left: 30, top: 40 }],
        [undefined, { left: 0, top: 0 }],
    ]);
});
