import type { useCommentFilter } from '@workspace/lib/comments';
import type { CommentEntry } from '@workspace/lib/types/chat';
import type { ActiveComments, CommentCard, DocumentPanel } from '@workspace/lib/types/comments';
import type { DrivePath, EffectiveMember } from '@workspace/lib/types/drive';
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

// Activity-only hosts (stickies) never render the comments body.
const NO_ACTIVE_COMMENTS: ActiveComments = { ids: new Set(), anchorTexts: new Map() };

// The comments/activity pane, one component for every viewport: a Column whose toolbar carries the
// title, the filter and the close affordance, so the panels below stay pure bodies. Column itself
// gives the back arrow on mobile and the fixed-width sibling on desktop.
// Mount it OUTSIDE any <ColumnLayout mobileColumn="…"> — a Column whose id doesn't match self-hides,
// so a host that wraps this one gets no pane at all, silently.
type PanelColumnProps = {
    activePanel: DocumentPanel;
    onClose: () => void;
    path: DrivePath;
    cards: Record<string, CommentCard>;
    entries: CommentEntry[];
    members: EffectiveMember[];
    currentUserEmail: string;
    filter: ReturnType<typeof useCommentFilter>;
    activeComments?: ActiveComments;
    commentContextMenu: ReturnType<typeof useContextMenu<CommentContextMenuItem>>;
    onOpenCard: (cardId: string) => void;
    // Document-level hosts (vector) create comments from the panel — cards anchor to the document, not
    // to a selected object/text/cell, so there is no in-canvas add affordance. Absent for the
    // content-anchored hosts (docs/slides/sheets/stickies), which add against their own anchor.
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
    commentContextMenu,
    onOpenCard,
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
                    anchorTexts={activeComments.anchorTexts}
                    currentUserEmail={currentUserEmail}
                    filter={filter}
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
