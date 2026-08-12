import { XLSX_MIME } from '@workspace/lib/constants/mime';
import type { DrivePath } from '@workspace/lib/types/drive';

import { DocumentImportPicker } from '@workspace/ui/components/layout/drive/document-import-picker';
import { useDocumentExport } from '@workspace/ui/components/layout/drive/use-document-export';
import { FileMenu } from '@workspace/ui/components/layout/toolbar/file-menu';
import { Sheet } from 'lucide-react';
import { useState } from 'react';

type ToolbarLeftProps = {
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    path: DrivePath;
};

export function ToolbarLeftItems({ path, onAccessDialogOpen, canWrite }: ToolbarLeftProps) {
    const { exportPath, exportDialog } = useDocumentExport();
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
                exportFormats={['xlsx', 'pdf', 'html']}
                createLabel="New sheet"
                createIcon={Sheet}
                createType="sheets"
            />
            {exportDialog}
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
