// An Escape the canvas uses, to deselect or to drop back to the select tool, is marked as used, so a detail column
// beside it stays open until the next one. An Escape with nothing to cancel is left for the column.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, useEffect, useRef, useState } = await import('react');
const realCollab = await import('@workspace/lib/collab');
const { MediaResolverProvider } = await import('@workspace/lib/drive');
const { generateNKeysBetween, VECTOR_STYLE_DEFAULTS, writeElementInDoc } = await import('@workspace/lib/vector');
type VectorTool = import('../../../components/vector/hooks/use-tool').VectorTool;
type UseCollabDocOptions = Parameters<typeof realCollab.useCollabDoc>[0];

let doc = new Y.Doc();
let provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
mock.module('@workspace/lib/collab', () => ({
    ...realCollab,
    useCollabDoc: (options: UseCollabDocOptions) => {
        const docRef = useRef(doc);
        const onInit = useRef(options.onInit);
        useEffect(() => onInit.current?.({ doc, provider, undoManager: null }), []);
        return {
            doc,
            docRef,
            provider,
            undoManager: null,
            synced: true,
            offline: false,
            loaded: true,
            storageUnavailable: false,
            storageGone: false,
            unsyncedEdits: false,
        };
    },
}));
afterAll(() => {
    mock.module('@workspace/lib/collab', () => realCollab);
    provider.destroy();
});

const { CanvasEditor, useCanvasDoc } = await import('../../../components/vector');

beforeEach(() => {
    provider.destroy();
    doc = new Y.Doc();
    provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
    const [key] = generateNKeysBetween(null, null, 1);
    writeElementInDoc(
        doc,
        { type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
        key,
        VECTOR_STYLE_DEFAULTS,
        'box',
    );
});

let unmount = async () => {};
afterEach(() => unmount());

let selection: string[] = [];
let toolPicks: VectorTool[] = [];

async function render(tool: VectorTool, selected: string[]) {
    toolPicks = [];
    function Host() {
        const canvas = useCanvasDoc('owner', 'mount', 'drawing', VECTOR_STYLE_DEFAULTS);
        const [selectedIds, setSelectedIds] = useState(selected);
        selection = selectedIds;
        return createElement(CanvasEditor, {
            onCommentHover: () => {},
            doc: canvas,
            viewport: 'infinite',
            styleDefaults: VECTOR_STYLE_DEFAULTS,
            tool,
            setTool: (picked: VectorTool) => toolPicks.push(picked),
            toolLocked: false,
            setToolLocked: () => {},
            canEdit: true,
            ownerId: 'owner',
            mountId: 'mount',
            fileName: 'Plan',
            selectedIds,
            setSelectedIds,
            toggle: () => {},
            aspectLocked: false,
            publishCursor: () => {},
            canvasRef: { current: null },
            onTextEditingChange: () => {},
        });
    }
    const rendered = await renderInDocument(
        createElement(MediaResolverProvider, {
            ownerId: 'owner',
            mountId: 'mount',
            mediaFolderId: 'media',
            chatFolderId: null,
            children: createElement(Host),
        }),
    );
    unmount = rendered.unmount;
    await act(async () => {});
}

async function pressEscape(): Promise<boolean> {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => {
        document.body.dispatchEvent(event);
    });
    return event.defaultPrevented;
}

test('an Escape that deselects is marked as used', async () => {
    await render('select', ['box']);
    expect(await pressEscape()).toBe(true);
    expect(selection).toEqual([]);
});

test('an Escape that drops back to the select tool is marked as used', async () => {
    await render('rectangle', []);
    expect(await pressEscape()).toBe(true);
    expect(toolPicks).toEqual(['select']);
});

test('an Escape with nothing selected and the select tool on is left alone', async () => {
    await render('select', []);
    expect(await pressEscape()).toBe(false);
});
