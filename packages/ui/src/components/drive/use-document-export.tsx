import { useExportDocument } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { useCallback } from 'react';
import { ProgressDialog } from './progress-dialog';

// The export wiring every document surface repeats: the useExportDocument hook and the
// path -> export call. exportPath takes the acted-on DrivePath — single-document toolbars
// bind their one path, the drive list passes the item chosen at call time.
export function useDocumentExport() {
    const { exportDocument, isExporting } = useExportDocument();

    const exportPath = useCallback(
        (path: DrivePath, format: string) => exportDocument(path.ownerId, path.mountId, path.id, format),
        [exportDocument],
    );

    return { exportPath, isExporting };
}

// The blocking progress dialog every export surface shows, with its single-sourced title.
export function ExportProgressDialog({ open }: { open: boolean }) {
    return <ProgressDialog open={open} title="Exporting document" />;
}
