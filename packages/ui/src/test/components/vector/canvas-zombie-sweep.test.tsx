// An image a closed tab left with its upload's pending name is swept from the canvas a minute after it opens, by a
// tab that may edit. A reader's sweep would be dropped by the server and leave their copy unlike everyone else's.
import { afterAll, afterEach, expect, jest, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, useEffect, useRef } = await import('react');
const realCollab = await import('@workspace/lib/collab');
const { MediaResolverProvider, PENDING_PREFIX } = await import('@workspace/lib/drive');
const { generateNKeysBetween, readVectorFromDoc, VECTOR_STYLE_DEFAULTS, writeElementInDoc } = await import(
    '@workspace/lib/vector'
);
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

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    jest.useRealTimers();
});

// A drawing holding one image whose upload never landed, opened a minute ago; returns the doc's updates since.
async function openAMinute(canEdit: boolean): Promise<number> {
    provider.destroy();
    doc = new Y.Doc();
    provider = new WebsocketProvider('ws://localhost:1', 'test', doc, { connect: false });
    const [key] = generateNKeysBetween(null, null, 1);
    writeElementInDoc(
        doc,
        { type: 'image', x: 0, y: 0, width: 100, height: 100, mediaName: `${PENDING_PREFIX}lost` },
        key,
        VECTOR_STYLE_DEFAULTS,
        'img',
    );
    let updates = 0;
    doc.on('update', () => updates++);
    jest.useFakeTimers();
    function Host() {
        const canvas = useCanvasDoc('owner', 'mount', 'drawing', VECTOR_STYLE_DEFAULTS);
        // A host mounts the canvas once the doc has been read, as Slides does once it has a frame.
        if (canvas.elements.length === 0) return null;
        return createElement(CanvasEditor, {
            onCommentHover: () => {},
            doc: canvas,
            viewport: 'infinite',
            styleDefaults: VECTOR_STYLE_DEFAULTS,
            tool: 'select',
            setTool: () => {},
            toolLocked: false,
            setToolLocked: () => {},
            canEdit,
            ownerId: 'owner',
            mountId: 'mount',
            fileName: 'Plan',
            selectedIds: [],
            setSelectedIds: () => {},
            toggle: () => {},
            aspectLocked: false,
            publishCursor: () => {},
            canvasRef: { current: null },
            onTextEditingChange: () => {},
        });
    }
    ({ unmount } = await renderInDocument(
        createElement(MediaResolverProvider, {
            ownerId: 'owner',
            mountId: 'mount',
            mediaFolderId: 'media',
            chatFolderId: null,
            children: createElement(Host),
        }),
    ));
    await act(async () => jest.advanceTimersByTime(60_000));
    return updates;
}

test('a writer sweeps the image whose upload never landed', async () => {
    expect(await openAMinute(true)).toBe(1);
    expect(readVectorFromDoc(doc).elements).toEqual([]);
});

test("a reader's canvas leaves the document as it is", async () => {
    expect(await openAMinute(false)).toBe(0);
    expect(readVectorFromDoc(doc).elements.map((el) => el.id)).toEqual(['img']);
});
