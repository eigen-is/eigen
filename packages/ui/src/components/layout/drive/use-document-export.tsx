import { useExportDocument } from '@workspace/lib/drive';
import type { DrivePath } from '@workspace/lib/types/drive';
import { useCallback } from 'react';
import { ProgressDialog } from './progress-dialog';

// The export triple every document surface repeats: the useExportDocument hook, the
// path -> export call, and the blocking progress dialog (title included). exportPath
// takes the acted-on DrivePath — single-document toolbars bind their one path, the
// drive list passes the item chosen at call time.
export function useDocumentExport() {
    const { exportDocument, isExporting } = useExportDocument();

    const exportPath = useCallback(
        (path: DrivePath, format: string) => exportDocument(path.ownerId, path.mountId, path.id, format),
        [exportDocument],
    );

    const exportDialog = <ProgressDialog open={isExporting} title="Exporting document" />;

    return { exportPath, exportDialog };
}
