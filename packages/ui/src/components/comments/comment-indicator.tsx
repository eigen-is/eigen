import { CELL_INDICATOR_SIZE, commentIndicatorColor } from '@workspace/lib/constants/comment-indicator';

// The comment mark as CSS borders: the same right-angled corner triangle a commented sheet cell
// paints, at the same size, in the card's own colour. Anchor it on the top-right corner of the box
// that carries the card.
export function CommentIndicator({ color, className }: { color?: string | null; className?: string }) {
    return (
        <span
            className={className}
            style={{
                width: 0,
                height: 0,
                borderLeft: `${CELL_INDICATOR_SIZE}px solid transparent`,
                borderTop: `${CELL_INDICATOR_SIZE}px solid ${commentIndicatorColor(color)}`,
            }}
        />
    );
}
