import { XLSX_MIME } from '@workspace/lib/constants/mime';
import { useExportDocument, useImportDocument, useImportFromDrive } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';

import { DrivePickerWithUpload } from '@workspace/ui/components/layout/drive/drive-picker-with-upload';
import { ProgressDialog } from '@workspace/ui/components/layout/drive/progress-dialog';
import { FileMenu } from '@workspace/ui/components/layout/toolbar/file-menu';
import { Sheet } from 'lucide-react';
import { useState } from 'react';

type ToolbarLeftProps = {
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    path: DrivePath;
};

export function ToolbarLeftItems({ path, onAccessDialogOpen, canWrite }: ToolbarLeftProps) {
    const importMutation = useImportDocument(path.ownerId, path.mountId);
    const importFromDriveMutation = useImportFromDrive(path.ownerId, path.mountId);
    const { exportDocument, isExporting } = useExportDocument();
    const [importPickerOpen, setImportPickerOpen] = useState(false);

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

    const handleImportFromDevice = (files: File[]) => {
        const file = files[0];
        if (file) importMutation.mutate({ pathId: path.id, file });
    };

    const handleExport = (format: string) => exportDocument(path.ownerId, path.mountId, path.id, format);

    return (
        <>
            <FileMenu
                path={path}
                canWrite={canWrite}
                onAccessDialogOpen={onAccessDialogOpen}
                onImport={handleImport}
                importLabel="Import xlsx file…"
                onExport={handleExport}
                exportFormats={['xlsx', 'pdf', 'html']}
                createLabel="New sheet"
                createIcon={Sheet}
                createType="sheets"
            />
            <ProgressDialog open={isExporting} title="Exporting document" />
            <DrivePickerWithUpload
                open={importPickerOpen}
                onOpenChange={setImportPickerOpen}
                title="Import xlsx file"
                mimeFilter={[XLSX_MIME]}
                onPickFromDrive={handleImportFromDrive}
                onPickFromDevice={handleImportFromDevice}
                accept=".xlsx"
            />
        </>
    );
}
