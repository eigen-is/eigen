import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type * as Y from 'yjs';
import { COLLAB_STORAGE_UNAVAILABLE_CLOSE } from '../../../../constants/collab';
import type { CollabDoc, UseCollabDocOptions } from '../../../../core/collab/hooks/use-collab-doc';

// The hook news up a WebsocketProvider itself, so the test swaps the module for a fake that never
// opens a socket and lets each case drive the connection through the same events y-websocket emits,
// in y-websocket's order: `connection-close` first, then `sync` false and `status` disconnected on a
// drop; `status` connected on open and `sync` true when the handshake completes.
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

    // The hook drives these on a storage-unavailable close; the fake stays closed either way.
    disconnect() {}
    connect() {}

    open() {
        this.wsconnected = true;
        this.emit('status', [{ status: 'connected' }]);
    }

    finishSync() {
        this.synced = true;
        this.emit('sync', [true]);
    }

    close(code?: number) {
        this.emit('connection-close', [code === undefined ? null : { code }]);
        this.wsconnected = false;
        this.synced = false;
        this.emit('sync', [false]);
        this.emit('status', [{ status: 'disconnected' }]);
    }
}

// Process-global in bun: every later import of y-websocket in this test run gets the fake. The real
// module is restored in afterAll so later files in the same run see the package they imported.
const realWebsocketModule = await import('y-websocket');
mock.module('y-websocket', () => ({ WebsocketProvider: FakeProvider }));

// react-dom needs a DOM to render the hook harness into. The globals are removed again in afterAll
// so later test files see the plain bun environment.
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
    mock.module('y-websocket', () => realWebsocketModule);
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

// Comfortably past the hook's offline grace window, and short of its 5s storage retry.
const PAST_GRACE_MS = 2_000;
const passGraceWindow = () => act(() => void jest.advanceTimersByTime(PAST_GRACE_MS));

const OPTIONS: UseCollabDocOptions = { ownerId: 'owner', mountId: 'mount', pathId: 'doc-1' };

describe('useCollabDoc connection state', () => {
    beforeEach(() => {
        FakeProvider.instances = [];
        jest.useFakeTimers();
    });

    let active: ReturnType<typeof mount> | null = null;
    afterEach(() => {
        active?.unmount();
        active = null;
        jest.useRealTimers();
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
        expect(h.state.synced).toBe(false);
        passGraceWindow();
        expect(h.state.offline).toBe(true);
        expect(h.state.loaded).toBe(true);

        // Reconnected but still resyncing: not offline, not yet synced.
        act(() => h.provider.open());
        expect(h.state.offline).toBe(false);
        expect(h.state.synced).toBe(false);
    });

    test('a socket that reconnects within the grace window never reports offline', () => {
        active = mount(OPTIONS);
        const h = active;
        act(() => {
            h.provider.open();
            h.provider.finishSync();
        });

        act(() => h.provider.close());
        expect(h.state.offline).toBe(false);

        act(() => h.provider.open());
        passGraceWindow();
        expect(h.state.offline).toBe(false);
    });

    test('unsyncedEdits arms on edits made while the socket is down and clears on the next sync', () => {
        active = mount(OPTIONS);
        const h = active;
        act(() => {
            h.provider.open();
            h.provider.finishSync();
        });
        const doc = h.doc;

        act(() => h.provider.close());
        expect(h.state.unsyncedEdits).toBe(false);

        act(() => doc.getMap('items').set('b', 2));
        expect(h.state.unsyncedEdits).toBe(true);

        // Reconnecting is not enough — the edit is only safe once the handshake completes.
        act(() => h.provider.open());
        expect(h.state.unsyncedEdits).toBe(true);

        act(() => h.provider.finishSync());
        expect(h.state.unsyncedEdits).toBe(false);
    });

    test('a silently dead socket arms unsyncedEdits once the close finally arrives', () => {
        active = mount(OPTIONS);
        const h = active;
        act(() => {
            h.provider.open();
            h.provider.finishSync();
        });

        // wsconnected is still true: y-websocket has not noticed the socket is dead.
        act(() => h.doc.getMap('items').set('a', 1));
        expect(h.state.unsyncedEdits).toBe(false);

        act(() => h.provider.close());
        expect(h.state.unsyncedEdits).toBe(true);
    });

    test('a peer edit arriving over a live socket is not something this tab owes the server', () => {
        active = mount(OPTIONS);
        const h = active;
        act(() => {
            h.provider.open();
            h.provider.finishSync();
        });

        // Provider-origin while connected: y-websocket applied it, this tab never sent it.
        const doc = h.doc;
        act(() => doc.transact(() => doc.getMap('items').set('peer', 1), h.provider));
        act(() => h.provider.close());
        expect(h.state.unsyncedEdits).toBe(false);
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
        act(() => doc.transact(() => doc.getMap('items').set('relayed', 1), h.provider));
        expect(h.state.unsyncedEdits).toBe(true);
    });

    test('a storage outage is reported as storageUnavailable, not as offline', () => {
        active = mount(OPTIONS);
        const h = active;
        act(() => {
            h.provider.open();
            h.provider.finishSync();
        });

        act(() => h.provider.close(COLLAB_STORAGE_UNAVAILABLE_CLOSE));
        passGraceWindow();
        expect(h.state.storageUnavailable).toBe(true);
        expect(h.state.offline).toBe(false);

        act(() => {
            h.provider.open();
            h.provider.finishSync();
        });
        expect(h.state.storageUnavailable).toBe(false);
    });

    test('teardown drops the provider listeners and resets the flags', () => {
        active = mount(OPTIONS);
        const h = active;
        act(() => {
            h.provider.open();
            h.provider.finishSync();
            h.provider.close();
        });
        act(() => h.doc.getMap('items').set('b', 2));
        passGraceWindow();
        expect(h.state.offline).toBe(true);
        expect(h.state.unsyncedEdits).toBe(true);

        const first = h.provider;
        h.rerender({ ...OPTIONS, pathId: 'doc-2' });
        expect(first.destroyed).toBe(true);
        expect(first.listenerCount('sync')).toBe(0);
        expect(first.listenerCount('status')).toBe(0);
        expect(h.state.offline).toBe(false);
        expect(h.state.loaded).toBe(false);
        expect(h.state.unsyncedEdits).toBe(false);

        h.unmount();
        active = null;
        expect(h.provider.destroyed).toBe(true);
    });
});
