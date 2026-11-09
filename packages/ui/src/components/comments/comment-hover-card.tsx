// A comment's card floating beside what the pointer rests on in an editor, such as highlighted text or a marked cell.
// The host owns when it shows, through useCommentHover, and reads the cards and their index rows itself, so no editor
// engine needs them. It never takes focus from the editor, and a click on it hands the card back to the host to open.

import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard, CommentHover } from '@workspace/lib/types/comments';
import { useMemo } from 'react';
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
                        onPointerEnter={enterCard}
                        onPointerLeave={leaveCard}
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
