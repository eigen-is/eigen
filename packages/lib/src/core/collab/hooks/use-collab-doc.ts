import { getCollabWebSocketUrl } from '@workspace/lib/api';
import { COLLAB_STORAGE_UNAVAILABLE_CLOSE } from '@workspace/lib/constants/collab';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

// Every collab editor (docs, slides, sheets, stickies, vector) opened the same Yjs scaffold by hand:
// new Y.Doc → WebsocketProvider(getCollabWebSocketUrl(...)) → track `synced` → tear it all down
// provider-before-doc. This hook owns that lifecycle once; hosts layer their own roots, observers,
// seeding, and mutation API on top through the two callback seams. All five apps passed the SAME
// provider options, so they live here as a constant (kept, not dropped, per the U6a brief).
const WS_PROVIDER_OPTIONS = { resyncInterval: 5000, connect: true } as const;

// How long to stay disconnected after a storage-unavailable close before trying again.
const STORAGE_RETRY_MS = 5_000;

export interface CollabDocContext {
    doc: Y.Doc;
    provider: WebsocketProvider;
    // Null unless the host declared an `undoScope`; docs (y-prosemirror history) and sheets (engine
    // op-stack) own undo elsewhere, so they get none.
    undoManager: Y.UndoManager | null;
}

export interface UseCollabDocOptions {
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
}

export interface CollabDoc {
    // Reactive — null until the effect creates the doc, and again during a pathId switch. Use for
    // rendering, gating, and passing to peer hooks (comment lifecycle, presence).
    doc: Y.Doc | null;
    // The same doc as a stable ref, for `[]`-deps mutation callbacks that must read the live doc at
    // call time (the doc identity changes on pathId switch, but this ref object never does).
    docRef: RefObject<Y.Doc | null>;
    provider: WebsocketProvider | null;
    undoManager: Y.UndoManager | null;
    // Live sync state — flips true on every provider 'sync' and false on disconnect. Use for
    // presence, seed-if-empty, and other work that must track the actual connection.
    synced: boolean;
    // LATCHED first-load flag: false at doc creation, true after the FIRST synced=true for this doc
    // instance, and reset only on teardown / pathId swap. Gate the initial loading screen on THIS,
    // not `synced` — a mid-session WS blip (synced → false → true) must not unmount the editor
    // (destroying y-prosemirror undo history / transient selection); the mounted doc converges on
    // reconnect. The pathId-swap loading gate still works: the cleanup resets it before the new doc.
    loaded: boolean;
    // True between a WS close carrying COLLAB_STORAGE_UNAVAILABLE_CLOSE (the route's answer when the
    // document's storage is unreachable) and the next successful sync. The hook keeps retrying in the
    // background, so this only changes what the loading screen says.
    storageUnavailable: boolean;
}

export function useCollabDoc(options: UseCollabDocOptions): CollabDoc {
    const { ownerId, mountId, pathId } = options;

    const [doc, setDoc] = useState<Y.Doc | null>(null);
    const [provider, setProvider] = useState<WebsocketProvider | null>(null);
    const [undoManager, setUndoManager] = useState<Y.UndoManager | null>(null);
    const [synced, setSynced] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [storageUnavailable, setStorageUnavailable] = useState(false);

    const docRef = useRef<Y.Doc | null>(null);

    // Host config held in refs so its identity never re-runs the lifecycle effect: the doc/provider
    // are keyed STRICTLY on (ownerId, mountId, pathId). This is also the fix for the stickies quirk,
    // where an unstable seeding callback / `user.email` in the deps tore down and rebuilt the live doc.
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

        const wsUrl = getCollabWebSocketUrl(ownerId, mountId, pathId);
        const provider = new WebsocketProvider(wsUrl, '', doc, WS_PROVIDER_OPTIONS);

        const ctx: CollabDocContext = { doc, provider, undoManager };
        const cleanupInit = onInitRef.current?.(ctx);

        const handleSync = (isSynced: boolean) => {
            setSynced(isSynced);
            // Latch on the first successful sync; never cleared here (only in teardown below), so a
            // later disconnect leaves `loaded` true and the editor stays mounted.
            if (isSynced) {
                setLoaded(true);
                setStorageUnavailable(false);
            }
            onSyncRef.current?.(ctx, isSynced);
        };
        provider.on('sync', handleSync);

        // y-websocket's backoff only grows for sockets that never opened; ours DID open (the route
        // runs after the 101 and closes from inside open()), so its retry timer stays at 100ms and
        // every retry re-pays the failing storage load. It emits 'connection-close' before arming
        // that timer and setupWS is gated on shouldConnect, so disconnecting here cancels it; we
        // reconnect ourselves after a pause. disconnect() re-enters this handler with a null event,
        // which the code check ignores.
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        const handleConnectionClose = (event: CloseEvent | null) => {
            if (event?.code !== COLLAB_STORAGE_UNAVAILABLE_CLOSE) return;
            setStorageUnavailable(true);
            provider.disconnect();
            clearTimeout(retryTimer);
            retryTimer = setTimeout(() => provider.connect(), STORAGE_RETRY_MS);
        };
        provider.on('connection-close', handleConnectionClose);

        setDoc(doc);
        setProvider(provider);
        setUndoManager(undoManager);

        return () => {
            setSynced(false);
            // Reset the latch so a pathId swap re-shows the loading screen for the new doc.
            setLoaded(false);
            setStorageUnavailable(false);
            provider.off('sync', handleSync);
            provider.off('connection-close', handleConnectionClose);
            clearTimeout(retryTimer);
            // Host teardown first (unobserve, flush-on-unmount), then destroy the framework objects
            // provider→doc (provider.destroy detaches its own doc listener). The effect re-runs on a
            // pathId switch without an unmount, so skipping any of this leaks the old doc/provider.
            cleanupInit?.();
            undoManager?.destroy();
            provider.destroy();
            doc.destroy();
            docRef.current = null;
            setDoc(null);
            setProvider(null);
            setUndoManager(null);
        };
    }, [ownerId, mountId, pathId]);

    return { doc, docRef, provider, undoManager, synced, loaded, storageUnavailable };
}
