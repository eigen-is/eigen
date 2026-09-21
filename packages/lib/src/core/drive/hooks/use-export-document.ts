import { getDriveExportUrl } from '@workspace/lib/api';
import { useCallback } from 'react';
import { useFileDownload } from '../../download';

export function useExportDocument() {
    const { download, isDownloading } = useFileDownload();

    const exportDocument = useCallback(
        (ownerId: string, mountId: string, pathId: string, format: string) =>
            download(getDriveExportUrl(ownerId, mountId, pathId, format), `export.${format}`),
        [download],
    );

    return { exportDocument, isExporting: isDownloading };
}
