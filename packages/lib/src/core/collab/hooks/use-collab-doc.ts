import { getCollabWebSocketUrl } from '@workspace/lib/api';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';

// Every collab editor (docs, slides, sheets, stickies, vector) opened the same Yjs scaffold by hand:
// new Y.Doc → WebsocketProvider(getCollabWebSocketUrl(...)) → track `synced` → tear it all down
// provider-before-doc. This hook owns that lifecycle once; hosts layer their own roots, observers,
// seeding, and mutation API on top through the two callback seams. All five apps passed the SAME
// provider options, so they live here as a constant (kept, not dropped, per the U6a brief).
const WS_PROVIDER_OPTIONS = { resyncInterval: 5000, connect: true } as const;

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
    synced: boolean;
}

export function useCollabDoc(options: UseCollabDocOptions): CollabDoc {
    const { ownerId, mountId, pathId } = options;

    const [doc, setDoc] = useState<Y.Doc | null>(null);
    const [provider, setProvider] = useState<WebsocketProvider | null>(null);
    const [undoManager, setUndoManager] = useState<Y.UndoManager | null>(null);
    const [synced, setSynced] = useState(false);

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
            onSyncRef.current?.(ctx, isSynced);
        };
        provider.on('sync', handleSync);

        setDoc(doc);
        setProvider(provider);
        setUndoManager(undoManager);

        return () => {
            setSynced(false);
            provider.off('sync', handleSync);
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

    return { doc, docRef, provider, undoManager, synced };
}
