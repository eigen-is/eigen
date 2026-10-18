// ⌘Z takes back a page setup change as one step, with y-tiptap's own undo settings for the body, and OK writes
// only what the user changed.
import { expect, test } from 'bun:test';
import type { PageSetup } from '@workspace/lib/docs/eigendoc';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const Y = await import('yjs');
const { Editor } = await import('@tiptap/react');
const { default: Collaboration } = await import('@tiptap/extension-collaboration');
const { yUndoPluginKey, ySyncPluginKey } = await import('@tiptap/y-tiptap');
const { DEFAULT_PAGE_SETUP, getDocExtensions, PAGE_ROOT, readPageSetup } = await import('@workspace/lib/docs/eigendoc');
const { createDocUndoManager, writePageSetup } = await import('../../../components/docs/page-setup');

const LETTER_LANDSCAPE: PageSetup = {
    width: 279.4,
    height: 215.9,
    margin: { top: 25.4, right: 12.7, bottom: 25.4, left: 30 },
    differentFirstPage: false,
};

function mount() {
    const doc = new Y.Doc();
    const undoManager = createDocUndoManager(doc);
    const editor = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        extensions: [...getDocExtensions(), Collaboration.configure({ document: doc, yUndoOptions: { undoManager } })],
    });
    return { doc, undoManager, editor };
}

test('⌘Z takes back a page setup change as its own step, then the typing before it', () => {
    const { doc, undoManager, editor } = mount();
    const page = () => readPageSetup(doc.getMap(PAGE_ROOT).toJSON());
    const undoState = () => yUndoPluginKey.getState(editor.state)?.undoManager;

    // The toolbar reads its undo state from the plugin, so the plugin must hold this manager.
    expect(undoState()).toBe(undoManager);

    // OK on an unchanged page: nothing to write, so nothing to undo.
    writePageSetup(doc, undoManager, DEFAULT_PAGE_SETUP, DEFAULT_PAGE_SETUP);
    expect(doc.getMap(PAGE_ROOT).size).toBe(0);
    expect(undoManager.undoStack.length).toBe(0);

    editor.commands.insertContent('Hello');
    writePageSetup(doc, undoManager, DEFAULT_PAGE_SETUP, LETTER_LANDSCAPE);
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

    editor.destroy();
});

// A band's Different first page box writes it as OK writes the page, so ⌘Z takes it back on its own.
test('Different first page is a page key, and turning it on is an undo step of the body', () => {
    const { doc, undoManager, editor } = mount();
    editor.commands.insertContent('Hello');
    writePageSetup(doc, undoManager, DEFAULT_PAGE_SETUP, { ...DEFAULT_PAGE_SETUP, differentFirstPage: true });
    expect(doc.getMap(PAGE_ROOT).toJSON()).toEqual({ differentFirstPage: true });
    expect(undoManager.undoStack.length).toBe(2);

    editor.commands.undo();
    expect(readPageSetup(doc.getMap(PAGE_ROOT).toJSON()).differentFirstPage).toBe(false);
    expect(editor.getText()).toBe('Hello');

    editor.destroy();
});

test("OK sets only the keys the user changed, so a collaborator's change to another survives", () => {
    const { doc, undoManager, editor } = mount();
    writePageSetup(doc, undoManager, DEFAULT_PAGE_SETUP, LETTER_LANDSCAPE);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.getMap(PAGE_ROOT).set('marginLeft', 40);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));

    const changed: string[][] = [];
    doc.getMap(PAGE_ROOT).observe((event) => changed.push([...event.keysChanged]));
    writePageSetup(doc, undoManager, LETTER_LANDSCAPE, {
        ...LETTER_LANDSCAPE,
        margin: { ...LETTER_LANDSCAPE.margin, top: 10 },
    });
    expect(changed).toEqual([['marginTop']]);
    expect(doc.getMap(PAGE_ROOT).get('marginLeft')).toBe(40);

    editor.destroy();
});

test("a peer's update, however it arrives, is no step of this tab's undo", () => {
    const { doc, undoManager, editor } = mount();
    const peer = new Y.Doc();
    const peerParagraph = new Y.XmlElement('paragraph');
    peerParagraph.insert(0, [new Y.XmlText('Theirs')]);
    peer.getXmlFragment('default').insert(0, [peerParagraph]);
    peer.getMap(PAGE_ROOT).set('width', 148);

    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), { provider: 'websocket' });
    expect(editor.getText()).toBe('Theirs');
    expect(readPageSetup(doc.getMap(PAGE_ROOT).toJSON()).width).toBe(148);
    expect(undoManager.undoStack.length).toBe(0);

    editor.destroy();
});

test('an editor change marked addToHistory: false is no undo step', () => {
    const { undoManager, editor } = mount();
    editor.view.dispatch(editor.state.tr.insertText('Restored', 1).setMeta('addToHistory', false));
    expect(editor.getText()).toBe('Restored');
    expect(undoManager.undoStack.length).toBe(0);

    editor.view.dispatch(editor.state.tr.insertText('Typed ', 1));
    expect(undoManager.undoStack.length).toBe(1);

    editor.destroy();
});

test("undoing a paragraph keeps it while a collaborator's text is in it; any other node goes", () => {
    const doc = new Y.Doc();
    const undoManager = createDocUndoManager(doc);
    const fragment = doc.getXmlFragment('default');
    const paragraph = new Y.XmlElement('paragraph');
    const heading = new Y.XmlElement('heading');
    const empty = new Y.XmlElement('paragraph');
    doc.transact(() => fragment.insert(0, [paragraph, heading, empty]), ySyncPluginKey);
    doc.transact(() => {
        paragraph.insert(0, [new Y.XmlText('Theirs')]);
        heading.insert(0, [new Y.XmlText('Theirs')]);
    }, 'peer');

    undoManager.undo();
    expect(fragment.toString()).toBe('<paragraph>Theirs</paragraph>');
});
