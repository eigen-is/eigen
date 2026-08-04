import type { useCommentFilter } from '@workspace/lib/comments';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { ActiveComments, CommentCard, DocumentPanel } from '@workspace/lib/types/comments';
import type { DrivePath, EffectiveMember } from '@workspace/lib/types/drive';
import { Column } from '../app/column-layout';
import type { useContextMenu } from '../context-menu';
import { ToolbarTitle } from '../toolbar/toolbar-title';
import { ActivityPanel } from './activity-panel';
import { CommentFilterButton } from './comment-filter-button';
import type { CommentContextMenuItem } from './comment-menu-items';
import { CommentPanel } from './comment-panel';

// The mobile comments/activity pane shared by docs, slides and sheets: a full-width Column carrying
// the chrome the panels drop. Mount it OUTSIDE any <ColumnLayout mobileColumn="…"> — a Column whose id
// doesn't match self-hides, so a host that wraps this one gets no pane at all, silently.
type MobilePanelColumnProps = {
    activePanel: DocumentPanel;
    onBack: () => void;
    path: DrivePath;
    cards: Record<string, CommentCard>;
    entries: CommentEntry[];
    members: EffectiveMember[];
    currentUserEmail: string;
    filter: ReturnType<typeof useCommentFilter>;
    activeComments: ActiveComments;
    commentContextMenu: ReturnType<typeof useContextMenu<CommentContextMenuItem>>;
    // Rows only open the card: the editor is hidden behind this pane, so revealing an anchor is unseen.
    onOpenCard: (cardId: string) => void;
};

export function MobilePanelColumn({
    activePanel,
    onBack,
    path,
    cards,
    entries,
    members,
    currentUserEmail,
    filter,
    activeComments,
    commentContextMenu,
    onOpenCard,
}: MobilePanelColumnProps) {
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
                            <CommentFilterButton
                                filter={filter}
                                members={members}
                                currentUserEmail={currentUserEmail}
                                // Touch target, matching the back arrow; the header's 24px is desktop density.
                                className="h-8 w-8"
                            />
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
                    entries={entries}
                    activeCardIds={activeComments.ids}
                    anchorTexts={activeComments.anchorTexts}
                    currentUserEmail={currentUserEmail}
                    filter={filter}
                    members={members}
                    className="w-full border-l-0"
                    onCommentClick={onOpenCard}
                    onCommentContextMenu={(e, card, entry) => commentContextMenu.handleContextMenu(e, { card, entry })}
                />
            ) : (
                <ActivityPanel path={path} cards={cards} className="w-full border-l-0" onOpenCard={onOpenCard} />
            )}
        </Column>
    );
}
