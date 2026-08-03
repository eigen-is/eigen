import { useAuth } from '@workspace/lib/auth';
import type { useCommentFilter, useCommentLifecycle } from '@workspace/lib/comments';
import type { ActiveComments } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Column } from '../app/column-layout';
import type { useContextMenu } from '../context-menu';
import { ActivityPanel } from '../drive/activity-panel';
import { ToolbarTitle } from '../toolbar/toolbar-title';
import { CommentFilterButton } from './comment-filter-button';
import type { CommentContextMenuItem } from './comment-menu-items';
import { CommentPanel } from './comment-panel';

// The mobile comments/activity pane, identical across docs, slides and sheets: a full-width Column
// carrying the back arrow, the title and (for comments) the filter, so the panel drops its header.
// Mount it outside any <ColumnLayout mobileColumn="…">: a Column self-hides when its id doesn't
// match, so a host that wraps this one gets no pane at all, silently.
type MobilePanelColumnProps = {
    activePanel: 'comments' | 'activity';
    onBack: () => void;
    path: DrivePath;
    lifecycle: ReturnType<typeof useCommentLifecycle>;
    activeComments: ActiveComments;
    filter: ReturnType<typeof useCommentFilter>;
    commentContextMenu: ReturnType<typeof useContextMenu<CommentContextMenuItem>>;
    // Both take a resolved cardId. Hosts pass plain open handlers: the editor is hidden while this
    // pane is up, so revealing an anchor there would drive a view nobody can see.
    onCommentClick: (cardId: string) => void;
    onOpenCard: (cardId: string) => void;
};

export function MobilePanelColumn({
    activePanel,
    onBack,
    path,
    lifecycle,
    activeComments,
    filter,
    commentContextMenu,
    onCommentClick,
    onOpenCard,
}: MobilePanelColumnProps) {
    const { user } = useAuth();
    const { cards, allComments, members } = lifecycle;
    const showComments = activePanel === 'comments';

    return (
        <Column
            id="panel"
            width="flex"
            onBack={onBack}
            toolbar={
                showComments ? (
                    <>
                        <ToolbarTitle>Comments</ToolbarTitle>
                        <div className="ml-auto">
                            <CommentFilterButton filter={filter} members={members} currentUserEmail={user!.email} />
                        </div>
                    </>
                ) : (
                    <ToolbarTitle>Activity</ToolbarTitle>
                )
            }
        >
            {showComments ? (
                <CommentPanel
                    cards={cards}
                    entries={allComments}
                    activeCardIds={activeComments.ids}
                    anchorTexts={activeComments.anchorTexts}
                    currentUserEmail={user!.email}
                    filter={filter}
                    members={members}
                    className="w-full border-l-0"
                    onCommentClick={onCommentClick}
                    onCommentContextMenu={(e, card, entry) => commentContextMenu.handleContextMenu(e, { card, entry })}
                />
            ) : (
                <ActivityPanel path={path} cards={cards} className="w-full border-l-0" onOpenCard={onOpenCard} />
            )}
        </Column>
    );
}
