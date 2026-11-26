import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import {
    COLLAB_ACCESS_LOST_CLOSE,
    COLLAB_EPOCH_MESSAGE,
    COLLAB_HOME_REPLACED_CLOSE,
    COLLAB_STORAGE_GONE_CLOSE,
    COLLAB_STORAGE_UNAVAILABLE_CLOSE,
} from '../../../../constants/collab';
import { collabStateVersion } from '../../../../core/collab/collab-state';
import type { CollabDoc, useCollabDoc as UseCollabDoc } from '../../../../core/collab/hooks/use-collab-doc';
import { DATA_EPOCHS_KEY } from '../../../../core/home/reload-replaced-home';
import { installHappyDom } from '../../../happy-dom';

// The hook news up a WebsocketProvider itself, so the test swaps the module for a fake that never
// opens a socket and lets each case drive the connection through the same events y-websocket emits,
// in y-websocket's order: `connection-close` first, then `sync` false and `status` disconnected on a
// drop; `status` connected on open and `sync` true when the handshake completes.
type Listener = (...args: never[]) => void;

class FakeProvider {
    public static instances: FakeProvider[] = [];
    public wsconnected = false;
    public synced = false;
    public destroyed = false;
    public messageHandlers: ((encoder: unknown, decoder: decoding.Decoder) => void)[] = [];
    public params: Record<string, string> = {};
    public bcChannel: string;
    public disableBc = true;
    public bcConnects = 0;
    // y-websocket sends the local state on open, and y-protocols' setLocalStateField writes only while it is set.
    private localState: Record<string, unknown> | null = {};
    public awareness = {
        getLocalState: () => this.localState,
        setLocalState: (state: Record<string, unknown> | null) => {
            this.localState = state;
        },
    };
    public connectBc() {
        this.bcConnects++;
    }
    private listeners = new Map<string, Set<Listener>>();

    public constructor(
        public url: string,
        _room: string,
        public doc: Y.Doc,
    ) {
        this.bcChannel = url;
        FakeProvider.instances.push(this);
    }

    public on(name: string, fn: Listener) {
        if (!this.listeners.has(name)) this.listeners.set(name, new Set());
        this.listeners.get(name)?.add(fn);
    }

    public off(name: string, fn: Listener) {
        this.listeners.get(name)?.delete(fn);
    }

    public listenerCount(name: string) {
        return this.listeners.get(name)?.size ?? 0;
    }

    private emit(name: string, args: unknown[]) {
        for (const fn of this.listeners.get(name) ?? []) (fn as (...a: unknown[]) => void)(...args);
    }

    public destroy() {
        this.destroyed = true;
    }

    // The hook drives these on a storage-unavailable close; the fake stays closed either way.
    public disconnected = false;
    public connects = 0;
    public disconnect() {
        this.disconnected = true;
    }
    public connect() {
        this.connects++;
        this.disconnected = false;
    }

    public open() {
        this.wsconnected = true;
        this.emit('status', [{ status: 'connected' }]);
    }

    public finishSync() {
        this.synced = true;
        this.emit('sync', [true]);
    }

    public close(code?: number) {
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

// react-dom needs a DOM to render the hook harness into; the window itself is the one whose
// `location.reload` the offline path calls.
const window = installHappyDom();
afterAll(() => {
    mock.module('y-websocket', () => realWebsocketModule);
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { collabKeys } = await import('../../../../core/collab/hooks/keys');
const { useCollabDoc } = await import('../../../../core/collab/hooks/use-collab-doc');
type UseCollabDocOptions = Parameters<typeof UseCollabDoc>[0];

function Harness({ options, onRender }: { options: UseCollabDocOptions; onRender: (c: CollabDoc) => void }) {
    onRender(useCollabDoc(options));
    return null;
}

// The document's info as the editor route has loaded it before the editor mounts. `live` says whether the reader syncs
// over the socket.
function mount(options: UseCollabDocOptions, live: boolean | 'unloaded' = true) {
    let latest: CollabDoc | null = null;
    const container = document.createElement('div');
    const root = createRoot(container);
    const client = new QueryClient();
    const setLive = (pathId: string, next: boolean) =>
        client.setQueryData(collabKeys.document(options.ownerId, options.mountId, pathId), {
            canRead: true,
            canWrite: next,
            live: next,
            path: null,
            folderContents: null,
        });
    if (live !== 'unloaded') for (const pathId of ['doc-1', 'doc-2']) setLive(pathId, live);
    const render = (next: UseCollabDocOptions) =>
        act(() => {
            root.render(
                createElement(
                    QueryClientProvider,
                    { client },
                    createElement(Harness, { options: next, onRender: (c) => (latest = c) }),
                ),
            );
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
        client,
        // TanStack Query tells its observers on a timer.
        setLive: (next: boolean) =>
            act(async () => {
                setLive(options.pathId, next);
                await new Promise((resolve) => setTimeout(resolve, 20));
            }),
        unmount: () => act(() => root.unmount()),
    };
}

// Comfortably past the hook's offline grace window, and short of its 5s storage retry.
const PAST_GRACE_MS = 2_000;
const passGraceWindow = () => act(() => void jest.advanceTimersByTime(PAST_GRACE_MS));
// Past the hook's 5s storage retry.
const STORAGE_RETRY_PASSED_MS = 6_000;

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

    test('a gone document stops retrying and reports storageGone', () => {
        active = mount(OPTIONS);
        const h = active;
        act(() => h.provider.close(COLLAB_STORAGE_UNAVAILABLE_CLOSE));
        act(() => void jest.advanceTimersByTime(STORAGE_RETRY_PASSED_MS));
        expect(h.provider.connects).toBe(1);

        act(() => {
            h.provider.open();
            h.provider.close(COLLAB_STORAGE_GONE_CLOSE);
        });
        act(() => void jest.advanceTimersByTime(STORAGE_RETRY_PASSED_MS));
        expect(h.provider.connects).toBe(1);
        expect(h.provider.disconnected).toBe(true);
        expect(h.state.storageGone).toBe(true);
        expect(h.state.storageUnavailable).toBe(false);
        expect(h.state.loaded).toBe(false);
    });

    test('a loaded document whose storage goes missing stays loaded and reads as offline', () => {
        active = mount(OPTIONS);
        const h = active;
        act(() => {
            h.provider.open();
            h.provider.finishSync();
        });

        act(() => h.provider.close(COLLAB_STORAGE_GONE_CLOSE));
        passGraceWindow();
        expect(h.state.loaded).toBe(true);
        expect(h.state.storageGone).toBe(true);
        expect(h.state.offline).toBe(true);
    });

    test('a home replaced by a restore reloads the page instead of syncing back', () => {
        active = mount(OPTIONS);
        const h = active;
        act(() => {
            h.provider.open();
            h.provider.finishSync();
        });
        const reload = jest.fn();
        // happy-dom's Location.reload navigates; the hook only has to call it.
        Object.defineProperty(window.location, 'reload', { value: reload, configurable: true });

        // An edit this tab never got to send: the guard is armed, and it must not prompt in front of
        // the reload — those edits belong to a document the server no longer has.
        act(() => h.doc.getMap('items').set('unsent', 1));
        expect(h.state.unsyncedEdits).toBe(false);
        act(() => h.provider.close(COLLAB_HOME_REPLACED_CLOSE));

        expect(reload).toHaveBeenCalledTimes(1);
        expect(h.provider.disconnected).toBe(true);
        expect(h.state.unsyncedEdits).toBe(false);
        // Not a storage outage and not a plain drop: nothing retries, nothing syncs this tab back.
        expect(h.state.storageUnavailable).toBe(false);
    });

    test("a replaced home's reload forgets the stored epochs, and a lost read's keeps them", () => {
        Object.defineProperty(window.location, 'reload', { value: jest.fn(), configurable: true });
        const closeWith = (code: number) => {
            window.sessionStorage.setItem(DATA_EPOCHS_KEY, '{}');
            active?.unmount();
            active = mount(OPTIONS);
            const h = active;
            act(() => h.provider.close(code));
            return window.sessionStorage.getItem(DATA_EPOCHS_KEY);
        };

        expect(closeWith(COLLAB_HOME_REPLACED_CLOSE)).toBeNull();
        expect(closeWith(COLLAB_ACCESS_LOST_CLOSE)).toBe('{}');
    });

    test('a replaced home reloads only once the guard has disarmed, so the reload meets no prompt', () => {
        active = mount(OPTIONS);
        const h = active;
        act(() => {
            h.provider.open();
            h.provider.finishSync();
            h.provider.close();
        });
        act(() => h.doc.getMap('items').set('offline', 1));
        expect(h.state.unsyncedEdits).toBe(true);
        const armedAtReload: boolean[] = [];
        Object.defineProperty(window.location, 'reload', {
            value: () => armedAtReload.push(h.state.unsyncedEdits),
            configurable: true,
        });

        act(() => h.provider.open());
        act(() => h.provider.close(COLLAB_HOME_REPLACED_CLOSE));
        expect(armedAtReload).toEqual([false]);
    });

    test('losing read stops the provider for good and reloads onto the screen that applies now', () => {
        active = mount(OPTIONS);
        const h = active;
        act(() => {
            h.provider.open();
            h.provider.finishSync();
        });
        const reload = jest.fn();
        Object.defineProperty(window.location, 'reload', { value: reload, configurable: true });

        act(() => h.provider.close(COLLAB_ACCESS_LOST_CLOSE));
        act(() => void jest.advanceTimersByTime(STORAGE_RETRY_PASSED_MS));

        expect(reload).toHaveBeenCalledTimes(1);
        expect(h.provider.disconnected).toBe(true);
        expect(h.provider.connects).toBe(0);
    });

    test('losing read reloads only once the guard has disarmed, so the reload meets no prompt', () => {
        active = mount(OPTIONS);
        const h = active;
        act(() => {
            h.provider.open();
            h.provider.finishSync();
            h.provider.close();
        });
        act(() => h.doc.getMap('items').set('offline', 1));
        expect(h.state.unsyncedEdits).toBe(true);
        const armedAtReload: boolean[] = [];
        Object.defineProperty(window.location, 'reload', {
            value: () => armedAtReload.push(h.state.unsyncedEdits),
            configurable: true,
        });

        act(() => h.provider.open());
        act(() => h.provider.close(COLLAB_ACCESS_LOST_CLOSE));

        expect(armedAtReload).toEqual([false]);
    });

    test('a refusal on the first open reloads too, with nothing loaded', () => {
        active = mount(OPTIONS);
        const h = active;
        const reload = jest.fn();
        Object.defineProperty(window.location, 'reload', { value: reload, configurable: true });

        act(() => h.provider.close(COLLAB_ACCESS_LOST_CLOSE));

        expect(reload).toHaveBeenCalledTimes(1);
        expect(h.state.loaded).toBe(false);
    });

    test("the server's epoch frame names the epoch on every reconnect and opens a BroadcastChannel of it, once", () => {
        active = mount(OPTIONS);
        const h = active;
        const frame = (epoch: string) => {
            const encoder = encoding.createEncoder();
            encoding.writeVarString(encoder, epoch);
            return decoding.createDecoder(encoding.toUint8Array(encoder));
        };
        const handle = h.provider.messageHandlers[COLLAB_EPOCH_MESSAGE];
        if (!handle) throw new Error('no epoch handler');
        const channel = h.provider.bcChannel;
        expect(h.provider.disableBc).toBe(true);

        handle(null, frame('epoch-1'));
        expect(h.provider.params).toEqual({ epoch: 'epoch-1' });
        expect(h.provider.bcChannel).toBe(`${channel}#epoch-1`);
        expect(h.provider.disableBc).toBe(false);
        expect(h.provider.bcConnects).toBe(1);

        // Every reconnect's open sends it again; the tab keeps the epoch it loaded under.
        handle(null, frame('epoch-2'));
        expect(h.provider.params).toEqual({ epoch: 'epoch-1' });
        expect(h.provider.bcChannel).toBe(`${channel}#epoch-1`);
        expect(h.provider.bcConnects).toBe(1);
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

    test('a signed-in tab keeps its awareness state, so y-websocket sends its presence', () => {
        active = mount(OPTIONS);
        expect(active.provider.awareness.getLocalState()).toEqual({});
    });
});

// The state route as the hook's fetch sees it: the stored document as one update under an ETag that moves with every
// edit and names the home's epoch, a 304 for the ETag a request names, or a refusal.
function stateServer() {
    const stored = new Y.Doc();
    const asked: { url: string; ifNoneMatch: string | null }[] = [];
    const server = {
        stored,
        asked,
        refuse: 0,
        epoch: 'epoch-1',
        write: (text: string) => stored.getText('probe').insert(stored.getText('probe').length, text),
    };
    const realFetch = globalThis.fetch;
    const answer = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const ifNoneMatch = new Headers(init?.headers).get('if-none-match');
        asked.push({ url: String(input), ifNoneMatch });
        // Only the state route answers: an info the test did not load stays loading.
        if (!String(input).endsWith('/state')) return new Promise(() => {});
        if (server.refuse) return new Response('No read permission', { status: server.refuse });
        const etag = `"${collabStateVersion(server.epoch, 0, stored.getText('probe').length, 'state-f1')}"`;
        if (ifNoneMatch === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
        return new Response(new Uint8Array(Y.encodeStateAsUpdate(stored)), { headers: { ETag: etag } });
    };
    globalThis.fetch = Object.assign(answer, { preconnect: realFetch.preconnect });
    return Object.assign(server, { restore: () => void (globalThis.fetch = realFetch) });
}

// TanStack Query refetches a stale query when the tab shows again.
const focusWindow = () =>
    act(async () => {
        window.dispatchEvent(new window.Event('visibilitychange'));
        await new Promise((resolve) => setTimeout(resolve, 20));
    });
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

describe('useCollabDoc for a reader who gets no socket', () => {
    let server: ReturnType<typeof stateServer>;
    let active: ReturnType<typeof mount> | null = null;

    beforeEach(() => {
        FakeProvider.instances = [];
        server = stateServer();
    });
    afterEach(() => {
        active?.unmount();
        active = null;
        server.restore();
    });

    test('it opens no socket, loads the stored state over HTTP and runs onSync once', async () => {
        server.write('stored');
        const syncs: boolean[] = [];
        active = mount({ ...OPTIONS, onSync: (_ctx, synced) => syncs.push(synced) }, false);
        const h = active;
        expect(h.state.loaded).toBe(false);
        await settle();

        expect(FakeProvider.instances).toEqual([]);
        expect(h.state.provider).toBeNull();
        expect(server.asked).toEqual([
            { url: expect.stringMatching(/\/collab\/owner\/mount\/doc-1\/state$/), ifNoneMatch: null },
        ]);
        expect(h.doc.getText('probe').toString()).toBe('stored');
        expect(h.state.loaded).toBe(true);
        expect(h.state.synced).toBe(true);
        expect(h.state.offline).toBe(false);
        expect(syncs).toEqual([true]);
    });

    test('a focus asks again with the ETag: a newer state updates the held document, an unchanged one does nothing', async () => {
        server.write('one');
        const syncs: boolean[] = [];
        active = mount({ ...OPTIONS, onSync: (_ctx, synced) => syncs.push(synced) }, false);
        const h = active;
        await settle();
        const doc = h.doc;

        server.write(' two');
        await focusWindow();
        expect(server.asked.at(-1)?.ifNoneMatch).toBe('"epoch-1.0.3.state-f1"');
        expect(h.doc).toBe(doc);
        expect(doc.getText('probe').toString()).toBe('one two');

        let updates = 0;
        doc.on('update', () => updates++);
        await focusWindow();
        expect(server.asked.map((ask) => ask.ifNoneMatch)).toEqual([
            null,
            '"epoch-1.0.3.state-f1"',
            '"epoch-1.0.7.state-f1"',
        ]);
        expect(updates).toBe(0);
        expect(h.state.loaded).toBe(true);
        expect(syncs).toEqual([true]);
    });

    test('a 304 keeps the document, and the query holds only the version, never a copy of the body', async () => {
        server.write('kept');
        active = mount(OPTIONS, false);
        const h = active;
        await settle();
        await focusWindow();
        expect(server.asked.at(-1)?.ifNoneMatch).not.toBeNull();
        expect(h.doc.getText('probe').toString()).toBe('kept');
        const held = h.client
            .getQueryCache()
            .getAll()
            .map((query) => query.state.data)
            .filter((data) => data !== undefined);
        expect(held.some((data) => Object.values(Object(data)).some((value) => value instanceof Uint8Array))).toBe(
            false,
        );
    });

    test("a new epoch reloads the page instead of merging the replaced home's state into the held document", async () => {
        const reload = jest.fn();
        Object.defineProperty(window.location, 'reload', { value: reload, configurable: true });
        server.write('before the restore');
        active = mount(OPTIONS, false);
        const h = active;
        await settle();

        server.epoch = 'epoch-2';
        server.stored.getText('probe').delete(0, server.stored.getText('probe').length);
        server.write('restored');
        await focusWindow();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(h.doc.getText('probe').toString()).toBe('before the restore');
    });

    test("the reader's own change to the document arms no unsynced-edits guard", async () => {
        active = mount(OPTIONS, false);
        const h = active;
        await settle();
        act(() => h.doc.getMap('items').set('local', 1));
        expect(h.state.unsyncedEdits).toBe(false);
    });

    test('a 403 on the first fetch reloads the page into the guard', async () => {
        const reload = jest.fn();
        Object.defineProperty(window.location, 'reload', { value: reload, configurable: true });
        server.refuse = 403;
        active = mount(OPTIONS, false);
        await settle();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(active.state.loaded).toBe(false);
    });

    test('a link closed while the document is open reloads at the next focus', async () => {
        const reload = jest.fn();
        Object.defineProperty(window.location, 'reload', { value: reload, configurable: true });
        active = mount(OPTIONS, false);
        await settle();
        expect(reload).not.toHaveBeenCalled();

        server.refuse = 403;
        await focusWindow();
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('until the info says who the reader is, there is no doc, no socket and no fetch', async () => {
        active = mount(OPTIONS, 'unloaded');
        const h = active;
        await settle();
        expect(h.state.doc).toBeNull();
        expect(FakeProvider.instances).toEqual([]);
        expect(server.asked.filter((ask) => ask.url.endsWith('/state'))).toEqual([]);
    });

    test('a reader who becomes live gets a new doc on a socket, and one who stops being live loads over HTTP', async () => {
        server.write('stored');
        active = mount(OPTIONS, false);
        const h = active;
        await settle();
        const overHttp = h.doc;

        await h.setLive(true);
        expect(h.doc).not.toBe(overHttp);
        expect(h.state.loaded).toBe(false);
        expect(h.provider.doc).toBe(h.doc);
        act(() => {
            h.provider.open();
            h.provider.finishSync();
        });
        expect(h.state.loaded).toBe(true);

        const socket = h.provider;
        await h.setLive(false);
        await settle();
        expect(socket.destroyed).toBe(true);
        expect(h.state.provider).toBeNull();
        expect(h.doc.getText('probe').toString()).toBe('stored');
        expect(h.state.loaded).toBe(true);
    });

    test('a document switch loads the other document into a new doc', async () => {
        server.write('first');
        active = mount(OPTIONS, false);
        const h = active;
        await settle();
        const first = h.doc;

        h.rerender({ ...OPTIONS, pathId: 'doc-2' });
        expect(h.state.loaded).toBe(false);
        await settle();
        expect(h.doc).not.toBe(first);
        expect(h.state.loaded).toBe(true);
        expect(server.asked.at(-1)?.url).toMatch(/doc-2\/state$/);
    });
});
