import type { Box, VectorElement } from '@workspace/lib/vector';
import { memo, useEffect, useMemo, useState } from 'react';
import type { WebsocketProvider } from 'y-websocket';

// The awareness state each vector client publishes (see use-vector-presence).
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
// the selection chrome. Holds its OWN awareness subscription + state, so a peer cursor tick
// re-renders this layer alone — never the scene (elementToSvg / rough path generation is untouched).
export function CursorLayer({ provider, elements, boxToStyle }: CursorLayerProps) {
    const [peers, setPeers] = useState<Peer[]>([]);

    useEffect(() => {
        if (!provider) return;
        const { awareness } = provider;
        const selfId = awareness.clientID;
        const rebuild = () => {
            setPeers((prev) => {
                const prevById = new Map(prev.map((p) => [p.clientId, p]));
                const next: Peer[] = [];
                for (const [clientId, state] of awareness.getStates()) {
                    if (clientId === selfId) continue;
                    const s = state as VectorAwareness;
                    if (!s.user) continue;
                    const built: Peer = {
                        clientId,
                        name: s.user.name,
                        color: s.user.color,
                        cursor: s.cursor ?? null,
                        selection: s.selection ?? [],
                    };
                    // Preserve object identity for unchanged peers so the memoized PeerView skips them:
                    // only the peer that actually moved / reselected re-renders on a tick.
                    const old = prevById.get(clientId);
                    next.push(old && peerEqual(old, built) ? old : built);
                }
                // Bail on a no-op change (e.g. our own cursor tick fires 'change' with no peers): keep
                // the previous array so this layer doesn't re-render for updates that concern no peer.
                if (next.length === prev.length && next.every((p, i) => p === prev[i])) return prev;
                return next;
            });
        };
        rebuild();
        awareness.on('change', rebuild);
        return () => awareness.off('change', rebuild);
    }, [provider]);

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
                // Rotation-aware ring, drawn like the local chrome: boxToStyle gives the unrotated
                // top-left + extent; the rotate() + center origin match ObjectTransform's ring exactly.
                return (
                    <div
                        key={id}
                        className="absolute"
                        style={{
                            ...boxToStyle(box),
                            outline: `1px solid ${peer.color}`,
                            transform: box.angle ? `rotate(${box.angle}deg)` : undefined,
                            transformOrigin: 'center center',
                        }}
                    />
                );
            })}
            {cursorStyle && (
                <div className="absolute" style={{ left: cursorStyle.left, top: cursorStyle.top }}>
                    <CursorGlyph color={peer.color} />
                    <span
                        className="absolute left-3 top-3 whitespace-nowrap rounded px-1 py-0.5 text-xs font-medium text-white shadow-sm"
                        style={{ backgroundColor: peer.color }}
                    >
                        {peer.name}
                    </span>
                </div>
            )}
        </>
    );
});

// Excalidraw-style pointer arrow; the tip sits at (0,0) so it lands on the peer's scene point.
function CursorGlyph({ color }: { color: string }) {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden className="drop-shadow-sm">
            <path
                d="M1 1L1 12L4 9L6.5 14L8.5 13L6 8L10 8L1 1Z"
                fill={color}
                stroke="white"
                strokeWidth="1"
                strokeLinejoin="round"
            />
        </svg>
    );
}
