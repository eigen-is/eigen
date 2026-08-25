import type { Box } from '@workspace/lib/vector';
import { memo, useMemo, useRef } from 'react';
import type { WebsocketProvider } from 'y-websocket';
import { CollabPointer } from './collab-pointer';
import { RemoteSelectionRing } from './remote-selection-ring';
import { useAwarenessPeers } from './use-awareness-peers';

// The awareness state a collaborating client publishes (see use-vector-presence / use-slides-presence).
// One documented convention shape — every host writes a subset; `slideId` scopes a peer to a
// sub-surface (slides publishes it so peers on other slides can be hidden; vector omits it). This is
// NOT a shared union imported everywhere: it is the concrete shape the shared cursor layer projects,
// and the generic useAwarenessPeers hook stays projection-free. Each host validates what it writes.
// Exactly the fields the shared layer reads — nothing more. Host-private awareness fields (slides'
// slideId, a future boardId, …) extend this per app: `type SlidesPeerState = CursorPeerState &
// { slideId?: string }`, inferred through the generic `isPeerVisible` — never added here.
export type CursorPeerState = {
    user?: { name: string; color: string; userId?: string };
    cursor?: { x: number; y: number } | null;
    selection?: string[];
};

type Peer = {
    clientId: number;
    name: string;
    color: string;
    cursor: { x: number; y: number } | null;
    selection: string[];
};

type CursorLayerProps<S extends CursorPeerState> = {
    provider: WebsocketProvider | null;
    // Object boxes by id — the source for remote selection rings. The host builds it (memoized) from
    // its scene so cursor ticks don't rebuild it. Vector's already-memoized `boxById` reduced to
    // exactly this; slides hands over the active slide's objects.
    boxes: Map<string, Box>;
    // Scene box → container-relative px (position + size only); the same seam ObjectTransform / the
    // host's selection chrome draws on.
    boxToStyle: (box: Box) => React.CSSProperties;
    // Optional host filter: return false to hide a peer entirely (cursor + rings). Slides hides peers
    // whose active slide differs; the layer stays scope-agnostic — the host owns what "visible" means,
    // and `S` carries the host's private awareness fields into the predicate.
    isPeerVisible?: (state: S) => boolean;
};

function peerEqual(a: Peer, b: Peer): boolean {
    if (a.name !== b.name || a.color !== b.color) return false;
    if ((a.cursor?.x ?? null) !== (b.cursor?.x ?? null) || (a.cursor?.y ?? null) !== (b.cursor?.y ?? null))
        return false;
    if (a.selection.length !== b.selection.length) return false;
    for (let i = 0; i < a.selection.length; i++) if (a.selection[i] !== b.selection[i]) return false;
    return true;
}

// Renders remote collaborators only: a name-tagged cursor at each peer's scene position and a thin
// ring around each of their selected objects. Screen-space, mounted OUTSIDE the host's zoom/scale
// group like the selection chrome. useAwarenessPeers holds the awareness subscription, so a peer
// cursor tick re-renders this layer alone — never the host's scene (element/object rendering is
// untouched). The box seam is app-agnostic: any host that maps a `Map<id, Box>` + a `boxToStyle`
// mounts it (vector's elements, slides' active-slide objects).
export function CursorLayer<S extends CursorPeerState = CursorPeerState>({
    provider,
    boxes,
    boxToStyle,
    isPeerVisible,
}: CursorLayerProps<S>) {
    const states = useAwarenessPeers<S>(provider);

    // Project the raw awareness states into render-ready peers, preserving object identity for
    // unchanged peers (peerEqual) so the memoized PeerView skips them — only the peer that actually
    // moved / reselected re-renders on a tick. `states` is already reference-stable per peer, so this
    // recomputes only when a peer's state changed, a peer joined / left, or the host filter changed.
    const prevPeers = useRef<Peer[]>([]);
    const peers = useMemo(() => {
        const prevById = new Map(prevPeers.current.map((p) => [p.clientId, p]));
        const next: Peer[] = [];
        for (const [clientId, s] of states) {
            if (!s.user) continue;
            if (isPeerVisible && !isPeerVisible(s)) continue;
            const built: Peer = {
                clientId,
                name: s.user.name,
                color: s.user.color,
                cursor: s.cursor ?? null,
                selection: s.selection ?? [],
            };
            const old = prevById.get(clientId);
            next.push(old && peerEqual(old, built) ? old : built);
        }
        prevPeers.current = next;
        return next;
    }, [states, isPeerVisible]);

    if (peers.length === 0) return null;

    return (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {peers.map((peer) => (
                <PeerView key={peer.clientId} peer={peer} boxes={boxes} boxToStyle={boxToStyle} />
            ))}
        </div>
    );
}

const PeerView = memo(function PeerView({
    peer,
    boxes,
    boxToStyle,
}: {
    peer: Peer;
    boxes: Map<string, Box>;
    boxToStyle: (box: Box) => React.CSSProperties;
}) {
    const cursorStyle = peer.cursor
        ? boxToStyle({ x: peer.cursor.x, y: peer.cursor.y, width: 0, height: 0, angle: 0 })
        : null;
    return (
        <>
            {peer.selection.map((id) => {
                const box = boxes.get(id);
                if (!box) return null;
                return <RemoteSelectionRing key={id} box={box} boxToStyle={boxToStyle} color={peer.color} />;
            })}
            {cursorStyle && (
                <div className="absolute" style={{ left: cursorStyle.left, top: cursorStyle.top }}>
                    <CollabPointer color={peer.color} name={peer.name} />
                </div>
            )}
        </>
    );
});
