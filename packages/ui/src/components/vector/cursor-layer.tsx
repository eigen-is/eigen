import type { Box, VectorElement } from '@workspace/lib/vector';
import { memo, useMemo, useRef } from 'react';
import type { WebsocketProvider } from 'y-websocket';
import { CollabPointer, RemoteSelectionRing, useAwarenessPeers } from '../collab';

// The awareness state each vector client publishes (see use-vector-presence). A per-app shape — the
// generic useAwarenessPeers hook stays projection-free.
type VectorAwareness = {
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

type CursorLayerProps = {
    provider: WebsocketProvider | null;
    // Scene elements — the box source for remote selection rings.
    elements: VectorElement[];
    // Scene box → container-relative px (position + size only); the same seam ObjectTransform draws on.
    boxToStyle: (box: Box) => React.CSSProperties;
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
// ring around each of their selected elements. Screen-space, mounted OUTSIDE the SVG zoom group like
// the selection chrome. useAwarenessPeers holds the awareness subscription, so a peer cursor tick
// re-renders this layer alone — never the scene (elementToSvg / rough path generation is untouched).
export function CursorLayer({ provider, elements, boxToStyle }: CursorLayerProps) {
    const states = useAwarenessPeers<VectorAwareness>(provider);

    // Project the raw awareness states into render-ready peers, preserving object identity for
    // unchanged peers (peerEqual) so the memoized PeerView skips them — only the peer that actually
    // moved / reselected re-renders on a tick. `states` is already reference-stable per peer, so this
    // recomputes only when a peer's state changed or a peer joined / left.
    const prevPeers = useRef<Peer[]>([]);
    const peers = useMemo(() => {
        const prevById = new Map(prevPeers.current.map((p) => [p.clientId, p]));
        const next: Peer[] = [];
        for (const [clientId, s] of states) {
            if (!s.user) continue;
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
    }, [states]);

    // Element boxes by id, rebuilt only when the scene changes — not on cursor ticks.
    const boxById = useMemo(() => {
        const m = new Map<string, Box>();
        for (const el of elements) {
            m.set(el.id, { x: el.x, y: el.y, width: el.width, height: el.height, angle: el.angle });
        }
        return m;
    }, [elements]);

    if (peers.length === 0) return null;

    return (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {peers.map((peer) => (
                <PeerView key={peer.clientId} peer={peer} boxById={boxById} boxToStyle={boxToStyle} />
            ))}
        </div>
    );
}

const PeerView = memo(function PeerView({
    peer,
    boxById,
    boxToStyle,
}: {
    peer: Peer;
    boxById: Map<string, Box>;
    boxToStyle: (box: Box) => React.CSSProperties;
}) {
    const cursorStyle = peer.cursor
        ? boxToStyle({ x: peer.cursor.x, y: peer.cursor.y, width: 0, height: 0, angle: 0 })
        : null;
    return (
        <>
            {peer.selection.map((id) => {
                const box = boxById.get(id);
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
