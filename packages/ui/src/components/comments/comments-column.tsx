// A document's comments column: the comments or activity list, which drills into one comment's thread in the same
// column, with "‹ Comments" back to the list. The list is medium and a thread large, so the column grows as a thread
// opens. The list stays mounted under the thread, hidden at the list's own width, so back finds it scrolled where it
// was. The thread scrolls over its own reply box, its actions sit in the bar, and Edit opens the card's form in a
// dialog. useCommentsColumn holds what it shows; an editor's shell puts it in its right slot, or full screen on a phone.

import type { useCommentFilter, useCommentLifecycle } from '@workspace/lib/comments';
import type { ActiveComments } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { EffectiveMember } from '@workspace/lib/types/drive-access';
import { cn } from '@workspace/ui/lib/utils';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useDialogPending } from '../../hooks/use-dialog-pending';
import { useDiscardChanges } from '../../hooks/use-discard-changes';
import type { CardDetailParts } from '../cards/card-detail';
import { CardDetail } from '../cards/card-detail';
import type { useContextMenu } from '../context-menu';
import { Dialog, DialogContent } from '../dialog';
import { DetailColumn } from '../layout/app/detail-column';
import { LeaveGuard } from '../layout/app/leave-guard';
import { LoadingState } from '../layout/app/loading-state';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { ActivityPanel } from './activity-panel';
import { lifecycleCardDetailProps } from './comment-card-dialog';
import { CommentFilterButton } from './comment-filter-button';
import type { CommentContextMenuItem } from './comment-menu-items';
import { CommentPanel } from './comment-panel';
import type { CommentsColumnState } from './use-comments-column';

type CommentsColumnProps = {
    column: CommentsColumnState;
    lifecycle: ReturnType<typeof useCommentLifecycle>;
    path: DrivePath;
    canWrite: boolean;
    members: EffectiveMember[];
    currentUserEmail: string;
    filter: ReturnType<typeof useCommentFilter>;
    activeComments: ActiveComments;
    commentContextMenu: ReturnType<typeof useContextMenu<CommentContextMenuItem>>;
    // A canvas host, such as slides, adds a document-level comment from the list, anchored to no element. A host that
    // anchors each comment to its own content, such as docs, leaves it out.
    onAddComment?: () => void;
};

export function CommentsColumn({
    column,
    lifecycle,
    path,
    canWrite,
    members,
    currentUserEmail,
    filter,
    activeComments,
    commentContextMenu,
    onAddComment,
}: CommentsColumnProps) {
    const showComments = column.listPanel === 'comments';
    const { threadOpen } = column;

    const listActions = showComments && (
        <>
            {onAddComment && <TooltipButton icon={Plus} tooltipText="New comment" onClick={onAddComment} />}
            <CommentFilterButton filter={filter} members={members} currentUserEmail={currentUserEmail} />
        </>
    );

    const list = showComments ? (
        <CommentPanel
            cards={lifecycle.cards}
            entries={lifecycle.allComments}
            activeCardIds={activeComments.ids}
            titlePrefixes={activeComments.titlePrefixes}
            isCardDeleted={lifecycle.isCardDeleted}
            pathId={path.id}
            currentUserEmail={currentUserEmail}
            filter={filter}
            onCommentClick={column.openThread}
            onCommentContextMenu={(e, card, entry) => commentContextMenu.handleContextMenu(e, { card, entry })}
        />
    ) : (
        <ActivityPanel path={path} onOpenCard={column.openThread} onOpenChat={column.openChat} />
    );

    return (
        <CardDetail
            {...lifecycleCardDetailProps(lifecycle, path, canWrite, currentUserEmail)}
            autoFocus={column.focusComposer}
        >
            {(thread) => (
                <DetailColumn
                    width={threadOpen ? 'large' : 'medium'}
                    title={showComments ? 'Comments' : 'Activity'}
                    onBack={threadOpen ? column.back : undefined}
                    actions={threadOpen ? thread?.actions : listActions}
                    onClose={column.close}
                    fill
                >
                    <div className="relative h-full">
                        {/* Invisible, not unmounted or display: none, and as wide as at the list level, so its rows
                            don't wrap again and back finds its scroll. */}
                        <div
                            className={cn('absolute inset-y-0 left-0 overflow-y-auto', threadOpen && 'invisible')}
                            style={{ right: threadOpen ? column.growPx : 0 }}
                        >
                            {list}
                        </div>
                        {threadOpen && (
                            <div className="absolute inset-0 flex flex-col bg-background">
                                {!thread ? (
                                    <LoadingState />
                                ) : thread.deleted ? (
                                    <div className="app-gutter-x pt-4">{thread.body}</div>
                                ) : (
                                    thread.body
                                )}
                            </div>
                        )}
                    </div>
                    <CommentEditDialog
                        editForm={thread?.editForm ?? null}
                        onEditingChange={lifecycle.setOpenCardEditing}
                    />
                </DetailColumn>
            )}
        </CardDetail>
    );
}

// The open card's edit form, in a dialog over the column. A save ends the edit once it lands, and a close, or a
// navigation that would close or switch the card, asks "Discard changes?" once the form changed.
function CommentEditDialog({
    editForm,
    onEditingChange,
}: {
    editForm: CardDetailParts['editForm'];
    onEditingChange: (editing: boolean) => void;
}) {
    const open = !!editForm;
    const { pending, run } = useDialogPending({ open, onOpenChange: onEditingChange });
    const [changed, setChanged] = useState(false);
    const discard = useDiscardChanges({ open, changed, pending, onDiscard: () => onEditingChange(false) });
    return (
        <>
            <Dialog open={open} onOpenChange={discard.onOpenChange}>
                <DialogContent onFocus={discard.onFocus}>
                    {editForm?.({ pending, run, onChangedChange: setChanged, dialogTitle: 'Edit comment' })}
                </DialogContent>
            </Dialog>
            {discard.dialog}
            <LeaveGuard active={open && changed} />
        </>
    );
}
