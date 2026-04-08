import type { DrivePath } from '@workspace/lib/types/drive';
import { CountBadge, TooltipButton } from '@workspace/ui';
import { DriveCreateSheets } from '@workspace/ui/components/layout/drive/drive-create-sheets';
import { DocumentModeButton } from '@workspace/ui/components/layout/toolbar/document-mode-button';
import { FileMenu } from '@workspace/ui/components/layout/toolbar/file-menu';
import { MessageSquare, UserRoundPlus } from 'lucide-react';

type ToolbarLeftProps = {
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    onRestore: (state: Uint8Array) => void;
    path: DrivePath;
};

type ToolbarRightProps = {
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    onToggleCommentPanel?: () => void;
    commentPanelOpen?: boolean;
    unresolvedCommentCount?: number;
};

export function ToolbarLeftItems({ path, onAccessDialogOpen, onRestore, canWrite }: ToolbarLeftProps) {
    return (
        <FileMenu
            path={path}
            canWrite={canWrite}
            onAccessDialogOpen={onAccessDialogOpen}
            onRestore={onRestore}
            createLabel="New sheet"
            CreateDialog={DriveCreateSheets}
        />
    );
}

export function ToolbarRightItems({
    canWrite,
    onAccessDialogOpen,
    onToggleCommentPanel,
    commentPanelOpen,
    unresolvedCommentCount,
}: ToolbarRightProps) {
    return (
        <>
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
