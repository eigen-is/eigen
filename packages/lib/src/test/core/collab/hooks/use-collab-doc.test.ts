import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type * as Y from 'yjs';
import type { CollabDoc, UseCollabDocOptions } from '../../../../core/collab/hooks/use-collab-doc';

// The hook news up a WebsocketProvider itself, so the test swaps the module for a fake that never
// opens a socket and lets each case drive the connection through the same events y-websocket emits,
// in y-websocket's order: `status` flips on open/close, `sync` on handshake completion and on close.
type Listener = (...args: never[]) => void;

class FakeProvider {
    static instances: FakeProvider[] = [];
    wsconnected = false;
    synced = false;
    destroyed = false;
    private listeners = new Map<string, Set<Listener>>();

    constructor(
        public url: string,
        _room: string,
        public doc: Y.Doc,
    ) {
        FakeProvider.instances.push(this);
    }

    on(name: string, fn: Listener) {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name)?.add(fn);
    }

    off(name: string, fn: Listener) {
        this.listeners.get(name)?.delete(fn);
    }

    listenerCount(name: string) {
        return this.listeners.get(name)?.size ?? 0;
    }

    private emit(name: string, args: unknown[]) {
        for (const fn of this.listeners.get(name) ?? []) (fn as (...a: unknown[]) => void)(...args);
    }

    destroy() {
        this.destroyed = true;
    }

    open() {
        this.wsconnected = true;
        this.emit('status', [{ status: 'connected' }]);
    }

    finishSync() {
        this.synced = true;
        this.emit('sync', [true]);
    }

    close() {
        this.wsconnected = false;
        this.synced = false;
        this.emit('sync', [false]);
        this.emit('status', [{ status: 'disconnected' }]);
    }
}

// Process-global in bun: every later import of y-websocket in this test run gets the fake.
mock.module('y-websocket', () => ({ WebsocketProvider: FakeProvider }));

// A real origin: api.ts resolves API_HOST from window.location at module load. The DOM globals
// are removed again in afterAll so later test files see the plain bun environment.
const window = new Window({ url: 'http://localhost:3000' });
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.window = window;
g.document = window.document;
g.navigator = window.navigator;
g.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
    g.window = undefined;
    g.document = undefined;
    g.navigator = undefined;
    g.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useCollabDoc } = await import('../../../../core/collab/hooks/use-collab-doc');

function Harness({ options, onRender }: { options: UseCollabDocOptions; onRender: (c: CollabDoc) => void }) {
    onRender(useCollabDoc(options));
    return null;
}

function mount(options: UseCollabDocOptions) {
    let latest: CollabDoc | null = null;
    const container = window.document.createElement('div');
    const root = createRoot(container as unknown as Element);
    const render = (next: UseCollabDocOptions) =>
        act(() => {
            root.render(createElement(Harness, { options: next, onRender: (c) => (latest = c) }));
        });
    render(options);
    return {
        get state() {
            if (!latest) throw new Error('hook has not rendered');
            return latest;
        },
        get doc() {
            const doc = latest?.doc;
            if (!doc) throw new Error('doc not created');
            return doc;
        },
        get provider() {
            const provider = FakeProvider.instances.at(-1);
            if (!provider) throw new Error('no provider created');
            return provider;
        },
        rerender: render,
        unmount: () => act(() => root.unmount()),
    };
}

function fireBeforeUnload() {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
}

const OPTIONS: UseCollabDocOptions = { ownerId: 'owner', mountId: 'mount', pathId: 'doc-1' };

describe('useCollabDoc connection state', () => {
    beforeEach(() => {
        FakeProvider.instances = [];
    });

    let active: ReturnType<typeof mount> | null = null;
    afterEach(() => {
        active?.unmount();
        active = null;
    });

    test('offline means a dropped socket after first load; loaded latches on first sync', () => {
        active = mount(OPTIONS);
        const h = active;
        expect(h.state.offline).toBe(false);
        expect(h.state.synced).toBe(false);
        expect(h.state.loaded).toBe(false);

        act(() => h.provider.open());
        expect(h.state.offline).toBe(false);
        expect(h.state.synced).toBe(false);

        act(() => h.provider.finishSync());
        expect(h.state.synced).toBe(true);
        expect(h.state.loaded).toBe(true);
        expect(h.state.offline).toBe(false);

        act(() => h.provider.close());
        expect(h.state.offline).toBe(true);
        expect(h.state.synced).toBe(false);
        expect(h.state.loaded).toBe(true);

        // Reconnected but still resyncing: not offline, not yet synced.
        act(() => h.provider.open());
        expect(h.state.offline).toBe(false);
        expect(h.state.synced).toBe(false);
    });

    test('beforeunload is blocked only while offline edits are waiting to sync', () => {
        active = mount(OPTIONS);
        const h = active;
        act(() => {
            h.provider.open();
            h.provider.finishSync();
        });
        const doc = h.doc;

        doc.getMap('items').set('a', 1);
        expect(fireBeforeUnload()).toBe(false);

        act(() => h.provider.close());
        expect(fireBeforeUnload()).toBe(false);

        doc.getMap('items').set('b', 2);
        expect(fireBeforeUnload()).toBe(true);

        act(() => h.provider.open());
        expect(fireBeforeUnload()).toBe(true);

        act(() => h.provider.finishSync());
        expect(fireBeforeUnload()).toBe(false);
    });

    test('updates relayed by a sibling tab while the socket is down count as unsynced', () => {
        active = mount(OPTIONS);
        const h = active;
        act(() => {
            h.provider.open();
            h.provider.finishSync();
            h.provider.close();
        });
        // y-websocket applies BroadcastChannel edits with the provider as origin, like server ones.
        const doc = h.doc;
        doc.transact(() => doc.getMap('items').set('relayed', 1), h.provider);
        expect(fireBeforeUnload()).toBe(true);
    });

    test('teardown drops the beforeunload guard and provider listeners', () => {
        active = mount(OPTIONS);
        const h = active;
        act(() => {
            h.provider.open();
            h.provider.finishSync();
            h.provider.close();
        });
        h.doc.getMap('items').set('b', 2);
        expect(fireBeforeUnload()).toBe(true);

        const first = h.provider;
        h.rerender({ ...OPTIONS, pathId: 'doc-2' });
        expect(first.destroyed).toBe(true);
        expect(first.listenerCount('sync')).toBe(0);
        expect(first.listenerCount('status')).toBe(0);
        expect(h.state.offline).toBe(false);
        expect(h.state.loaded).toBe(false);
        expect(fireBeforeUnload()).toBe(false);

        h.unmount();
        active = null;
        expect(h.provider.destroyed).toBe(true);
    });
});
