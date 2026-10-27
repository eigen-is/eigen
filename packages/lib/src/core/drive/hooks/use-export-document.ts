// Download a document from the export route, as a docx, pdf or another format its type offers, and then say what the
// file left out, which the route sends in a header beside the bytes. Every document's Download menu and the Drive
// item menu export through this hook; Print reads the same header.

import { getDriveExportUrl } from '@workspace/lib/api';
import { EXPORT_SUMMARY_HEADER } from '@workspace/lib/types/drive';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { useFileDownload } from '../../download';

// "2 charts were left out of the file.", toasted once the file is saved; a file that lost nothing says nothing.
export function toastExportSummary(headers: Headers): void {
    const summary = headers.get(EXPORT_SUMMARY_HEADER);
    if (summary) toast.info(decodeURIComponent(summary));
}

export function useExportDocument() {
    const { download, isDownloading } = useFileDownload();

    const exportDocument = useCallback(
        async (ownerId: string, mountId: string, pathId: string, format: string) => {
            const headers = await download(getDriveExportUrl(ownerId, mountId, pathId, format), `export.${format}`);
            if (headers) toastExportSummary(headers);
        },
        [download],
    );

    return { exportDocument, isExporting: isDownloading };
}
