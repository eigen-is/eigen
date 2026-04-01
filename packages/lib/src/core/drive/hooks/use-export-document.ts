import { getDriveExportUrl } from '@workspace/lib/api';
import { useCallback, useState } from 'react';
import { onMutationError } from '../../api-error';

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
            const disposition = response.headers.get('Content-Disposition');
            const match = disposition?.match(/filename\*?="?([^";]+)"?/);
            const fileName = match ? decodeURIComponent(match[1]) : `export.${format}`;

            const objectUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objectUrl;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(objectUrl);
        } catch (e) {
            onMutationError(e);
        } finally {
            setIsExporting(false);
        }
    }, []);

    return { exportDocument, isExporting };
}
