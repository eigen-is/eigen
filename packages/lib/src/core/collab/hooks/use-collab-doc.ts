import { getCollabWebSocketUrl } from '@workspace/lib/api';
import {
    COLLAB_EPOCH_MESSAGE,
    COLLAB_HOME_REPLACED_CLOSE,
    COLLAB_STORAGE_UNAVAILABLE_CLOSE,
} from '@workspace/lib/constants/collab';
import * as decoding from 'lib0/decoding';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

// All five hosts want the same provider behavior, so the options live here rather than per app. Sibling tabs sync over
// BroadcastChannel only once the server named its data epoch, on a channel of that epoch (see the epoch handler).
const WS_PROVIDER_OPTIONS = { resyncInterval: 5000, disableBc: true } as const;

// How long to stay disconnected after a storage-unavailable close before trying again.
const STORAGE_RETRY_MS = 5_000;

// A dropped socket normally reconnects within ~100ms, and the storage retry cycle reports
// 'connected' for a tick every 5s. Hold the offline verdict this long so neither flashes the icon.
const OFFLINE_GRACE_MS = 1_500;

export type CollabDocContext = {
    doc: Y.Doc;
    provider: WebsocketProvider;
    // Null unless the host declared an `undoScope`; docs (y-prosemirror history) and sheets (engine
    // op-stack) own undo elsewhere, so they get none.
    undoManager: Y.UndoManager | null;
};

export type UseCollabDocOptions = {
    ownerId: string;
    mountId: string;
    pathId: string;
    // Shared types the UndoManager should track, resolved against the live doc. Default trackedOrigins
    // (no options): any non-null transaction origin escapes capture. Omit → no UndoManager. The return
    // type is Y.UndoManager's own `typeScope` param, so hosts hand back Y.Map/Y.Array roots directly.
    // Existing escape sentinels: NORMALIZE_ORIGIN (shared repairs, collab/normalize-refs) and vector's
    // private UNTRACKED_ORIGIN (use-vector-doc) — reuse one of those before inventing another.
    undoScope?: (doc: Y.Doc) => ConstructorParameters<typeof Y.UndoManager>[0];
    // Runs once per doc creation, inside the lifecycle effect, after doc/provider/undoManager exist.
    // Attach observers and seed initial React state here; return a cleanup that unregisters them — it
    // runs before the UndoManager/provider/doc are destroyed, matching the hand-rolled teardown order.
    onInit?: (ctx: CollabDocContext) => (() => void) | undefined;
    // Runs on every provider 'sync' event. `synced` is already tracked by the hook; use this for
    // sync-gated work (seed-if-empty, snapshot load).
    onSync?: (ctx: CollabDocContext, synced: boolean) => void;
};

export type CollabDoc = {
    // Null until the effect creates the doc, and again across a pathId switch.
    doc: Y.Doc | null;
    // The live doc for `[]`-deps callbacks: the doc identity changes on a pathId switch, this ref never does.
    docRef: RefObject<Y.Doc | null>;
    provider: WebsocketProvider | null;
    undoManager: Y.UndoManager | null;
    // Tracks the actual connection, not first load: true on every provider 'sync', false on disconnect.
    synced: boolean;
    // Socket down after first load and not a storage outage; drives the toolbar's offline icon.
    offline: boolean;
    // LATCHED first-load flag: false at doc creation, true after the FIRST synced=true for this doc
    // instance, and reset only on teardown / pathId swap. Gate the initial loading screen on THIS,
    // not `synced` — a mid-session WS blip (synced → false → true) must not unmount the editor
    // (destroying y-prosemirror undo history / transient selection); the mounted doc converges on
    // reconnect. The pathId-swap loading gate still works: the cleanup resets it before the new doc.
    loaded: boolean;
    // The server closed with COLLAB_STORAGE_UNAVAILABLE_CLOSE and the hook is retrying; cleared on sync.
    storageUnavailable: boolean;
    // Edits may not have reached the server; render `<UnsyncedEditsGuard active>` so leaving warns first.
    unsyncedEdits: boolean;
};

export function useCollabDoc(options: UseCollabDocOptions): CollabDoc {
    const { ownerId, mountId, pathId } = options;

    const [doc, setDoc] = useState<Y.Doc | null>(null);
    const [provider, setProvider] = useState<WebsocketProvider | null>(null);
    const [undoManager, setUndoManager] = useState<Y.UndoManager | null>(null);
    const [synced, setSynced] = useState(false);
    const [connected, setConnected] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [storageUnavailable, setStorageUnavailable] = useState(false);
    const [unsyncedEdits, setUnsyncedEdits] = useState(false);

    const docRef = useRef<Y.Doc | null>(null);
    // A local update went out after the last completed handshake, so the server may still lack it.
    const pendingUpdateRef = useRef(false);

    // Host config held in refs so its identity never re-runs the lifecycle effect: the doc/provider
    // are keyed STRICTLY on (ownerId, mountId, pathId).
    const undoScopeRef = useRef(options.undoScope);
    undoScopeRef.current = options.undoScope;
    const onInitRef = useRef(options.onInit);
    onInitRef.current = options.onInit;
    const onSyncRef = useRef(options.onSync);
    onSyncRef.current = options.onSync;

    useEffect(() => {
        const nextDoc = new Y.Doc();
        docRef.current = nextDoc;

        const scope = undoScopeRef.current?.(nextDoc);
        const nextUndoManager = scope ? new Y.UndoManager(scope) : null;

        const wsUrl = getCollabWebSocketUrl(ownerId, mountId, pathId);
        const nextProvider = new WebsocketProvider(wsUrl, '', nextDoc, WS_PROVIDER_OPTIONS);

        // Every reconnect names the epoch this doc loaded under; the server closes one that names another with
        // COLLAB_HOME_REPLACED_CLOSE, so a tab that outlived a whole-server restore reloads instead of merging back.
        // A tab from before the restore must not hand its state to a reloaded one either, so the channel carries it.
        nextProvider.messageHandlers[COLLAB_EPOCH_MESSAGE] = (_encoder, decoder) => {
            if (nextProvider.params['epoch']) return;
            const epoch = decoding.readVarString(decoder);
            nextProvider.params = { epoch };
            nextProvider.bcChannel = `${nextProvider.bcChannel}#${epoch}`;
            nextProvider.disableBc = false;
            nextProvider.connectBc();
        };

        const ctx: CollabDocContext = { doc: nextDoc, provider: nextProvider, undoManager: nextUndoManager };
        const cleanupInit = onInitRef.current?.(ctx);

        const handleSync = (isSynced: boolean) => {
            setSynced(isSynced);
            // Latch on the first successful sync; never cleared here (only in teardown below), so a
            // later disconnect leaves `loaded` true and the editor stays mounted.
            if (isSynced) {
                setLoaded(true);
                pendingUpdateRef.current = false;
                setUnsyncedEdits(false);
                setStorageUnavailable(false);
            }
            onSyncRef.current?.(ctx, isSynced);
        };
        nextProvider.on('sync', handleSync);

        let offlineTimer: ReturnType<typeof setTimeout> | undefined;
        const handleStatus: Parameters<typeof nextProvider.on<'status'>>[1] = ({ status }) => {
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
        nextProvider.on('status', handleStatus);

        // y-websocket only forwards local updates over an open socket, and nothing from the server
        // arrives while it is down — so every update applied meanwhile (local, or relayed by a
        // sibling tab over BroadcastChannel) is one the server may still lack. Provider-origin
        // updates are ones y-websocket applied itself, so they are never ours to deliver.
        const handleUpdate = (_update: Uint8Array, origin: unknown) => {
            if (origin !== nextProvider) pendingUpdateRef.current = true;
            if (!nextProvider.wsconnected) setUnsyncedEdits(true);
        };
        nextDoc.on('update', handleUpdate);

        // y-websocket only backs off for sockets that never opened; ours did (the route closes from
        // inside open()), so it would retry every 100ms against the failing storage. It emits this
        // event before arming that timer, so disconnect() here cancels it and we reconnect after a
        // pause. disconnect() re-enters with a null event, which the code check ignores.
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        const handleConnectionClose = (event: CloseEvent | null) => {
            if (event?.code === COLLAB_HOME_REPLACED_CLOSE) {
                // A restore replaced the document on the server. Reconnecting would sync the copy
                // this tab still holds in memory back over it and silently undo the restore, so the
                // provider stays down and the page reloads onto the restored document. No editor
                // persists to IndexedDB, so a reload is a clean slate. Unsynced edits are dropped
                // with it — they belong to a document that no longer exists, and leaving the guard
                // armed would put a "leave without saving?" prompt in front of the reload.
                pendingUpdateRef.current = false;
                setUnsyncedEdits(false);
                nextProvider.disconnect();
                window.location.reload();
                return;
            }
            if (event?.code !== COLLAB_STORAGE_UNAVAILABLE_CLOSE) return;
            setStorageUnavailable(true);
            nextProvider.disconnect();
            clearTimeout(retryTimer);
            retryTimer = setTimeout(() => nextProvider.connect(), STORAGE_RETRY_MS);
        };
        nextProvider.on('connection-close', handleConnectionClose);

        setDoc(nextDoc);
        setProvider(nextProvider);
        setUndoManager(nextUndoManager);

        return () => {
            setSynced(false);
            setConnected(false);
            // Reset the latch so a pathId swap re-shows the loading screen for the new doc.
            setLoaded(false);
            setStorageUnavailable(false);
            setUnsyncedEdits(false);
            pendingUpdateRef.current = false;
            nextDoc.off('update', handleUpdate);
            nextProvider.off('status', handleStatus);
            nextProvider.off('sync', handleSync);
            nextProvider.off('connection-close', handleConnectionClose);
            clearTimeout(offlineTimer);
            clearTimeout(retryTimer);
            // Host teardown first (unobserve, flush-on-unmount), then destroy the framework objects
            // provider→doc (provider.destroy detaches its own doc listener). The effect re-runs on a
            // pathId switch without an unmount, so skipping any of this leaks the old doc/provider.
            cleanupInit?.();
            nextUndoManager?.destroy();
            nextProvider.destroy();
            nextDoc.destroy();
            docRef.current = null;
            setDoc(null);
            setProvider(null);
            setUndoManager(null);
        };
    }, [ownerId, mountId, pathId]);

    return {
        doc,
        docRef,
        provider,
        undoManager,
        synced,
        offline: loaded && !connected && !storageUnavailable,
        loaded,
        storageUnavailable,
        unsyncedEdits,
    };
}
