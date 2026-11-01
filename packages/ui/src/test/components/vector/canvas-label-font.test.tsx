// An arrow label's width is measured on a canvas at commit and stored. Each face is cut into unicode-range slices, and
// a canvas measures a character whose slice has not loaded in the fallback. So a label committed before its slices
// arrive is measured again once the slices of its own text have loaded.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

// The font set as a sliced face behaves: a load fetches the slices of its text, and a check without text tests a
// space. Nothing loads until the test releases the network.
let release = () => {};
const network = new Promise<void>((resolve) => {
    release = resolve;
});
const loaded = new Set<string>();
const fontCalls: string[] = [];
Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
        ready: Promise.resolve(),
        check: (_font: string, text = ' ') => {
            fontCalls.push(`check ${JSON.stringify(text)}`);
            return [...text].every((char) => loaded.has(char));
        },
        load: async (_font: string, text = ' ') => {
            fontCalls.push(`load ${JSON.stringify(text)}`);
            await network;
            for (const char of text) loaded.add(char);
            return [];
        },
    },
});
// A character measures 10 px in the fallback and 20 px once its slice has loaded.
const measureText = (line: string) => ({ width: [...line].reduce((w, char) => w + (loaded.has(char) ? 20 : 10), 0) });
Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => ({ font: '', measureText }),
});

const Y = await import('yjs');
const { WebsocketProvider } = await import('y-websocket');
const { act, createElement, useEffect, useRef, useState } = await import('react');
const realCollab = await import('@workspace/lib/collab');
const { MediaResolverProvider } = await import('@workspace/lib/drive');
const { readVectorFromDoc, VECTOR_STYLE_DEFAULTS, writeElementInDoc } = await import('@workspace/lib/vector');
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
    writeElementInDoc(
        doc,
        { type: 'arrow', x: 0, y: 0, width: 200, height: 0, points: '[[0,0],[200,0]]' },
        'a0',
        VECTOR_STYLE_DEFAULTS,
        'arrow',
    );
});

let unmount = async () => {};
afterEach(() => unmount());

async function render(): Promise<HTMLElement> {
    function Host() {
        const canvas = useCanvasDoc('owner', 'mount', 'drawing', VECTOR_STYLE_DEFAULTS);
        const [selectedIds, setSelectedIds] = useState<string[]>([]);
        return createElement(CanvasEditor, {
            doc: canvas,
            viewport: 'infinite',
            styleDefaults: VECTOR_STYLE_DEFAULTS,
            tool: 'select',
            setTool: () => {},
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
    return rendered.container;
}

const labelWidth = () => {
    const arrow = readVectorFromDoc(doc).elements.find((el) => el.id === 'arrow');
    return arrow?.type === 'arrow' ? arrow.labelWidth : undefined;
};

test('a label committed before its slices load is measured again in the slices of its own text', async () => {
    const container = await render();
    const layer = container.querySelector('[data-element-id="arrow"]');
    if (!layer) throw new Error('no arrow layer');
    await act(async () => {
        layer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 0 }));
    });
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('the label editor did not open');
    await act(async () => {
        textarea.value = '茶 tea';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    fontCalls.length = 0;
    await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    // Five characters, each in the fallback.
    expect(labelWidth()).toBe(50);
    expect(fontCalls).toEqual(['check "茶 tea"', 'load "茶 tea"']);

    await act(async () => {
        release();
        await network;
    });
    expect(labelWidth()).toBe(100);
});
