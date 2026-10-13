// The editor's page is the doc's page map as any peer leaves it, and ⌘Z takes back a page setup change as one step.
import { afterEach, expect, test } from 'bun:test';
import type { PageSetup } from '@workspace/lib/docs/eigendoc';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const Y = await import('yjs');
const { Editor } = await import('@tiptap/react');
const { default: Collaboration } = await import('@tiptap/extension-collaboration');
const { yUndoPluginKey } = await import('@tiptap/y-tiptap');
const { DEFAULT_PAGE_SETUP, getDocExtensions, PAGE_ROOT, pageRecord, readPageSetup } = await import(
    '@workspace/lib/docs/eigendoc'
);
const { createDocUndoManager, usePageSetup, writePageSetup } = await import(
    '../../../../components/docs/hooks/use-page-setup'
);

const LETTER_LANDSCAPE: PageSetup = {
    width: 279.4,
    height: 215.9,
    margin: { top: 25.4, right: 12.7, bottom: 25.4, left: 30 },
};

let unmount = async () => {};
afterEach(() => unmount());

let seen: PageSetup[] = [];
function Probe({ doc }: { doc: InstanceType<typeof Y.Doc> }) {
    seen.push(usePageSetup(doc));
    return null;
}

test('a page change a peer writes reaches the editor through the synced doc', async () => {
    const local = new Y.Doc();
    const peer = new Y.Doc();
    seen = [];
    ({ unmount } = await renderInDocument(createElement(Probe, { doc: local })));
    expect(seen.at(-1)).toEqual(DEFAULT_PAGE_SETUP);

    peer.transact(() => {
        for (const [key, value] of Object.entries(pageRecord(LETTER_LANDSCAPE))) peer.getMap(PAGE_ROOT).set(key, value);
    });
    await act(async () => Y.applyUpdate(local, Y.encodeStateAsUpdate(peer)));
    expect(seen.at(-1)).toEqual(LETTER_LANDSCAPE);

    // A forged value reads as the default, never as itself.
    peer.getMap(PAGE_ROOT).set('width', '1e9');
    await act(async () => Y.applyUpdate(local, Y.encodeStateAsUpdate(peer)));
    expect(seen.at(-1)?.width).toBe(DEFAULT_PAGE_SETUP.width);
});

test('⌘Z takes back a page setup change as its own step, then the typing before it', async () => {
    const doc = new Y.Doc();
    const undoManager = createDocUndoManager(doc);
    const editor = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        extensions: [...getDocExtensions(), Collaboration.configure({ document: doc, yUndoOptions: { undoManager } })],
    });
    const page = () => readPageSetup(doc.getMap(PAGE_ROOT).toJSON());
    const undoState = () => yUndoPluginKey.getState(editor.state)?.undoManager;

    // The toolbar reads its undo state from the plugin, so the plugin must hold this manager.
    expect(undoState()).toBe(undoManager);

    // The page as it reads already: nothing to write, so nothing to undo.
    writePageSetup(doc, undoManager, DEFAULT_PAGE_SETUP);
    expect(doc.getMap(PAGE_ROOT).size).toBe(0);
    expect(undoManager.undoStack.length).toBe(0);

    editor.commands.insertContent('Hello');
    writePageSetup(doc, undoManager, LETTER_LANDSCAPE);
    expect(page()).toEqual(LETTER_LANDSCAPE);
    expect(undoManager.undoStack.length).toBe(2);

    expect(editor.commands.undo()).toBe(true);
    expect(page()).toEqual(DEFAULT_PAGE_SETUP);
    expect(editor.getText()).toBe('Hello');
    expect(undoManager.redoStack.length).toBe(1);

    editor.commands.undo();
    expect(editor.getText()).toBe('');

    editor.commands.redo();
    editor.commands.redo();
    expect(editor.getText()).toBe('Hello');
    expect(page()).toEqual(LETTER_LANDSCAPE);

    // An unchanged key is not rewritten, so a peer's concurrent change to another key survives.
    const changed: string[][] = [];
    doc.getMap(PAGE_ROOT).observe((event) => changed.push([...event.keysChanged]));
    writePageSetup(doc, undoManager, { ...LETTER_LANDSCAPE, margin: { ...LETTER_LANDSCAPE.margin, top: 10 } });
    expect(changed).toEqual([['marginTop']]);

    editor.destroy();
});
