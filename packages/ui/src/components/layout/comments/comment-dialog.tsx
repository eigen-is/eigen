import { formatDateTime } from '@workspace/lib/date';
import { useResolvedUser } from '@workspace/lib/public';
import type { CommentEntry } from '@workspace/lib/types/chat';
import { Check, RotateCcw } from 'lucide-react';
import { NoteCardDialog } from '../notes/note-card-dialog';
import { CommentThread } from './comment-thread';

export function useCreatedByMeta(email: string | undefined, createdAt: Date | number) {
    const { displayName } = useResolvedUser({ email });
    const name = displayName || email?.split('@')[0] || 'unknown';
    return `Created by ${name} on ${formatDateTime(createdAt)}`;
}

type CommentDialogProps = {
    comment: CommentEntry;
    title: string;
    ownerId: string;
    mountId: string;
    copyLinkUrl?: string;
    onClose: () => void;
    onResolve: (chatName: string, status: 'resolved' | 'open') => void;
};

export function CommentDialog({
    comment,
    title,
    ownerId,
    mountId,
    copyLinkUrl,
    onClose,
    onResolve,
}: CommentDialogProps) {
    const meta = useCreatedByMeta(comment.lastAuthorEmail ?? undefined, comment.createdAt);

    return (
        <NoteCardDialog
            open
            onOpenChange={(open) => {
                if (!open) onClose();
            }}
            title={title}
            meta={meta}
            color={comment.color}
            actionIcon={comment.status === 'open' ? Check : RotateCcw}
            actionTooltip={comment.status === 'open' ? 'Resolve' : 'Re-open'}
            onAction={() => onResolve(comment.chatName, comment.status === 'open' ? 'resolved' : 'open')}
            copyLinkUrl={copyLinkUrl}
        >
            <CommentThread ownerId={ownerId} mountId={mountId} chatName={comment.chatName} />
        </NoteCardDialog>
    );
}
