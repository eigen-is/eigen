import { useIsMobile } from '@workspace/lib/media';
import { Activity, MessageSquare, MoreVertical, Pencil, Search, UserRoundPlus } from 'lucide-react';
import { Button } from '../../button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../dropdown-menu';
import { CountBadge } from '../count-badge';
import { useOptionalDocSearchBar } from '../search/doc-search-provider';
import { FindInDocumentButton } from '../search/find-in-document-button';
import { DocumentModeButton } from './document-mode-button';
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

    // Mobile: collapse the icon row into a kebab. No read-only Eye marker here (settled decision).
    if (isMobile) {
        return (
            <div className="relative">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8" title="More actions">
                            <MoreVertical className="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        {onRename && (
                            <DropdownMenuItem onClick={onRename}>
                                <Pencil className="mr-2" />
                                Edit
                            </DropdownMenuItem>
                        )}
                        {docSearchBar && (
                            <DropdownMenuItem onClick={docSearchBar.open}>
                                <Search className="mr-2" />
                                Find in document
                            </DropdownMenuItem>
                        )}
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
