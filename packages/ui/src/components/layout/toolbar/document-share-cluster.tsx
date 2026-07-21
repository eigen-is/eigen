import { useIsMobile } from '@workspace/lib/media';
import { Activity, MessageSquare, Pencil, UserRoundPlus } from 'lucide-react';
import { useRef } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '../../dropdown-menu';
import { CountBadge } from '../count-badge';
import { useOptionalDocSearchBar } from '../search/doc-search-provider';
import { FindInDocumentButton, FindInDocumentMenuItem } from '../search/find-in-document-button';
import { DocumentModeButton } from './document-mode-button';
import { KebabTrigger } from './kebab-trigger';
import { TooltipButton } from './tooltip-button';
import { WatchMenuItem, WatchToggleButton } from './watch-toggle-button';

type DocumentShareClusterProps = {
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    onRename?: () => void;
    onToggleCommentPanel?: () => void;
    commentPanelOpen?: boolean;
    unresolvedCommentCount?: number;
    watchTarget?: { ownerId: string; mountId: string; pathId: string };
    onToggleActivityPanel?: () => void;
    activityPanelOpen?: boolean;
};

export function DocumentShareCluster({
    canWrite,
    onAccessDialogOpen,
    onRename,
    onToggleCommentPanel,
    commentPanelOpen,
    unresolvedCommentCount,
    watchTarget,
    onToggleActivityPanel,
    activityPanelOpen,
}: DocumentShareClusterProps) {
    const isMobile = useIsMobile();
    const docSearchBar = useOptionalDocSearchBar();
    // Radix restores focus to the trigger while the menu closes, stealing it from the just-opened
    // find bar — same machinery as EditMenu: the Find item flags the pick, onCloseAutoFocus re-opens.
    const focusFindBarRef = useRef(false);

    // Mobile: collapse the icon row into a kebab. No read-only Eye marker here (settled decision).
    if (isMobile) {
        return (
            <div className="relative">
                <DropdownMenu>
                    <KebabTrigger />
                    <DropdownMenuContent
                        align="end"
                        onCloseAutoFocus={(e) => {
                            if (!focusFindBarRef.current) return;
                            focusFindBarRef.current = false;
                            e.preventDefault();
                            docSearchBar?.open();
                        }}
                    >
                        {onRename && (
                            <DropdownMenuItem onClick={onRename}>
                                <Pencil className="mr-2" />
                                Edit
                            </DropdownMenuItem>
                        )}
                        {/* Null-safe: renders nothing when the surface has no DocSearchProvider */}
                        <FindInDocumentMenuItem focusFindBarRef={focusFindBarRef} />
                        {onToggleActivityPanel && (
                            <DropdownMenuItem onClick={onToggleActivityPanel}>
                                <Activity className="mr-2" />
                                Activity
                            </DropdownMenuItem>
                        )}
                        {watchTarget && <WatchMenuItem {...watchTarget} />}
                        {onToggleCommentPanel && (
                            <DropdownMenuItem onClick={onToggleCommentPanel}>
                                <MessageSquare className="mr-2" />
                                {unresolvedCommentCount ? `Comments (${unresolvedCommentCount})` : 'Comments'}
                            </DropdownMenuItem>
                        )}
                        {canWrite && (
                            <DropdownMenuItem onClick={onAccessDialogOpen}>
                                <UserRoundPlus className="mr-2" />
                                Share
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
                {onToggleCommentPanel && <CountBadge count={unresolvedCommentCount ?? 0} />}
            </div>
        );
    }

    return (
        <>
            {onRename && <TooltipButton icon={Pencil} tooltipText="Edit" onClick={onRename} />}
            {/* Null-safe: renders nothing when the surface has no DocSearchProvider */}
            <FindInDocumentButton />
            {onToggleActivityPanel && (
                <TooltipButton
                    icon={Activity}
                    tooltipText="Activity"
                    onClick={onToggleActivityPanel}
                    active={activityPanelOpen}
                />
            )}
            {watchTarget && <WatchToggleButton {...watchTarget} />}
            {onToggleCommentPanel && (
                <div className="relative">
                    <TooltipButton
                        icon={MessageSquare}
                        tooltipText="Comments"
                        onClick={onToggleCommentPanel}
                        active={commentPanelOpen}
                    />
                    <CountBadge count={unresolvedCommentCount ?? 0} />
                </div>
            )}
            {canWrite ? (
                <TooltipButton icon={UserRoundPlus} tooltipText="Share" onClick={onAccessDialogOpen} />
            ) : (
                <DocumentModeButton />
            )}
        </>
    );
}
