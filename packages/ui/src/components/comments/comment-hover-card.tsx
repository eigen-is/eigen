// A comment's card floating beside what the pointer rests on in an editor, such as highlighted text or a marked cell.
// The host owns when it shows, through useCommentHover, and reads the cards and their index rows itself, so no editor
// engine needs them. It holds itself open while the pointer is on it or on its way to it. It never takes focus from the
// editor, and a click on it hands the card back to the host to open.

import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard, CommentHover } from '@workspace/lib/types/comments';
import { useEffect, useMemo, useRef } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '../popover';
import { CommentNoteCard } from './comment-note-card';

export function CommentHoverCard({
    hover,
    cards,
    entries,
    side,
    isCardDeleted,
    onOpenCard,
}: {
    hover: CommentHover;
    cards: Readonly<Record<string, CommentCard>>;
    entries: readonly CommentEntry[];
    side: 'bottom' | 'right';
    isCardDeleted: (card: CommentCard) => boolean;
    onOpenCard: (cardId: string) => void;
}) {
    const { target, enterCard, leaveCard, dismiss } = hover;
    const card = target ? cards[target.cardId] : undefined;
    // New per target, since Radix repositions only when the anchor's identity changes.
    const anchor = useMemo(() => ({ current: target && { getBoundingClientRect: () => target.rect } }), [target]);
    const contentRef = useRef<HTMLDivElement>(null);

    // A slow hand can take longer than the close's grace over the gap, or over the cell below a short anchor, so the
    // way from where the pointer last was on the anchor to the card holds the card as the card itself does.
    useEffect(() => {
        if (!target) return;
        let lastOnAnchor: Point | null = null;
        let held = false;
        const onMove = (event: PointerEvent) => {
            const point = { x: event.clientX, y: event.clientY };
            // Back on the anchor the host's own report takes over, and a mark may send it before this move arrives.
            if (contains(target.rect, point)) {
                lastOnAnchor = point;
                held = false;
                return;
            }
            const box = contentRef.current?.getBoundingClientRect();
            const holds =
                box !== undefined &&
                (contains(box, point) || (lastOnAnchor !== null && heading(lastOnAnchor, point, box)));
            // Every holding move says so, because the host's report of another of the card's cells ends the hold.
            if (holds) {
                held = true;
                enterCard();
                return;
            }
            lastOnAnchor = null;
            if (!held) return;
            held = false;
            leaveCard();
        };
        document.addEventListener('pointermove', onMove, PAGE_LISTENER);
        return () => document.removeEventListener('pointermove', onMove, PAGE_LISTENER);
    }, [target, enterCard, leaveCard]);

    return (
        <Popover
            open={target != null}
            onOpenChange={(open) => {
                if (!open) dismiss();
            }}
        >
            {target && card && (
                <>
                    <PopoverAnchor virtualRef={anchor} />
                    <PopoverContent
                        ref={contentRef}
                        // Radix's role="dialog" reads as a modal to useDialogOpen, which turns off a document's keymap.
                        role="tooltip"
                        side={side}
                        align="start"
                        className="w-[254px] rounded-none border-0 bg-transparent p-0"
                        onOpenAutoFocus={(event) => event.preventDefault()}
                        onCloseAutoFocus={(event) => event.preventDefault()}
                        // The content has tabIndex -1, so a press would focus it, and a dialog the click opens would
                        // give the focus back to this element, gone by then.
                        onMouseDown={(event) => event.preventDefault()}
                        // Radix hears Escape on the document's capture phase, so the key closes the card and stops,
                        // rather than also cancelling an edit or closing the find bar.
                        onEscapeKeyDown={(event) => event.stopPropagation()}
                    >
                        <CommentNoteCard
                            card={card}
                            entry={entries.find((entry) => entry.chatName === card.chatName)}
                            title={card.title || 'Comment'}
                            unread={false}
                            deleted={isCardDeleted(card)}
                            onClick={() => {
                                onOpenCard(target.cardId);
                                dismiss();
                            }}
                        />
                    </PopoverContent>
                </>
            )}
        </Popover>
    );
}

type Point = { x: number; y: number };

const PAGE_LISTENER = { capture: true, passive: true };

const contains = (rect: DOMRect, { x, y }: Point) =>
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

// Whether the line from `from` through `to` reaches the rect past `to`, so `to` lies between them.
function heading(from: Point, to: Point, rect: DOMRect): boolean {
    let enters = Number.NEGATIVE_INFINITY;
    let leaves = Number.POSITIVE_INFINITY;
    const axes: [number, number, number, number][] = [
        [from.x, to.x - from.x, rect.left, rect.right],
        [from.y, to.y - from.y, rect.top, rect.bottom],
    ];
    for (const [start, step, min, max] of axes) {
        if (step === 0) {
            if (start < min || start > max) return false;
            continue;
        }
        const [a, b] = [(min - start) / step, (max - start) / step];
        enters = Math.max(enters, Math.min(a, b));
        leaves = Math.min(leaves, Math.max(a, b));
    }
    return enters >= 1 && enters <= leaves;
}
