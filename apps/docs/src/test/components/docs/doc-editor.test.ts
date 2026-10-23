// One factory builds the body's editor and each band's. A band's editor binds its own root with its own undo, its schema
// deletes the nodes a band leaves out and keeps every mark, a paste into it drops comment anchors, and an image pasted
// into it lands in that editor. A table is fitted to the text column of the page the doc holds, not the one on screen.
import { afterEach, expect, jest, mock, spyOn, test } from 'bun:test';
import { getSchema, type JSONContent } from '@tiptap/core';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const Y = await import('yjs');
const { Editor } = await import('@tiptap/react');
const { default: Collaboration } = await import('@tiptap/extension-collaboration');
const { prosemirrorJSONToYXmlFragment, yUndoPluginKey } = await import('@tiptap/y-tiptap');
const { BAND_EXCLUDED_NODES, DEFAULT_PAGE_SETUP, getDocExtensions, PAGE_ROOT, pagePx, pageRecord } = await import(
    '@workspace/lib/docs/eigendoc'
);
const { sampleChartSpec } = await import('@workspace/lib/charts');
const { writeEigenClipboard } = await import('@workspace/lib/clipboard');
const { docEditorOptions } = await import('../../../components/docs/doc-editor');
const { createDocUndoManager } = await import('../../../components/docs/page-setup');

type Target = Parameters<typeof docEditorOptions>[0]['target'];

const pastedMediaName = mock(async () => 'logo-copy.png');
const media = {
    mediaFolderId: 'media',
    resolveMediaPath: () => undefined,
    uploadImage: async () => {},
    uploadSvg: async () => {},
    insertFromDrive: async () => {},
    replaceImage: async () => {},
    replaceFromDrive: async () => {},
    pastedMediaName,
};

const editors: InstanceType<typeof Editor>[] = [];
afterEach(() => {
    for (const editor of editors.splice(0)) editor.destroy();
    pastedMediaName.mockClear();
});

function mount(doc: InstanceType<typeof Y.Doc>, target: Target) {
    const editor: InstanceType<typeof Editor> = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        ...docEditorOptions({
            yDoc: doc,
            editable: true,
            target,
            caret: null,
            coarsePointer: false,
            media: () => media,
            editor: () => editor,
        }),
    });
    editors.push(editor);
    return editor;
}

const HEADER = { field: 'header', onLeave: () => {} } as const;

const body = (doc: InstanceType<typeof Y.Doc>, cardIds: string[] = []) =>
    mount(doc, { undoManager: createDocUndoManager(doc), cardIds: () => new Set(cardIds) });

const commentIds = (json: JSONContent): unknown[] => [
    ...(json.marks ?? []).filter((mark) => mark.type === 'comment').map((mark) => mark.attrs?.['cardId']),
    ...(json.content ?? []).flatMap(commentIds),
];

test("a band's editor writes its own root and undoes only its own typing", () => {
    const doc = new Y.Doc();
    const undoManager = createDocUndoManager(doc);
    const page = mount(doc, { undoManager, cardIds: () => new Set() });
    const header = mount(doc, HEADER);

    page.commands.insertContent('Body');
    header.commands.insertContent('Acme');
    expect(doc.getXmlFragment('header').toString()).toBe('<paragraph>Acme</paragraph>');
    expect(page.getText()).toBe('Body');
    expect(undoManager.undoStack.length).toBe(1);

    expect(header.commands.undo()).toBe(true);
    expect(header.getText()).toBe('');
    expect(page.getText()).toBe('Body');
});

// A mark a band's schema lacked would delete the text a peer marked with it, so a band leaves out nodes only.
test("a band's schema has every mark of the body's and its nodes but BAND_EXCLUDED_NODES", () => {
    const doc = new Y.Doc();
    const page = body(doc);
    const header = mount(doc, HEADER);
    expect(Object.keys(header.schema.marks)).toEqual(Object.keys(page.schema.marks));
    expect(Object.keys(header.schema.nodes)).toEqual(
        Object.keys(page.schema.nodes).filter((name) => !BAND_EXCLUDED_NODES.has(name)),
    );
});

test("a band's editor deletes a node a band leaves out and keeps a comment's text", () => {
    const peer = new Y.Doc();
    const full = new Editor({
        extensions: [...getDocExtensions(), Collaboration.configure({ document: peer, field: 'header' })],
    });
    full.commands.setContent({
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [{ type: 'text', text: 'Noted', marks: [{ type: 'comment', attrs: { cardId: 'c1' } }] }],
            },
            { type: 'pageBreak' },
        ],
    });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    full.destroy();

    const header = mount(doc, HEADER);
    // The peer's TrailingNode wrote a paragraph after the break.
    expect(header.getJSON().content?.map((node) => node.type)).toEqual(['paragraph', 'paragraph']);
    expect(header.state.doc.textContent).toBe('Noted');
    expect(commentIds(header.getJSON())).toEqual(['c1']);
    expect(doc.getXmlFragment('header').toString()).not.toContain('pageBreak');
});

// A band has no Equation panel, so Enter on a selected equation does what it does on a selected figure.
test('Enter on a selected equation in a band does what it does on a selected figure', () => {
    const enterOn = (leaf: JSONContent) => {
        const header = mount(new Y.Doc(), HEADER);
        header.commands.setContent({ type: 'doc', content: [{ type: 'paragraph', content: [leaf] }] });
        header.commands.setNodeSelection(1);
        header.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return header.getJSON().content?.map((block) => block.content?.map((node) => node.type === leaf.type));
    };
    // A paragraph opens before the leaf, which stays.
    expect(enterOn({ type: 'equation', attrs: { mathml: '' } })).toEqual([undefined, [true]]);
    expect(enterOn({ type: 'figure', attrs: { mediaName: 'logo.png' } })).toEqual([undefined, [true]]);
});

// Comments don't reach a band, so a pasted anchor would mark text no card points at.
test('a paste into a band drops comment anchors; the body keeps those of its own cards', () => {
    const html = '<p><span data-comment-id="c1">Noted</span></p>';
    const doc = new Y.Doc();
    const header = mount(doc, HEADER);
    header.view.pasteHTML(html);
    expect(header.getText()).toBe('Noted');
    expect(commentIds(header.getJSON())).toEqual([]);

    const page = body(doc, ['c1']);
    page.view.pasteHTML(html);
    expect(commentIds(page.getJSON())).toEqual(['c1']);
});

test('an image pasted into a band lands in that editor, under the name its re-upload gives', async () => {
    const doc = new Y.Doc();
    body(doc);
    const header = mount(doc, HEADER);
    const event = new ClipboardEvent('paste', { clipboardData: new DataTransfer(), bubbles: true });
    writeEigenClipboard(event, {
        version: 1,
        items: [
            {
                type: 'image',
                mediaName: 'logo.png',
                sourcePathId: 'p',
                sourceParentId: 'elsewhere',
                sourceOwnerId: 'o',
                sourceMountId: 'm',
                width: 120,
                height: 40,
            },
        ],
    });
    header.view.dom.dispatchEvent(event);
    // insertEigenItems places the image once every re-upload has settled.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pastedMediaName).toHaveBeenCalledTimes(1);
    expect(doc.getXmlFragment('header').toString()).toContain('mediaName="logo-copy.png"');
    expect(doc.getXmlFragment('default').toString()).not.toContain('logo');
});

// A chart from Sheets, Slides or Vector: the body places it within its text column, a band, which has no chart node,
// places nothing.
test('a chart item pastes into the body as a chart within the column, and into a band as nothing', async () => {
    const spec = JSON.stringify(sampleChartSpec('column'));
    const pasteChart = (editor: InstanceType<typeof Editor>) => {
        const event = new ClipboardEvent('paste', {
            clipboardData: new DataTransfer(),
            bubbles: true,
            cancelable: true,
        });
        writeEigenClipboard(event, { version: 1, items: [{ type: 'chart', spec, width: 2000, height: 1000 }] });
        editor.view.dom.dispatchEvent(event);
    };
    const doc = new Y.Doc();
    pasteChart(mount(doc, HEADER));
    const page = body(doc);
    pasteChart(page);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const { width, margin } = pagePx(DEFAULT_PAGE_SETUP);
    const column = width - margin.left - margin.right;
    const charts: Record<string, unknown>[] = [];
    page.state.doc.descendants((node) => {
        if (node.type.name === 'chart') charts.push(node.attrs);
    });
    expect(charts).toMatchObject([{ spec, width: column, height: column / 2 }]);
    expect(doc.getXmlFragment('header').toString()).not.toContain('chart');
});

const withNote: JSONContent = {
    type: 'paragraph',
    content: [
        { type: 'text', text: 'Claim' },
        {
            type: 'footnote',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'See ' },
                        { type: 'text', text: 'Smith', marks: [{ type: 'bold' }] },
                    ],
                },
                { type: 'paragraph', content: [{ type: 'text', text: 'p. 4' }] },
            ],
        },
        { type: 'text', text: ' end.' },
    ],
};

// A cut and a copy with no image are ProseMirror's own; the clipboard carries its HTML.
function cutOrCopy(editor: InstanceType<typeof Editor>, type: 'cut' | 'copy'): string {
    const event = new ClipboardEvent(type, { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
    editor.view.dom.dispatchEvent(event);
    return event.clipboardData?.getData('text/html') ?? '';
}

test('a copied paragraph holding a note pastes as one paragraph with the note', () => {
    const page = body(new Y.Doc());
    page.commands.setContent({ type: 'doc', content: [withNote] });
    const copied = page.getJSON().content;
    page.commands.selectAll();
    const html = cutOrCopy(page, 'copy');

    const target = body(new Y.Doc());
    target.view.pasteHTML(html);
    expect(target.getJSON().content).toEqual(copied);
});

test('a cut takes the note with its paragraph, and undo brings both back', () => {
    const doc = new Y.Doc();
    const page = body(doc);
    page.commands.setContent({
        type: 'doc',
        content: [withNote, { type: 'paragraph', content: [{ type: 'text', text: 'After' }] }],
    });
    const undoManager = yUndoPluginKey.getState(page.state)?.undoManager;
    undoManager?.clear();
    const cut = page.getJSON().content?.[0];
    page.commands.setTextSelection({ from: 1, to: (page.state.doc.firstChild?.nodeSize ?? 0) - 1 });
    cutOrCopy(page, 'cut');
    expect(page.state.doc.firstChild?.childCount).toBe(0);
    page.commands.undo();
    expect(page.getJSON().content?.[0]).toEqual(cut);
});

// Its note belongs to the body's text, which the band would otherwise take as its own.
test('a note pasted into a band drops, note and all', () => {
    const page = body(new Y.Doc());
    page.commands.setContent({ type: 'doc', content: [withNote] });
    page.commands.selectAll();
    const html = cutOrCopy(page, 'copy');
    const header = mount(new Y.Doc(), HEADER);
    header.view.pasteHTML(html);
    expect(header.getText()).toBe('Claim end.');
});

// A note's text draws at 10 pt, which its size box shows, so a step goes from 10, as the body's goes from its Normal.
test('a size step in a note steps from the footnote size', () => {
    const doc = new Y.Doc();
    const sizes = (editor: InstanceType<typeof Editor>) => {
        const found: unknown[] = [];
        editor.state.doc.descendants((node) => {
            if (node.isText) found.push(node.marks.find((mark) => mark.type.name === 'textStyle')?.attrs['fontSize']);
        });
        return found;
    };
    const note = mount(doc, { body: () => null, onLeave: () => {} });
    note.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'See' }] }],
    });
    note.commands.selectAll();
    note.commands.stepFontSize(1);
    expect(sizes(note)).toEqual([11]);
    note.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'See' }] }],
    });
    note.commands.selectAll();
    note.commands.stepFontSize(-1);
    expect(sizes(note)).toEqual([9]);
    expect(note.storage.eigenFontSize.normalStyle().size).toBe(10);

    const page = body(doc);
    page.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'See' }] }],
    });
    page.commands.selectAll();
    page.commands.stepFontSize(1);
    expect(sizes(page)).toEqual([12]);
});

type PageSetup = typeof DEFAULT_PAGE_SETUP;

// A text column of 108 mm, 408 px.
const A5: PageSetup = { ...DEFAULT_PAGE_SETUP, width: 148, height: 210 };
// A text column of 259.4 mm, 980.4 px.
const LETTER_LANDSCAPE: PageSetup = {
    ...DEFAULT_PAGE_SETUP,
    width: 279.4,
    height: 215.9,
    margin: { top: 10, right: 10, bottom: 10, left: 10 },
};

function setPage(doc: InstanceType<typeof Y.Doc>, setup: PageSetup) {
    const page = doc.getMap(PAGE_ROOT);
    for (const [key, value] of Object.entries(pageRecord(setup))) page.set(key, value);
}

const wideTable = {
    type: 'table',
    content: [
        {
            type: 'tableRow',
            content: [490, 490].map((width) => ({
                type: 'tableCell',
                attrs: { colwidth: [width] },
                content: [{ type: 'paragraph' }],
            })),
        },
    ],
};

const colwidths = (editor: InstanceType<typeof Editor>) => {
    const found: unknown[] = [];
    editor.state.doc.descendants((node) => {
        if (node.type.name === 'tableCell') found.push(node.attrs['colwidth']);
    });
    return found;
};

// A docx imported into an open doc lands as one update holding the content and the page. The page on screen still
// draws the old page until React reads the new one, after the clamp has run.
test('a remote update that brings a wide table and a page it fits keeps the table, while the old page is on screen', () => {
    const doc = new Y.Doc();
    setPage(doc, A5);
    const onScreen = document.body.appendChild(document.createElement('div'));
    onScreen.setAttribute('data-document', '');
    Object.defineProperty(onScreen, 'clientWidth', { value: 408 });
    const editor = body(doc);

    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    remote.transact(() => {
        setPage(remote, LETTER_LANDSCAPE);
        prosemirrorJSONToYXmlFragment(
            editor.schema,
            { type: 'doc', content: [wideTable] },
            remote.getXmlFragment('default'),
        );
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc)));
    onScreen.remove();

    expect(colwidths(editor)).toEqual([[490], [490]]);
});

test('a table wider than a narrower page shrinks to its text column at the next edit', () => {
    const doc = new Y.Doc();
    setPage(doc, LETTER_LANDSCAPE);
    const editor = body(doc);
    editor.commands.setContent({ type: 'doc', content: [wideTable, { type: 'paragraph' }] });
    expect(colwidths(editor)).toEqual([[490], [490]]);

    setPage(doc, A5);
    expect(colwidths(editor)).toEqual([[490], [490]]);
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, 'x');
    expect(colwidths(editor)).toEqual([[204], [204]]);
});

// A5's 108 mm column is 306.15 pt to Word's twentieth; a band prints in the body's column.
test('an indent stops at the text column of the page the doc holds, in the body and a band', () => {
    const doc = new Y.Doc();
    setPage(doc, A5);
    for (const editor of [body(doc), mount(doc, HEADER)]) {
        editor.commands.setContent({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
        });
        editor.commands.setTextSelection(1);
        editor.commands.setParagraphFormat({ indentLeft: 1000, indentFirstLine: -1000 });
        expect(editor.state.doc.firstChild?.attrs).toMatchObject({ indentLeft: 306.15, indentFirstLine: -306.15 });
    }
});

// The uploads below land through the real media resolver; the upload answers when the test lets it.
const { renderInDocument } = await import('@workspace/ui/test/render-in-document');
const { act, createElement, useState } = await import('react');
const { AuthProvider } = await import('@workspace/lib/auth');
const { MediaResolverProvider } = await import('@workspace/lib/drive');
const { DRIVE_MIME_DOC } = await import('@workspace/lib/types/drive');
const { drivePath } = await import('@workspace/ui/test/drive-path');
const { useDocEditor, useDocMedia } = await import('../../../components/docs/doc-editor');

type Media = ReturnType<typeof useDocMedia>;

const path = drivePath({ name: 'Letter', mimeType: DRIVE_MIME_DOC });

let finishUpload = (_name: string) => {};
spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
            if (init?.method !== 'POST') return Response.json(null);
            const name = await new Promise<string>((resolve) => {
                finishUpload = resolve;
            });
            return Response.json([{ ...path, id: name, name, parentId: 'media', mimeType: 'image/png' }]);
        },
        { preconnect: fetch.preconnect },
    ),
);

let unmount = async () => {};
afterEach(() => unmount());

function render(child: ReturnType<typeof createElement>) {
    return renderInDocument(
        createElement(
            AuthProvider,
            null,
            createElement(MediaResolverProvider, {
                ownerId: path.ownerId,
                mountId: path.mountId,
                mediaFolderId: 'media',
                chatFolderId: null,
                children: child,
            }),
        ),
    );
}

const logo = new File(['png'], 'logo.png', { type: 'image/png' });

async function settleUpload(name: string) {
    await act(async () => {
        finishUpload(name);
        await new Promise((resolve) => setTimeout(resolve, 10));
    });
}

// A comment click's handler changes with the layout, and the body's editor is built anew with it.
test('a body upload that settles after its editor was built anew swaps the name in the new editor', async () => {
    const doc = new Y.Doc();
    const undoManager = createDocUndoManager(doc);
    const rendered: { body: { editor: InstanceType<typeof Editor>; media: Media } | null } = { body: null };
    let rebuild = () => {};
    function Body() {
        const [generation, setGeneration] = useState(0);
        rebuild = () => setGeneration((n) => n + 1);
        const media = useDocMedia(path);
        const editor = useDocEditor(
            {
                media,
                yDoc: doc,
                provider: null,
                editable: true,
                target: { undoManager, cardIds: () => new Set() },
            },
            [generation],
        );
        rendered.body = { editor, media };
        return null;
    }
    ({ unmount } = await render(createElement(Body)));
    if (!rendered.body) throw new Error('no editor');
    const { editor: first, media } = rendered.body;
    const upload = media.uploadImage(() => rendered.body?.editor ?? null, logo);
    expect(doc.getXmlFragment('default').toString()).toContain('mediaName="pending:');

    await act(async () => rebuild());
    expect(rendered.body?.editor).not.toBe(first);
    await settleUpload('logo-1.png');
    await upload;
    expect(doc.getXmlFragment('default').toString()).toContain('mediaName="logo-1.png"');
});

// A tab closed mid-upload leaves a pending name that a writer's tab sweeps a minute after opening the doc. A viewer's
// deletion would be dropped by the server.
test.each([
    ["a writer's editor sweeps", true, '<paragraph>Acme</paragraph>'],
    ['a read-only editor leaves', false, '<paragraph>Acme<figure mediaName="pending:gone"></figure></paragraph>'],
])('%s a pending image a closed tab left', async (_, editable, left) => {
    const doc = new Y.Doc();
    const figure = new Y.XmlElement('figure');
    figure.setAttribute('mediaName', 'pending:gone');
    const paragraph = new Y.XmlElement('paragraph');
    // Beside text: y-tiptap writes nothing back while the doc reads as a fresh editor's single empty paragraph.
    paragraph.insert(0, [new Y.XmlText('Acme'), figure]);
    doc.getXmlFragment('header').insert(0, [paragraph]);
    function Band() {
        useDocEditor({
            media: useDocMedia(path),
            yDoc: doc,
            provider: null,
            editable,
            target: HEADER,
        });
        return null;
    }
    jest.useFakeTimers();
    try {
        ({ unmount } = await render(createElement(Band)));
        await act(async () => void jest.advanceTimersByTime(61_000));
    } finally {
        jest.useRealTimers();
    }
    expect(doc.getXmlFragment('header').toString()).toBe(left);
});

const { useOpenNote } = await import('../../../components/docs/hooks/use-open-note');

// An image pasted into the open note lands there, and once its upload settles the note shows it under its name.
test('an image pasted into the open note settles in the note', async () => {
    const doc = new Y.Doc();
    const undoManager = createDocUndoManager(doc);
    const shown: {
        body: InstanceType<typeof Editor> | null;
        note: InstanceType<typeof Editor> | null;
        session: ReturnType<typeof useOpenNote> | null;
    } = { body: null, note: null, session: null };
    function Host() {
        const media = useDocMedia(path);
        const body = useDocEditor({
            media,
            yDoc: doc,
            provider: null,
            editable: true,
            target: { undoManager, cardIds: () => new Set() },
        });
        const note = useDocEditor({
            media,
            yDoc: doc,
            provider: null,
            editable: true,
            target: { body: () => shown.body, onLeave: () => {} },
        });
        shown.body = body;
        shown.note = note;
        shown.session = useOpenNote(body, note, true);
        return null;
    }
    ({ unmount } = await render(createElement(Host)));
    const { body, note } = shown;
    if (!body || !note) throw new Error('no editors');
    await act(async () => {
        body.commands.setContent({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'x' },
                        { type: 'footnote', content: [{ type: 'paragraph' }] },
                    ],
                },
            ],
        });
    });
    await act(async () => shown.session?.open(2, { focus: true, at: null, selection: null }));

    // Bun's own File, whose bytes the upload's object URL reads, as the clipboard's file.
    const data = new DataTransfer();
    Object.defineProperty(data, 'files', { value: [logo] });
    await act(async () => {
        note.view.dom.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
    });
    expect(doc.getXmlFragment('default').toString()).toContain('mediaName="pending:');
    await settleUpload('logo-2.png');
    expect(doc.getXmlFragment('default').toString()).toContain('mediaName="logo-2.png"');
    const names: unknown[] = [];
    note.state.doc.descendants((node) => {
        if (node.type.name === 'figure') names.push(node.attrs.mediaName);
    });
    expect(names).toEqual(['logo-2.png']);
    expect(shown.session?.anchor).not.toBeNull();
});

// A stored stack collapses to its name in a note's text too, which NoteFormatting would otherwise give back.
test("the font-name pass reaches a note's text", async () => {
    const doc = new Y.Doc();
    const stack = (font: string) => [{ type: 'textStyle', attrs: { fontFamily: `'${font}', serif` } }];
    const fragment = doc.getXmlFragment('default');
    prosemirrorJSONToYXmlFragment(
        getSchema(getDocExtensions()),
        {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'Body', marks: stack('Source Serif 4') },
                        {
                            type: 'footnote',
                            content: [
                                {
                                    type: 'paragraph',
                                    content: [{ type: 'text', text: 'Note', marks: stack('Source Serif 4') }],
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        fragment,
    );
    function Body() {
        useDocEditor({
            media: useDocMedia(path),
            yDoc: doc,
            provider: null,
            editable: true,
            target: { undoManager: createDocUndoManager(doc), cardIds: () => new Set() },
        });
        return null;
    }
    ({ unmount } = await render(createElement(Body)));
    expect(fragment.toString().match(/fontFamily="[^"]*"/g)).toEqual([
        'fontFamily="Source Serif 4"',
        'fontFamily="Source Serif 4"',
    ]);
});
