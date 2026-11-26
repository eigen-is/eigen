// The Y.Doc behind every collab editor, such as a doc, a sheet or a board. A host calls useCollabDoc for one document
// and gets the doc and its connection state. Someone signed in syncs it over a y-websocket provider, and the hook
// decides what each close code does to the tab: reconnect, wait and retry, stop for good, or reload. A visitor without
// a login gets no socket: the hook loads the stored state over HTTP and asks again when the tab shows again.

import { getCollabWebSocketUrl } from '@workspace/lib/api';
import { useAuth } from '@workspace/lib/auth';
import {
    COLLAB_ACCESS_LOST_CLOSE,
    COLLAB_EPOCH_MESSAGE,
    COLLAB_HOME_REPLACED_CLOSE,
    COLLAB_STORAGE_GONE_CLOSE,
    COLLAB_STORAGE_UNAVAILABLE_CLOSE,
} from '@workspace/lib/constants/collab';
import * as decoding from 'lib0/decoding';
import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import { AppError } from '../../api-error';
import { reloadReplacedHome } from '../../home/reload-replaced-home';
import { applyCollabState } from '../collab-state';
import { useCollabStoredState } from './use-collab';

// Sibling tabs sync over BroadcastChannel only once the server named its data epoch, on a channel of that epoch.
const WS_PROVIDER_OPTIONS = { resyncInterval: 5000, disableBc: true } as const;

// How long to stay disconnected after a storage-unavailable close before trying again.
const STORAGE_RETRY_MS = 5_000;

// A dropped socket normally reconnects at once, and the storage retry cycle reports 'connected' for a tick. Hold the
// offline verdict this long so neither flashes the icon.
const OFFLINE_GRACE_MS = 1_500;

// The origin of the stored state's updates. It is not null, so no UndoManager tracks them.
const STORED_STATE_ORIGIN = 'stored-state';

type CollabDocContext = {
    doc: Y.Doc;
    // Null for a reader who gets no socket.
    provider: WebsocketProvider | null;
    // Null unless the host declared an `undoScope`; docs and sheets own undo elsewhere.
    undoManager: Y.UndoManager | null;
};

type UseCollabDocOptions = {
    ownerId: string;
    mountId: string;
    pathId: string;
    // Shared types the UndoManager tracks, or none without this. A transaction with a non-null origin escapes it, so
    // reuse an origin, such as the one normalizeParentChildRefs repairs under, before inventing another.
    undoScope?: (doc: Y.Doc) => ConstructorParameters<typeof Y.UndoManager>[0];
    // Runs once per doc creation, to attach observers and seed React state. Its cleanup runs before the UndoManager,
    // the provider and the doc are destroyed.
    onInit?: (ctx: CollabDocContext) => (() => void) | undefined;
    // Runs on every provider 'sync' event, and once when a reader without a socket has loaded, for sync-gated work
    // such as a seed-if-empty or a snapshot load.
    onSync?: (ctx: CollabDocContext, synced: boolean) => void;
};

export type CollabDoc = {
    // Null until the effect creates the doc, and again across a pathId switch.
    doc: Y.Doc | null;
    // The live doc for `[]`-deps callbacks: the doc identity changes on a pathId switch, this ref never does.
    docRef: RefObject<Y.Doc | null>;
    // Null too for a reader who gets no socket, who has no awareness to read or publish.
    provider: WebsocketProvider | null;
    undoManager: Y.UndoManager | null;
    // Tracks the actual connection, not first load: true on every provider 'sync', false on disconnect. Without a
    // socket it is true once the stored state has loaded.
    synced: boolean;
    // Socket down after first load and not a storage outage; drives the toolbar's offline icon.
    offline: boolean;
    // Latched on the first sync of this doc and reset only on teardown. Gate the loading screen on this, not `synced`,
    // because a blip must not unmount the editor and its undo history.
    loaded: boolean;
    // The server closed with COLLAB_STORAGE_UNAVAILABLE_CLOSE, or failed to answer the stored state, and the hook is
    // retrying; cleared on sync.
    storageUnavailable: boolean;
    // The server closed with COLLAB_STORAGE_GONE_CLOSE, or answered the stored state with a 410: the stored data is
    // missing, so the hook stopped asking.
    storageGone: boolean;
    // Edits may not have reached the server; render `<UnsyncedEditsGuard active>` so leaving warns first.
    unsyncedEdits: boolean;
};

export function useCollabDoc(options: UseCollabDocOptions): CollabDoc {
    const { ownerId, mountId, pathId } = options;
    const live = !!useAuth().user;
    const stored = useCollabStoredState(ownerId, mountId, pathId, !live);

    const [ctx, setCtx] = useState<CollabDocContext | null>(null);
    const [synced, setSynced] = useState(false);
    const [connected, setConnected] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [storageUnavailable, setStorageUnavailable] = useState(false);
    const [storageGone, setStorageGone] = useState(false);
    const [unsyncedEdits, setUnsyncedEdits] = useState(false);
    const [reloadNow, setReloadNow] = useState<(() => void) | null>(null);

    const docRef = useRef<Y.Doc | null>(null);
    // A local update went out after the last completed handshake, so the server may still lack it.
    const pendingUpdateRef = useRef(false);
    // The doc whose host already had its onSync for the stored state.
    const storedSyncDocRef = useRef<Y.Doc | null>(null);

    // Refs, so a new host callback never re-runs the lifecycle effect: the doc is keyed on the document's ids alone.
    const undoScopeRef = useRef(options.undoScope);
    undoScopeRef.current = options.undoScope;
    const onInitRef = useRef(options.onInit);
    onInitRef.current = options.onInit;
    const onSyncRef = useRef(options.onSync);
    onSyncRef.current = options.onSync;

    useEffect(() => {
        const doc = new Y.Doc();
        docRef.current = doc;

        const scope = undoScopeRef.current?.(doc);
        const undoManager = scope ? new Y.UndoManager(scope) : null;
        const provider = live
            ? new WebsocketProvider(getCollabWebSocketUrl(ownerId, mountId, pathId), '', doc, WS_PROVIDER_OPTIONS)
            : null;

        const nextCtx: CollabDocContext = { doc, provider, undoManager };
        const cleanupInit = onInitRef.current?.(nextCtx);
        const leaveSocket = provider ? followSocket(nextCtx, provider) : undefined;
        setCtx(nextCtx);

        return () => {
            setSynced(false);
            setConnected(false);
            // Reset the latch so a pathId swap re-shows the loading screen for the new doc.
            setLoaded(false);
            setStorageUnavailable(false);
            setStorageGone(false);
            setUnsyncedEdits(false);
            pendingUpdateRef.current = false;
            leaveSocket?.();
            // Host teardown first, then the framework objects. The effect re-runs on a pathId switch without an
            // unmount, so skipping any of this leaks the old doc and provider.
            cleanupInit?.();
            undoManager?.destroy();
            provider?.destroy();
            doc.destroy();
            docRef.current = null;
            setCtx(null);
        };

        // Wires the provider's events to the hook's state, and returns what unwires them.
        function followSocket(socketCtx: CollabDocContext, socket: WebsocketProvider): () => void {
            // Every reconnect names the epoch this doc loaded under, so a tab that outlived a whole-server restore
            // reloads instead of merging back. The channel carries it too, so that tab can't hand its state to a
            // reloaded one.
            socket.messageHandlers[COLLAB_EPOCH_MESSAGE] = (_encoder, decoder) => {
                if (socket.params['epoch']) return;
                const epoch = decoding.readVarString(decoder);
                socket.params = { epoch };
                socket.bcChannel = `${socket.bcChannel}#${epoch}`;
                socket.disableBc = false;
                socket.connectBc();
            };

            const handleSync = (isSynced: boolean) => {
                setSynced(isSynced);
                if (isSynced) {
                    setLoaded(true);
                    pendingUpdateRef.current = false;
                    setUnsyncedEdits(false);
                    setStorageUnavailable(false);
                }
                onSyncRef.current?.(socketCtx, isSynced);
            };
            socket.on('sync', handleSync);

            let offlineTimer: ReturnType<typeof setTimeout> | undefined;
            const handleStatus: Parameters<typeof socket.on<'status'>>[1] = ({ status }) => {
                if (status === 'connected') {
                    clearTimeout(offlineTimer);
                    offlineTimer = undefined;
                    setConnected(true);
                    return;
                }
                if (status !== 'disconnected') return;
                // A silently dead socket keeps `wsconnected` true until y-websocket's 30s silence check
                // fires, so updates made meanwhile looked sent. The close is the first honest signal.
                if (pendingUpdateRef.current) setUnsyncedEdits(true);
                clearTimeout(offlineTimer);
                offlineTimer = setTimeout(() => setConnected(false), OFFLINE_GRACE_MS);
            };
            socket.on('status', handleStatus);

            // Every update applied while the socket is down, a sibling tab's included, is one the server may still
            // lack. Updates y-websocket applied itself, with the provider as origin, are never ours to deliver.
            const handleUpdate = (_update: Uint8Array, origin: unknown) => {
                if (origin !== socket) pendingUpdateRef.current = true;
                if (!socket.wsconnected) setUnsyncedEdits(true);
            };
            socketCtx.doc.on('update', handleUpdate);

            // y-websocket emits this before arming its reconnect, so disconnect() here cancels it. 4400-4499 stops it
            // on its own. disconnect() re-enters with a null event, which the code checks ignore.
            let retryTimer: ReturnType<typeof setTimeout> | undefined;
            const handleConnectionClose = (event: CloseEvent | null) => {
                if (event?.code === COLLAB_HOME_REPLACED_CLOSE || event?.code === COLLAB_ACCESS_LOST_CLOSE) {
                    // A reconnect would sync this tab's copy back over a restore, or be refused with these edits after
                    // a lost read. The unsynced edits go too, because the armed guard would prompt in front of the
                    // reload.
                    pendingUpdateRef.current = false;
                    setUnsyncedEdits(false);
                    socket.disconnect();
                    // The session is read once per page load, so only a reload takes a deleted user to sign-in.
                    const reload =
                        event.code === COLLAB_HOME_REPLACED_CLOSE ? reloadReplacedHome : () => window.location.reload();
                    setReloadNow(() => reload);
                    return;
                }
                if (event?.code === COLLAB_STORAGE_GONE_CLOSE) {
                    clearTimeout(retryTimer);
                    socket.disconnect();
                    setStorageUnavailable(false);
                    setStorageGone(true);
                    return;
                }
                if (event?.code !== COLLAB_STORAGE_UNAVAILABLE_CLOSE) return;
                setStorageUnavailable(true);
                socket.disconnect();
                clearTimeout(retryTimer);
                retryTimer = setTimeout(() => socket.connect(), STORAGE_RETRY_MS);
            };
            socket.on('connection-close', handleConnectionClose);

            return () => {
                socketCtx.doc.off('update', handleUpdate);
                socket.off('status', handleStatus);
                socket.off('sync', handleSync);
                socket.off('connection-close', handleConnectionClose);
                clearTimeout(offlineTimer);
                clearTimeout(retryTimer);
            };
        }
    }, [ownerId, mountId, pathId, live]);

    // A newer state applied on top of the held doc brings it up to date. This render's doc may be one the lifecycle
    // effect has just replaced, which must take nothing more.
    const storedState = stored.data;
    useEffect(() => {
        if (!ctx || ctx.provider || !storedState || ctx.doc !== docRef.current) return;
        applyCollabState(ctx.doc, storedState.body, STORED_STATE_ORIGIN);
        setSynced(true);
        setLoaded(true);
        if (storedSyncDocRef.current === ctx.doc) return;
        storedSyncDocRef.current = ctx.doc;
        onSyncRef.current?.(ctx, true);
    }, [ctx, storedState]);

    // The link was closed, as an access-lost close says on a socket: the reload shows the screen that applies now.
    const storedStatus = stored.error instanceof AppError ? stored.error.status : undefined;
    useEffect(() => {
        if (storedStatus === 401 || storedStatus === 403) setReloadNow(() => () => window.location.reload());
    }, [storedStatus]);

    // After the commit that disarmed UnsyncedEditsGuard: a reload inside the close handler would still meet its prompt.
    useEffect(() => {
        reloadNow?.();
    }, [reloadNow]);

    return {
        doc: ctx?.doc ?? null,
        docRef,
        provider: ctx?.provider ?? null,
        undoManager: ctx?.undoManager ?? null,
        synced,
        offline: live && loaded && !connected && !storageUnavailable,
        loaded,
        // A stored state that failed is asked again for as long as the failure count stands.
        storageUnavailable: storageUnavailable || (stored.isFetching && stored.failureCount > 0),
        storageGone: storageGone || storedStatus === 410,
        unsyncedEdits,
    };
}
