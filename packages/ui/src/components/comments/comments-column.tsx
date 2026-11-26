// A document's comments column: the comments or activity list, which drills into one comment's thread in the same
// column, with "‹ Comments" back to the list. The column eases wider as a thread opens, and the list stays mounted
// under it, so back finds it scrolled where it was. The thread's actions sit in the bar, and Edit opens the
// card's form in a dialog. useCommentsColumn holds what it shows; a shell puts it at the right, or over a phone.

import type { useCommentFilter, useCommentLifecycle } from '@workspace/lib/comments';
import type { ActiveComments } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { cn } from '@workspace/ui/lib/utils';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useDialogPending } from '../../hooks/use-dialog-pending';
import { useDiscardChanges } from '../../hooks/use-discard-changes';
import type { CardDetailParts } from '../cards/card-detail';
import { CardDetail } from '../cards/card-detail';
import type { useContextMenu } from '../context-menu';
import { Dialog, DialogContent } from '../dialog';
import { columnWidthPx } from '../layout/app/column-widths';
import { DetailColumn } from '../layout/app/detail-column';
import { useLayout } from '../layout/app/layout-context';
import { LeaveGuard } from '../layout/app/leave-guard';
import { LoadingState } from '../layout/app/loading-state';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { ActivityPanel } from './activity-panel';
import { lifecycleCardDetailProps } from './comment-card-dialog';
import { CommentFilterButton } from './comment-filter-button';
import type { CommentContextMenuItem } from './comment-menu-items';
import { CommentPanel } from './comment-panel';
import type { CommentsColumnState } from './use-comments-column';

// The open thread's colored block sits this far below the column's top: under the bar's h-12 and the card body's pt-1.
export const THREAD_BLOCK_TOP_PX = 48 + 4;

type CommentsColumnProps = {
    column: CommentsColumnState;
    lifecycle: ReturnType<typeof useCommentLifecycle>;
    path: DrivePath;
    canWrite: boolean;
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
    currentUserEmail,
    filter,
    activeComments,
    commentContextMenu,
    onAddComment,
}: CommentsColumnProps) {
    const showComments = column.listPanel === 'comments';
    const { threadOpen } = column;
    const { isMobile, isTablet } = useLayout();
    // Each level is laid out at its own width from the first frame, so the column clips it while it eases between them
    // and no text rewraps. A phone's column is the screen.
    const levelStyle = (width: 'small' | 'large') =>
        isMobile ? { right: 0 } : { width: columnWidthPx(width, isTablet) };

    const listActions = showComments && (
        <>
            {onAddComment && <TooltipButton icon={Plus} tooltipText="New comment" onClick={onAddComment} />}
            <CommentFilterButton filter={filter} members={lifecycle.members} currentUserEmail={currentUserEmail} />
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
                    width={column.width}
                    title={showComments ? 'Comments' : 'Activity'}
                    onBack={threadOpen ? column.back : undefined}
                    actions={threadOpen ? thread?.actions : listActions}
                    onClose={column.close}
                    fill
                >
                    <div className="relative h-full">
                        {/* Invisible, not unmounted or display: none, so back finds its scroll. */}
                        <div
                            className={cn('absolute inset-y-0 left-0 overflow-y-auto', threadOpen && 'invisible')}
                            style={levelStyle('small')}
                        >
                            {list}
                        </div>
                        {threadOpen && (
                            <div
                                className="absolute inset-y-0 left-0 flex flex-col bg-background"
                                style={levelStyle('large')}
                            >
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
