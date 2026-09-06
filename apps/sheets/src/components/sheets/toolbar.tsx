import { XLSX_MIME } from '@workspace/lib/constants/mime';
import type { DrivePath } from '@workspace/lib/types/drive';
import { FileMenu } from '@workspace/ui';
import { DocumentImportPicker } from '@workspace/ui/components/drive/document-import-picker';
import { ExportProgressDialog, useDocumentExport } from '@workspace/ui/components/drive/use-document-export';
import { Sheet } from 'lucide-react';
import { useState } from 'react';

type ToolbarLeftProps = {
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    path: DrivePath;
};

export function ToolbarLeftItems({ path, onAccessDialogOpen, canWrite }: ToolbarLeftProps) {
    const { exportPath, isExporting } = useDocumentExport();
    const [importPickerOpen, setImportPickerOpen] = useState(false);

    return (
        <>
            <FileMenu
                path={path}
                canWrite={canWrite}
                onAccessDialogOpen={onAccessDialogOpen}
                onImport={() => setImportPickerOpen(true)}
                importLabel="Import xlsx file…"
                onExport={(format) => exportPath(path, format)}
                createLabel="New sheet"
                createIcon={Sheet}
                createType="sheets"
            />
            <ExportProgressDialog open={isExporting} />
            <DocumentImportPicker
                path={path}
                open={importPickerOpen}
                onOpenChange={setImportPickerOpen}
                title="Import xlsx file"
                mime={XLSX_MIME}
                accept=".xlsx"
            />
        </>
    );
}
