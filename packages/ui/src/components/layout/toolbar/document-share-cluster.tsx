import { useIsMobile } from '@workspace/lib/media';
import { Activity, MessageSquare, Pencil, UserRoundPlus, WifiOff } from 'lucide-react';
import { CountBadge } from '../../count-badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '../../dropdown-menu';
import { FindInDocumentButton, FindInDocumentMenuItem, useFindBarRefocus } from '../../search/find-in-document-button';
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
    assignedCommentCount?: number;
    watchTarget?: { ownerId: string; mountId: string; pathId: string };
    onToggleActivityPanel?: () => void;
    activityPanelOpen?: boolean;
    // Collab socket down after first load: edits stay local until it reconnects.
    offline?: boolean;
};

export function DocumentShareCluster(props: DocumentShareClusterProps) {
    const isMobile = useIsMobile();

    // Mobile: collapse the icon row into a kebab. Its own useFindBarRefocus keeps the find-bar
    // keystroke subscription off the desktop cluster (which would otherwise churn the Watch queries).
    if (isMobile) return <MobileClusterKebab {...props} />;

    const {
        canWrite,
        onAccessDialogOpen,
        onRename,
        onToggleCommentPanel,
        commentPanelOpen,
        assignedCommentCount,
        watchTarget,
        onToggleActivityPanel,
        activityPanelOpen,
        offline,
    } = props;

    return (
        <>
            {offline && <OfflineBadge />}
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
                        tooltipText={
                            assignedCommentCount ? `Comments (${assignedCommentCount} assigned to you)` : 'Comments'
                        }
                        onClick={onToggleCommentPanel}
                        active={commentPanelOpen}
                    />
                    <CountBadge count={assignedCommentCount ?? 0} />
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

// Mobile kebab, split out so its DocSearchBar subscription (via useFindBarRefocus) stays off the
// desktop cluster. No Eye marker and no open-state cue: an open panel takes the viewport (settled).
function MobileClusterKebab({
    canWrite,
    onAccessDialogOpen,
    onRename,
    onToggleCommentPanel,
    assignedCommentCount,
    watchTarget,
    onToggleActivityPanel,
    offline,
}: DocumentShareClusterProps) {
    const { focusFindBarRef, onCloseAutoFocus } = useFindBarRefocus();

    return (
        <>
            {offline && <OfflineBadge compact />}
            <div className="relative">
                <DropdownMenu>
                    <KebabTrigger />
                    <DropdownMenuContent align="end" onCloseAutoFocus={onCloseAutoFocus}>
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
                                {assignedCommentCount ? `Comments (${assignedCommentCount})` : 'Comments'}
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
                {onToggleCommentPanel && <CountBadge count={assignedCommentCount ?? 0} />}
            </div>
        </>
    );
}

// Sits beside the icon buttons: the socket is down but the editor stays live, so the user needs
// to know edits are safe as long as this tab stays open. Mobile keeps only the icon.
function OfflineBadge({ compact }: { compact?: boolean }) {
    const label = 'Offline, will sync when back online';
    return (
        <span
            className="flex h-7 items-center gap-1.5 rounded-md border bg-muted px-2 text-xs text-muted-foreground"
            title={compact ? label : undefined}
        >
            <WifiOff className="size-3.5" />
            {!compact && label}
        </span>
    );
}
