// A document's comments or activity pane, one component for every viewport: a Column whose toolbar carries the
// title, the filter and the close button, so the panels below stay plain bodies. Column gives the back arrow on
// mobile and the fixed-width sibling on desktop. Mount it outside any <ColumnLayout mobileColumn="…">: a Column
// whose id doesn't match hides itself, so a host that wraps this one silently gets no pane at all.

import type { useCommentFilter } from '@workspace/lib/comments';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { ActiveComments, CommentCard, DocumentPanel } from '@workspace/lib/types/comments';
import type { DrivePath } from '@workspace/lib/types/drive';
import type { EffectiveMember } from '@workspace/lib/types/drive-access';
import { cn } from '@workspace/ui/lib/utils';
import { Plus, X } from 'lucide-react';
import type { useContextMenu } from '../context-menu';
import { Column } from '../layout/app/column-layout';
import { useLayout } from '../layout/app/layout-context';
import { ToolbarTitle } from '../layout/toolbar/toolbar-title';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { PROPERTIES_PANEL_WIDTH_PX } from '../properties-panel';
import { ActivityPanel } from './activity-panel';
import { CommentFilterButton } from './comment-filter-button';
import type { CommentContextMenuItem } from './comment-menu-items';
import { CommentPanel } from './comment-panel';

// A host that shows only the activity, such as stickies, never renders the comments body, so it passes neither.
const NO_ACTIVE_COMMENTS: ActiveComments = { ids: new Set() };
const NEVER_DELETED = () => false;

type PanelColumnProps = {
    activePanel: DocumentPanel;
    onClose: () => void;
    path: DrivePath;
    cards: Readonly<Record<string, CommentCard>>;
    entries: readonly CommentEntry[];
    members: EffectiveMember[];
    currentUserEmail: string;
    filter: ReturnType<typeof useCommentFilter>;
    activeComments?: ActiveComments;
    isCardDeleted?: (card: CommentCard) => boolean;
    commentContextMenu: ReturnType<typeof useContextMenu<CommentContextMenuItem>>;
    onOpenCard: (cardId: string) => void;
    // Opens an activity row's comment by its chat name, live or as deleted, such as the lifecycle's openChat.
    onOpenChat: (chatName: string) => void;
    // A canvas host, such as slides, adds a document-level comment from the panel, anchored to no element. A host
    // that anchors each comment to its own content, such as docs, leaves it out.
    onAddComment?: () => void;
};

export function PanelColumn({
    activePanel,
    onClose,
    path,
    cards,
    entries,
    members,
    currentUserEmail,
    filter,
    activeComments = NO_ACTIVE_COMMENTS,
    isCardDeleted = NEVER_DELETED,
    commentContextMenu,
    onOpenCard,
    onOpenChat,
    onAddComment,
}: PanelColumnProps) {
    const { isMobile } = useLayout();
    const showComments = activePanel === 'comments';

    return (
        <Column
            id="panel"
            width={`${PROPERTIES_PANEL_WIDTH_PX}px`}
            className={cn('bg-background', !isMobile && 'border-l')}
            onBack={onClose}
            toolbarBorder="always"
            toolbar={
                <>
                    <ToolbarTitle>{showComments ? 'Comments' : 'Activity'}</ToolbarTitle>
                    <div className="ml-auto flex items-center gap-1">
                        {showComments && onAddComment && (
                            <TooltipButton icon={Plus} tooltipText="New comment" onClick={onAddComment} />
                        )}
                        {showComments && (
                            <CommentFilterButton
                                filter={filter}
                                members={members}
                                currentUserEmail={currentUserEmail}
                            />
                        )}
                        {/* Mobile closes with Column's own back arrow. */}
                        {!isMobile && <TooltipButton icon={X} tooltipText="Close" onClick={onClose} />}
                    </div>
                </>
            }
        >
            {showComments ? (
                <CommentPanel
                    cards={cards}
                    entries={entries}
                    activeCardIds={activeComments.ids}
                    titlePrefixes={activeComments.titlePrefixes}
                    isCardDeleted={isCardDeleted}
                    pathId={path.id}
                    currentUserEmail={currentUserEmail}
                    filter={filter}
                    className="w-full border-l-0"
                    onCommentClick={onOpenCard}
                    onCommentContextMenu={(e, card, entry) => commentContextMenu.handleContextMenu(e, { card, entry })}
                />
            ) : (
                <ActivityPanel
                    path={path}
                    className="w-full border-l-0"
                    onOpenCard={onOpenCard}
                    onOpenChat={onOpenChat}
                />
            )}
        </Column>
    );
}
