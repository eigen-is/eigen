// The toolbar draws the marks and the block at the caret, and a caret move is a transaction that changes no content.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor } = await import('@tiptap/react');
const { DEFAULT_NORMAL_STYLE, getDocExtensions, readNormalStyle, STYLE_ROOT } = await import(
    '@workspace/lib/docs/eigendoc'
);
const Y = await import('yjs');
const { useToolbarState } = await import('../../../../components/docs/hooks/use-toolbar-state');
const { useYMapRead } = await import('../../../../components/docs/hooks/use-y-map-read');

let unmount = async () => {};
afterEach(() => unmount());

// The doc's Normal, as the style map would hold it.
let normal = DEFAULT_NORMAL_STYLE;

// "plain " at 1-7, the bold Source Serif 4 "caps" at 7-11, then a heading.
const editor = new Editor({
    extensions: getDocExtensions({ normalStyle: () => normal }),
    content: {
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'plain ' },
                    {
                        type: 'text',
                        text: 'caps',
                        marks: [{ type: 'bold' }, { type: 'textStyle', attrs: { fontFamily: 'Source Serif 4' } }],
                    },
                ],
            },
            { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        ],
    },
});

let seen: ReturnType<typeof useToolbarState>[] = [];
function Probe({ of = editor }: { of?: typeof editor }) {
    seen.push(useToolbarState(of));
    return null;
}

test('a caret move alone updates what the toolbar draws', async () => {
    editor.commands.setTextSelection(3);
    ({ unmount } = await renderInDocument(createElement(Probe)));
    expect(seen.at(-1)).toMatchObject({ bold: false, fontName: 'Inter', paragraphStyle: undefined });

    const before = editor.state.doc;
    await act(async () => editor.commands.setTextSelection(9));
    expect(editor.state.doc).toBe(before);
    expect(seen.at(-1)).toMatchObject({ bold: true, fontName: 'Source Serif 4' });

    await act(async () => editor.commands.setTextSelection(14));
    expect(seen.at(-1)).toMatchObject({ bold: false, fontName: 'Inter', paragraphStyle: 'Heading 2' });
});

// Google's toolbar shows Normal text's font and size where the text sets none, and its line spacing ticks.
test("unformatted text reads as the doc's Normal, and a new Normal reaches the toolbar", async () => {
    editor.commands.setTextSelection(3);
    ({ unmount } = await renderInDocument(createElement(Probe)));
    expect(seen.at(-1)).toMatchObject({ fontName: 'Inter', fontSize: 11, lineSpacing: 1.4 });

    normal = { ...DEFAULT_NORMAL_STYLE, font: 'Source Serif 4', size: 12, lineSpacing: 1.15 };
    await unmount();
    ({ unmount } = await renderInDocument(createElement(Probe)));
    expect(seen.at(-1)).toMatchObject({ fontName: 'Source Serif 4', fontSize: 12, lineSpacing: 1.15 });

    // A heading draws its own size and line, which no CSS here gives.
    await act(async () => editor.commands.setTextSelection(14));
    expect(seen.at(-1)).toMatchObject({ fontName: 'Source Serif 4', lineSpacing: undefined });
    normal = DEFAULT_NORMAL_STYLE;
});

// A peer's new Normal is no transaction of this editor: it reaches the toolbar through the style map's reader, which
// renders the toolbar again, as the editor's page does.
test("a peer's new Normal reaches the toolbar live", async () => {
    const yDoc = new Y.Doc();
    const styles = yDoc.getMap(STYLE_ROOT);
    const live = new Editor({
        extensions: getDocExtensions({ normalStyle: () => readNormalStyle(styles.toJSON()) }),
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain' }] }] },
    });
    live.commands.setTextSelection(3);
    function Page() {
        useYMapRead(styles, readNormalStyle);
        return createElement(Probe, { of: live });
    }
    ({ unmount } = await renderInDocument(createElement(Page)));
    expect(seen.at(-1)).toMatchObject({ fontName: 'Inter', fontSize: 11, lineSpacing: 1.4 });

    const peer = new Y.Doc();
    const set = { font: 'Source Serif 4', size: 12, lineSpacing: 1.15 };
    for (const [key, value] of Object.entries(set)) peer.getMap(STYLE_ROOT).set(key, value);
    await act(async () => Y.applyUpdate(yDoc, Y.encodeStateAsUpdate(peer)));
    expect(seen.at(-1)).toMatchObject({ fontName: 'Source Serif 4', fontSize: 12, lineSpacing: 1.15 });
    live.destroy();
});

test('a caret move that changes nothing drawn renders nothing', async () => {
    editor.commands.setTextSelection(2);
    ({ unmount } = await renderInDocument(createElement(Probe)));
    seen = [];
    await act(async () => editor.commands.setTextSelection(4));
    expect(seen).toEqual([]);
});

// The first 10,000 positions are read as a range, as a check over the whole selection would cost every transaction a walk of it.
test('a long selection draws what its first 10,000 positions are, a short one what all of it is', async () => {
    const words = 'plain words that run on '.repeat(4);
    const long = new Editor({
        extensions: getDocExtensions(),
        content: {
            type: 'doc',
            content: Array.from({ length: 20_000 }, (_, index) => ({
                type: 'paragraph',
                content: [
                    { type: 'text', text: `Item ${index} `, marks: [{ type: 'bold' }] },
                    { type: 'text', text: words },
                ],
            })),
        },
    });
    long.commands.setTextSelection({ from: 1, to: 9000 });
    ({ unmount } = await renderInDocument(createElement(Probe, { of: long })));
    expect(seen.at(-1)).toMatchObject({ bold: false, selectionEmpty: false });

    await act(async () => long.commands.selectAll());
    expect(seen.at(-1)).toMatchObject({ bold: false, selectionEmpty: false });

    // CPU time against a selection under the cap, so load slows both. Capped, the whole document costs about five times
    // what 9,000 positions do, and read whole, over a hundred times. A first round warms the JIT.
    const cost = async () => {
        const started = process.cpuUsage();
        for (let index = 0; index < 20; index++)
            await act(async () => long.view.dispatch(long.state.tr.setMeta('remote', index)));
        const { user, system } = process.cpuUsage(started);
        return user + system;
    };
    await cost();
    const all = await cost();
    await act(async () => long.commands.setTextSelection({ from: 1, to: 9000 }));
    const short = await cost();
    expect(all).toBeLessThan(20 * short);
    long.destroy();
});

// A caret takes the marks and the block before it, so a long selection starting after them must not.
test('a long selection starting after a bold word or a heading reads none of them', async () => {
    const plain = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    const long = new Editor({
        extensions: getDocExtensions(),
        content: {
            type: 'doc',
            content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }] },
                ...Array.from({ length: 3000 }, () => plain('plain words that run on')),
                { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
                ...Array.from({ length: 3000 }, () => plain('plain words that run on')),
            ],
        },
    });
    long.commands.setTextSelection({ from: 5, to: long.state.doc.content.size - 1 });
    ({ unmount } = await renderInDocument(createElement(Probe, { of: long })));
    expect(seen.at(-1)).toMatchObject({ bold: false, paragraphStyle: undefined });

    let headingEnd = 0;
    long.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') headingEnd = pos + node.nodeSize - 1;
    });
    await act(async () => long.commands.setTextSelection({ from: headingEnd, to: long.state.doc.content.size - 1 }));
    expect(seen.at(-1)).toMatchObject({ bold: false, paragraphStyle: undefined });
    long.destroy();
});

// Tiptap's isActive sums the ranges of the nodes an attribute matches, and a list's own range counts against them,
// so a centred paragraph and a centred list item would read left.
test('a range reads the alignment all its blocks share, and none when they differ', async () => {
    const paragraph = (text: string, textAlign: string) => ({
        type: 'paragraph',
        attrs: { textAlign },
        content: [{ type: 'text', text }],
    });
    // "centred" at 1-8, the list item's "item" at 12-16, "right" at 20-25.
    const aligned = new Editor({
        extensions: getDocExtensions(),
        content: {
            type: 'doc',
            content: [
                paragraph('centred', 'center'),
                { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph('item', 'center')] }] },
                paragraph('right', 'right'),
            ],
        },
    });
    aligned.commands.setTextSelection({ from: 2, to: 14 });
    ({ unmount } = await renderInDocument(createElement(Probe, { of: aligned })));
    expect(seen.at(-1)?.alignment).toBe('center');

    await act(async () => aligned.commands.setTextSelection({ from: 2, to: 22 }));
    expect(seen.at(-1)?.alignment).toBeUndefined();

    await act(async () => aligned.commands.setTextSelection(22));
    expect(seen.at(-1)?.alignment).toBe('right');
    aligned.destroy();
});

// setTextAlign aligns every cell of a cell selection, which ProseMirror's from and to span only one of.
test('a cell selection reads the alignment all its cells share, and none when they differ', async () => {
    const cell = (text: string, textAlign: string | null) => ({
        type: 'tableCell',
        content: [{ type: 'paragraph', attrs: { textAlign }, content: [{ type: 'text', text }] }],
    });
    const row = (left: string, leftAlign: string | null) => ({
        type: 'tableRow',
        content: [cell(left, leftAlign), cell(`${left}2`, 'center')],
    });
    // Column A left, then right in the last row; column B centred.
    const table = new Editor({
        extensions: getDocExtensions(),
        content: {
            type: 'doc',
            content: [{ type: 'table', content: [row('a', null), row('b', null), row('c', 'right')] }],
        },
    });
    const cells: number[] = [];
    table.state.doc.descendants((node, pos) => {
        if (node.type.name === 'tableCell') cells.push(pos);
    });
    const select = (anchorCell = 0, headCell = 0) => table.commands.setCellSelection({ anchorCell, headCell });
    select(cells[0], cells[2]);
    ({ unmount } = await renderInDocument(createElement(Probe, { of: table })));
    expect(seen.at(-1)?.alignment).toBe('left');

    await act(async () => select(cells[1], cells[5]));
    expect(seen.at(-1)?.alignment).toBe('center');

    await act(async () => select(cells[0], cells[4]));
    expect(seen.at(-1)?.alignment).toBeUndefined();
    table.destroy();
});

test('a range over two heading levels reads no level', async () => {
    const heading = (level: number, text: string) => ({
        type: 'heading',
        attrs: { level },
        content: [{ type: 'text', text }],
    });
    // "Two" at 1-4, "Three" at 6-11.
    const headings = new Editor({
        extensions: getDocExtensions(),
        content: { type: 'doc', content: [heading(2, 'Two'), heading(3, 'Three')] },
    });
    headings.commands.setTextSelection({ from: 2, to: 3 });
    ({ unmount } = await renderInDocument(createElement(Probe, { of: headings })));
    expect(seen.at(-1)).toMatchObject({ paragraphStyle: 'Heading 2', mixedStyles: false });

    await act(async () => headings.commands.setTextSelection({ from: 2, to: 8 }));
    expect(seen.at(-1)).toMatchObject({ paragraphStyle: undefined, mixedStyles: true });
    headings.destroy();
});

test('outside a table no transaction tries the cell commands', async () => {
    editor.commands.setTextSelection(2);
    const can = spyOn(editor, 'can');
    ({ unmount } = await renderInDocument(createElement(Probe)));
    await act(async () => editor.commands.setTextSelection(4));
    expect(can).not.toHaveBeenCalled();
    can.mockRestore();
});

// Google's size box: the size the selection draws at, and empty for a mix.
test("the size reads the body's 11 pt where none is set, 9 for Small, and none for a mix", async () => {
    // "body " at 1-6, the Small "fine " at 6-11, the 14 pt "big" at 11-14.
    const sized = new Editor({
        extensions: getDocExtensions(),
        content: {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'body ' },
                        { type: 'text', text: 'fine ', marks: [{ type: 'small' }] },
                        { type: 'text', text: 'big', marks: [{ type: 'textStyle', attrs: { fontSize: 14 } }] },
                    ],
                },
            ],
        },
    });
    sized.commands.setTextSelection(3);
    ({ unmount } = await renderInDocument(createElement(Probe, { of: sized })));
    expect(seen.at(-1)?.fontSize).toBe(11);

    await act(async () => sized.commands.setTextSelection(8));
    expect(seen.at(-1)?.fontSize).toBe(9);

    await act(async () => sized.commands.setTextSelection({ from: 11, to: 14 }));
    expect(seen.at(-1)?.fontSize).toBe(14);

    await act(async () => sized.commands.setTextSelection({ from: 2, to: 14 }));
    expect(seen.at(-1)?.fontSize).toBeUndefined();
    sized.destroy();
});

// A heading draws its own size, which the toolbar reads off the page; happy-dom has no prose CSS, so the page is stubbed
// with eigen-prose.css's 1.75rem.
test("the size in an unsized heading is the heading's drawn size, a sized run its own", async () => {
    const computed = spyOn(globalThis, 'getComputedStyle').mockImplementation((element) => {
        const { style } = document.createElement('p');
        style.fontSize = element.tagName === 'H1' ? '28px' : '14.6667px';
        return style;
    });
    // "Plan " at 1-6, the 30 pt "big" at 6-9.
    const heading = new Editor({
        extensions: getDocExtensions(),
        content: {
            type: 'doc',
            content: [
                {
                    type: 'heading',
                    attrs: { level: 1 },
                    content: [
                        { type: 'text', text: 'Plan ' },
                        { type: 'text', text: 'big', marks: [{ type: 'textStyle', attrs: { fontSize: 30 } }] },
                    ],
                },
            ],
        },
    });
    heading.commands.setTextSelection(3);
    ({ unmount } = await renderInDocument(createElement(Probe, { of: heading })));
    expect(seen.at(-1)?.fontSize).toBe(21);

    await act(async () => heading.commands.setTextSelection({ from: 6, to: 9 }));
    expect(seen.at(-1)?.fontSize).toBe(30);
    computed.mockRestore();
    heading.destroy();
});
