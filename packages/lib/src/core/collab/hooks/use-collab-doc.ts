// The Y.Doc and y-websocket provider behind every collab editor, such as a doc, a sheet or a board. A host calls
// useCollabDoc for one document and gets the live doc and its connection state. The hook also decides what each close
// code does to the tab: reconnect, wait and retry, stop for good, or reload.

import { getCollabWebSocketUrl } from '@workspace/lib/api';
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
import { reloadReplacedHome } from '../../home/reload-replaced-home';

// Sibling tabs sync over BroadcastChannel only once the server named its data epoch, on a channel of that epoch.
const WS_PROVIDER_OPTIONS = { resyncInterval: 5000, disableBc: true } as const;

// How long to stay disconnected after a storage-unavailable close before trying again.
const STORAGE_RETRY_MS = 5_000;

// A dropped socket normally reconnects at once, and the storage retry cycle reports 'connected' for a tick. Hold the
// offline verdict this long so neither flashes the icon.
const OFFLINE_GRACE_MS = 1_500;

export type CollabDocContext = {
    doc: Y.Doc;
    provider: WebsocketProvider;
    // Null unless the host declared an `undoScope`; docs and sheets own undo elsewhere.
    undoManager: Y.UndoManager | null;
};

export type UseCollabDocOptions = {
    ownerId: string;
    mountId: string;
    pathId: string;
    // Shared types the UndoManager tracks, or none without this. A transaction with a non-null origin escapes it, so
    // reuse an origin such as NORMALIZE_ORIGIN before inventing another.
    undoScope?: (doc: Y.Doc) => ConstructorParameters<typeof Y.UndoManager>[0];
    // Runs once per doc creation, to attach observers and seed React state. Its cleanup runs before the UndoManager,
    // the provider and the doc are destroyed.
    onInit?: (ctx: CollabDocContext) => (() => void) | undefined;
    // Runs on every provider 'sync' event, for sync-gated work such as a seed-if-empty or a snapshot load.
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
    // Latched on the first sync of this doc and reset only on teardown. Gate the loading screen on this, not `synced`,
    // because a blip must not unmount the editor and its undo history.
    loaded: boolean;
    // The server closed with COLLAB_STORAGE_UNAVAILABLE_CLOSE and the hook is retrying; cleared on sync.
    storageUnavailable: boolean;
    // The server closed with COLLAB_STORAGE_GONE_CLOSE: the stored data is missing, so the hook stopped reconnecting.
    storageGone: boolean;
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
    const [storageGone, setStorageGone] = useState(false);
    const [unsyncedEdits, setUnsyncedEdits] = useState(false);
    const [reloadNow, setReloadNow] = useState<(() => void) | null>(null);

    const docRef = useRef<Y.Doc | null>(null);
    // A local update went out after the last completed handshake, so the server may still lack it.
    const pendingUpdateRef = useRef(false);

    // Refs, so a new host callback never re-runs the lifecycle effect: the doc is keyed on the document's ids alone.
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

        // Every reconnect names the epoch this doc loaded under, so a tab that outlived a whole-server restore reloads
        // instead of merging back. The channel carries it too, so that tab can't hand its state to a reloaded one.
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

        // Every update applied while the socket is down, a sibling tab's included, is one the server may still lack.
        // Updates y-websocket applied itself, with the provider as origin, are never ours to deliver.
        const handleUpdate = (_update: Uint8Array, origin: unknown) => {
            if (origin !== nextProvider) pendingUpdateRef.current = true;
            if (!nextProvider.wsconnected) setUnsyncedEdits(true);
        };
        nextDoc.on('update', handleUpdate);

        // y-websocket emits this before arming its reconnect, so disconnect() here cancels it. 4400-4499 stops it on
        // its own. disconnect() re-enters with a null event, which the code checks ignore.
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        const handleConnectionClose = (event: CloseEvent | null) => {
            if (event?.code === COLLAB_HOME_REPLACED_CLOSE || event?.code === COLLAB_ACCESS_LOST_CLOSE) {
                // A reconnect would sync this tab's copy back over a restore, or be refused with these edits after a
                // lost read. The unsynced edits go too, because the armed guard would prompt in front of the reload.
                pendingUpdateRef.current = false;
                setUnsyncedEdits(false);
                nextProvider.disconnect();
                // The session is read once per page load, so only a reload takes a deleted user to sign-in.
                const reload =
                    event.code === COLLAB_HOME_REPLACED_CLOSE ? reloadReplacedHome : () => window.location.reload();
                setReloadNow(() => reload);
                return;
            }
            if (event?.code === COLLAB_STORAGE_GONE_CLOSE) {
                clearTimeout(retryTimer);
                nextProvider.disconnect();
                setStorageUnavailable(false);
                setStorageGone(true);
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
            setStorageGone(false);
            setUnsyncedEdits(false);
            pendingUpdateRef.current = false;
            nextDoc.off('update', handleUpdate);
            nextProvider.off('status', handleStatus);
            nextProvider.off('sync', handleSync);
            nextProvider.off('connection-close', handleConnectionClose);
            clearTimeout(offlineTimer);
            clearTimeout(retryTimer);
            // Host teardown first, then the framework objects. The effect re-runs on a pathId switch without an
            // unmount, so skipping any of this leaks the old doc and provider.
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

    // After the commit that disarmed UnsyncedEditsGuard: a reload inside the close handler would still meet its prompt.
    useEffect(() => {
        reloadNow?.();
    }, [reloadNow]);

    return {
        doc,
        docRef,
        provider,
        undoManager,
        synced,
        offline: loaded && !connected && !storageUnavailable,
        loaded,
        storageUnavailable,
        storageGone,
        unsyncedEdits,
    };
}
