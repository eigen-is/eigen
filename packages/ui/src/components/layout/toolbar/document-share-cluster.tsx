import { MessageSquare, UserRoundPlus } from 'lucide-react';
import { CountBadge } from '../count-badge';
import { DocumentModeButton } from './document-mode-button';
import { TooltipButton } from './tooltip-button';
import { WatchToggleButton } from './watch-toggle-button';

type DocumentShareClusterProps = {
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    onToggleCommentPanel?: () => void;
    commentPanelOpen?: boolean;
    unresolvedCommentCount?: number;
    watchTarget?: { ownerId: string; mountId: string; pathId: string };
};

export function DocumentShareCluster({
    canWrite,
    onAccessDialogOpen,
    onToggleCommentPanel,
    commentPanelOpen,
    unresolvedCommentCount,
    watchTarget,
}: DocumentShareClusterProps) {
    return (
        <>
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
                <DocumentModeButton canWrite={canWrite} />
            )}
        </>
    );
}
