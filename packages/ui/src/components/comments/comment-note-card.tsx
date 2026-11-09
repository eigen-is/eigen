// A comment drawn as a card: a CommentCard and its index row mapped onto NoteCard, with the cover and the attachment
// count read through the document's media resolver. A list renders one per row, since a hook can't run inside its map.
// The caller decides what varies, such as the pane's prefixed title or the width of a board's drag overlay.

import type { CommentEntry } from '@workspace/lib/types/chat';
import type { CommentCard } from '@workspace/lib/types/comments';
import { useAttachmentMeta } from '../attachment/use-attachment-meta';
import { NoteCard } from '../notes/note-card';

export function CommentNoteCard({
    card,
    entry,
    title,
    unread,
    deleted,
    onClick,
    onContextMenu,
    className,
}: {
    card: CommentCard;
    entry: CommentEntry | undefined;
    title: string;
    unread: boolean;
    deleted?: boolean;
    onClick?: () => void;
    onContextMenu?: (e: React.MouseEvent) => void;
    className?: string;
}) {
    const { coverThumbnailUrl, attachmentCount } = useAttachmentMeta(card.attachments);
    return (
        <NoteCard
            title={title}
            description={card.description}
            color={card.color}
            replyCount={entry?.messageCount}
            unread={unread}
            resolved={entry?.status === 'resolved'}
            coverThumbnailUrl={coverThumbnailUrl}
            attachmentCount={attachmentCount}
            assigneeEmail={entry?.assignee}
            deleted={deleted}
            onClick={onClick}
            onContextMenu={onContextMenu}
            className={className}
        />
    );
}
