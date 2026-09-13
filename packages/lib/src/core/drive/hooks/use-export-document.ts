import { getDriveExportUrl } from '@workspace/lib/api';
import { useCallback, useState } from 'react';
import { onMutationError } from '../../api-error';
import { downloadBlob, filenameFromDisposition } from '../../download';

export function useExportDocument() {
    const [isExporting, setIsExporting] = useState(false);

    const exportDocument = useCallback(async (ownerId: string, mountId: string, pathId: string, format: string) => {
        setIsExporting(true);
        try {
            const url = getDriveExportUrl(ownerId, mountId, pathId, format);
            const response = await fetch(url, { credentials: 'include' });
            if (!response.ok) {
                const text = await response.text();
                throw new Error(text || `Export failed (${response.status})`);
            }
            const blob = await response.blob();
            const name = filenameFromDisposition(response.headers.get('Content-Disposition'), `export.${format}`);
            downloadBlob(blob, name);
        } catch (e) {
            onMutationError(e);
        } finally {
            setIsExporting(false);
        }
    }, []);

    return { exportDocument, isExporting };
}
