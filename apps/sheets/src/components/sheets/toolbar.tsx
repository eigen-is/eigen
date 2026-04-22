import { useExportDocument, useImportDocument, useImportFromDrive } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { CountBadge, TooltipButton } from '@workspace/ui';

import { DriveFilePicker } from '@workspace/ui/components/layout/drive/drive-file-picker';
import { ExportProgressDialog } from '@workspace/ui/components/layout/drive/export-progress-dialog';
import { DocumentModeButton } from '@workspace/ui/components/layout/toolbar/document-mode-button';
import { FileMenu } from '@workspace/ui/components/layout/toolbar/file-menu';
import { MessageSquare, Sheet, UserRoundPlus } from 'lucide-react';
import { useRef, useState } from 'react';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

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
    const importFromDriveMutation = useImportFromDrive(path.ownerId, path.mountId);
    const { exportDocument, isExporting } = useExportDocument();
    const [importPickerOpen, setImportPickerOpen] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleImport = () => setImportPickerOpen(true);

    const handleImportFromDrive = (paths: DrivePath[]) => {
        const source = paths[0];
        if (!source) return;
        importFromDriveMutation.mutate({
            pathId: path.id,
            sourceOwnerId: source.ownerId,
            sourceMountId: source.mountId,
            sourcePathId: source.id,
        });
    };

    const handleImportFromDevice = () => {
        setImportPickerOpen(false);
        setTimeout(() => fileInputRef.current?.click(), 0);
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) importMutation.mutate({ pathId: path.id, file });
        e.target.value = '';
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
                exportFormats={['xlsx', 'pdf', 'html']}
                createLabel="New sheet"
                createIcon={Sheet}
                createType="sheets"
            />
            <ExportProgressDialog open={isExporting} />
            <DriveFilePicker
                open={importPickerOpen}
                onOpenChange={setImportPickerOpen}
                title="Import xlsx file"
                mimeFilter={[XLSX_MIME]}
                onSelect={handleImportFromDrive}
                onUploadFromDevice={handleImportFromDevice}
            />
            <input ref={fileInputRef} type="file" accept=".xlsx" className="hidden" onChange={handleFileChange} />
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
