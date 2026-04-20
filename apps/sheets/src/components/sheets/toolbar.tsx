import { useExportDocument, useImportDocument } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { CountBadge, TooltipButton } from '@workspace/ui';
import { DriveCreateSheets } from '@workspace/ui/components/layout/drive/drive-create-sheets';
import { ExportProgressDialog } from '@workspace/ui/components/layout/drive/export-progress-dialog';
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
    const importMutation = useImportDocument(path.ownerId, path.mountId);
    const { exportDocument, isExporting } = useExportDocument();

    const handleImport = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.xlsx';
        input.onchange = () => {
            const file = input.files?.[0];
            if (file) importMutation.mutate({ pathId: path.id, file });
        };
        input.click();
    };

    const handleExport = (format: string) => exportDocument(path.ownerId, path.mountId, path.id, format);

    return (
        <>
            <FileMenu
                path={path}
                canWrite={canWrite}
                onAccessDialogOpen={onAccessDialogOpen}
                onRestore={onRestore}
                onImport={handleImport}
                importLabel="Import xlsx file…"
                onExport={handleExport}
                exportFormats={['xlsx', 'html']}
                createLabel="New sheet"
                CreateDialog={DriveCreateSheets}
            />
            <ExportProgressDialog open={isExporting} />
        </>
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
