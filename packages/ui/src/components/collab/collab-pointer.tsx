import { PresenceLabel } from './presence-label';

// A remote collaborator's live pointer: the arrow glyph with the shared name chip below-right of its
// tip. The host positions this at the peer's cursor point (an absolutely-positioned wrapper over its
// own coordinate mapping); CollabPointer owns only the glyph + chip composition. The chip is the
// shared PresenceLabel (`.collaboration-cursor__label`) so a peer's name reads the same here, in the
// docs caret, and in the sheet overlay — one label source, print-stripped for free.
export function CollabPointer({ color, name }: { color: string; name: string }) {
    return (
        <>
            <CollabCursorGlyph color={color} />
            <div className="absolute left-3 top-3">
                <PresenceLabel color={color} name={name} />
            </div>
        </>
    );
}

// Excalidraw-style pointer arrow; the tip sits at (0,0) so it lands on the peer's point.
function CollabCursorGlyph({ color }: { color: string }) {
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
