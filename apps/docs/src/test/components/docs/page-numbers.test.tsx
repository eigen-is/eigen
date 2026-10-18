// Google's page-number presets place a number on the right, once per band, and "not on the first page" turns Different
// first page on, numbers the other pages' band and takes the number off the first page's.
import { afterEach, expect, mock, test } from 'bun:test';
import type { Editor } from '@tiptap/react';
import type { BandRoot, PageSetup } from '@workspace/lib/docs/eigendoc';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const Y = await import('yjs');
const { act, createElement, Fragment, useState } = await import('react');
const { EditorContent } = await import('@tiptap/react');
const { AuthProvider } = await import('@workspace/lib/auth');
const { BAND_ROOTS, DEFAULT_PAGE_SETUP, PAGE_ROOT } = await import('@workspace/lib/docs/eigendoc');
const { DRIVE_MIME_DOC } = await import('@workspace/lib/types/drive');
const { drivePath } = await import('@workspace/ui/test/drive-path');
const { useBandEditors, useDocMedia } = await import('../../../components/docs/doc-editor');
const { usePageSetup } = await import('../../../components/docs/hooks/use-page-setup');
const { applyPageNumberPreset, PAGE_NUMBER_PRESETS } = await import('../../../components/docs/page-numbers');
const { createDocUndoManager, writePageSetup } = await import('../../../components/docs/page-setup');

type Preset = (typeof PAGE_NUMBER_PRESETS)[number];

let unmount = async () => {};
afterEach(() => unmount());

const onSetupChange = mock((_from: PageSetup, _to: PageSetup) => {});

let pick = (_preset: Preset) => {};
let editors: Record<BandRoot, Editor> | null = null;

// The editor's wiring: the four band editors on the page, the page map written through writePageSetup.
function Host({ doc }: { doc: InstanceType<typeof Y.Doc> }) {
    const setup = usePageSetup(doc);
    const [undoManager] = useState(() => createDocUndoManager(doc));
    const media = useDocMedia(drivePath({ name: 'Letter', mimeType: DRIVE_MIME_DOC }));
    const bands = useBandEditors({
        media,
        yDoc: doc,
        provider: null,
        editable: true,
        editing: null,
        onLeave: () => {},
    });
    editors = bands;
    pick = (preset) =>
        applyPageNumberPreset(bands, preset, setup, (from, to) => {
            onSetupChange(from, to);
            writePageSetup(doc, undoManager, from, to);
        });
    return createElement(
        Fragment,
        null,
        BAND_ROOTS.map((root) => createElement(EditorContent, { key: root, editor: bands[root] })),
    );
}

async function render(doc: InstanceType<typeof Y.Doc>) {
    onSetupChange.mockClear();
    ({ unmount } = await renderInDocument(createElement(AuthProvider, null, createElement(Host, { doc }))));
}

const preset = (label: Preset['label']) => {
    const found = PAGE_NUMBER_PRESETS.find((p) => p.label === label);
    if (!found) throw new Error(`no ${label} preset`);
    return found;
};

const pickPreset = (label: Preset['label']) => act(async () => pick(preset(label)));

const RIGHT_NUMBER = '<paragraph textAlign="right"><pagenumber kind="page"></pagenumber></paragraph>';

test("Google's four presets, header first", () => {
    expect(PAGE_NUMBER_PRESETS.map((p) => p.label)).toEqual([
        'In the header',
        'In the header, not on the first page',
        'In the footer',
        'In the footer, not on the first page',
    ]);
});

test.each([
    ['In the header', 'header'],
    ['In the footer', 'footer'],
] as const)('%s numbers every page on the right, once', async (label, root) => {
    const doc = new Y.Doc();
    await render(doc);
    await pickPreset(label);
    await pickPreset(label);
    expect(doc.getXmlFragment(root).toString()).toBe(RIGHT_NUMBER);
    expect(onSetupChange).not.toHaveBeenCalled();

    // With a first page of its own, that page gets the number too, below what its band already holds.
    const letterhead = new Y.XmlElement('paragraph');
    letterhead.insert(0, [new Y.XmlText('Acme')]);
    doc.getXmlFragment(`${root}First`).insert(0, [letterhead]);
    await act(async () => doc.getMap(PAGE_ROOT).set('differentFirstPage', true));
    await pickPreset(label);
    expect(doc.getXmlFragment(root).toString()).toBe(RIGHT_NUMBER);
    expect(doc.getXmlFragment(`${root}First`).toString()).toBe(`<paragraph>Acme</paragraph>${RIGHT_NUMBER}`);
});

test('not on the first page turns Different first page on and numbers the other pages alone', async () => {
    const doc = new Y.Doc();
    await render(doc);
    await pickPreset('In the footer, not on the first page');
    expect(onSetupChange.mock.calls).toEqual([
        [DEFAULT_PAGE_SETUP, { ...DEFAULT_PAGE_SETUP, differentFirstPage: true }],
    ]);
    expect(doc.getXmlFragment('footer').toString()).toBe(RIGHT_NUMBER);
    expect(doc.getXmlFragment('footerFirst').length).toBe(0);
});

// Google's Show on first page off: the first page shows no number, in its header or its footer.
test('not on the first page takes the page number off the first page and keeps what else it holds', async () => {
    const doc = new Y.Doc();
    doc.getMap(PAGE_ROOT).set('differentFirstPage', true);
    await render(doc);
    await pickPreset('In the header');
    await act(async () => {
        editors?.headerFirst
            .chain()
            .insertContent({ type: 'pageNumber', attrs: { kind: 'pages' } })
            .run();
    });
    expect(doc.getXmlFragment('headerFirst').toString()).toContain('<pagenumber kind="page">');

    await pickPreset('In the footer, not on the first page');
    expect(onSetupChange).not.toHaveBeenCalled();
    expect(doc.getXmlFragment('headerFirst').toString()).not.toContain('<pagenumber kind="page">');
    expect(doc.getXmlFragment('headerFirst').toString()).toContain('<pagenumber kind="pages">');
    expect(doc.getXmlFragment('header').toString()).toBe(RIGHT_NUMBER);
    expect(doc.getXmlFragment('footer').toString()).toBe(RIGHT_NUMBER);
    expect(doc.getXmlFragment('footerFirst').toString()).not.toContain('pagenumber');
});
