import { useEffect, useRef } from 'react';

// A "zombie" placeholder is a media element left in a document after an optimistic upload never
// settled — the tab was closed or reloaded mid-upload, so the `pending:` name was persisted but never
// swapped for a real one. Every Yjs editor cleans these up the same way, so the mechanism lives here.
// Delayed this long so an upload still in flight at open settles and stops matching the staleness check.
const ZOMBIE_SWEEP_DELAY_MS = 60_000;

export function useZombieMediaSweep({
    ready,
    scan,
    remove,
}: {
    // Editor-ready gate (doc synced / Tiptap editor created). The snapshot is taken when this is true.
    ready: boolean;
    // The pending placeholders present right now — mediaNames or element ids, the host's choice.
    scan: () => string[];
    // Remove exactly the snapshotted set. The host loops or batches as its model prefers; a host whose
    // items can complete between snapshot and sweep re-checks staleness in here before removing.
    remove: (pending: string[]) => void;
}): void {
    // Read scan/remove through refs so their (re-created every render) identities never re-arm the
    // timer. The effect must fire once per ready-transition — depending on the callbacks would let a
    // doc change re-snapshot and sweep a live upload, the exact failure this hook is designed to avoid.
    const scanRef = useRef(scan);
    scanRef.current = scan;
    const removeRef = useRef(remove);
    removeRef.current = remove;
    // Latch: arm on the FIRST ready only. `synced` flips false on a WS blip and true again on
    // reconnect — re-arming there would snapshot an upload this tab started after mount and sweep it
    // mid-flight. A remount (new hook instance) re-arms, which is the wanted per-document semantics.
    const armedRef = useRef(false);

    useEffect(() => {
        if (!ready || armedRef.current) return;
        armedRef.current = true;
        const snapshot = scanRef.current();
        if (snapshot.length === 0) return;
        const timer = setTimeout(() => removeRef.current(snapshot), ZOMBIE_SWEEP_DELAY_MS);
        return () => clearTimeout(timer);
    }, [ready]);
}
