// The host's end of the workbook's bar: the File menu, with the export progress and the import picker it opens. The
// Workbook renders it inside its bar, so the File menu hands the focus back to the cell editor as its own menus do.

import type { DrivePath } from '@workspace/lib/types/drive';
import { useCellEditorRefocus } from '@workspace/sheet';
import { DocumentImportPicker, ExportProgressDialog, useDocumentExport } from '@workspace/ui/components/drive';
import { FileMenu } from '@workspace/ui/components/layout/toolbar';
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
    const refocusCellEditor = useCellEditorRefocus();

    return (
        <>
            <FileMenu
                path={path}
                canWrite={canWrite}
                onAccessDialogOpen={onAccessDialogOpen}
                onImport={() => setImportPickerOpen(true)}
                onExport={(format) => exportPath(path, format)}
                createLabel="New sheet"
                createIcon={Sheet}
                createType="sheets"
                onCloseAutoFocus={refocusCellEditor}
            />
            <ExportProgressDialog open={isExporting} />
            <DocumentImportPicker
                path={path}
                open={importPickerOpen}
                onOpenChange={setImportPickerOpen}
                target="eigensheets"
            />
        </>
    );
}
