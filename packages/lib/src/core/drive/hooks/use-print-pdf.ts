// File › Print from the server's PDF, which Docs' print menu calls. The PDF opens in a tab of its own to print from,
// and when it can't be had the editor falls back to browser print and says what that leaves out.

import { getDriveExportUrl } from '@workspace/lib/api';
import { useCallback } from 'react';
import { toast } from 'sonner';
import { AppError, getErrorMessage } from '../../api-error';
import { toastExportSummary } from './use-export-document';

// A tab that navigated away runs no listener of ours, so its closing is polled. The blob URL lives until then,
// so a reload of the tab still finds the PDF.
const TAB_CLOSED_POLL_MS = 1000;

function printWithoutBands(fallback: () => void, reason: string): void {
    toast.info(`Printing without headers and footers. ${reason}`);
    fallback();
}

// Print as Google prints: the server's PDF, which draws the headers, footers and page numbers browser print leaves
// out, in a tab of its own to print from. A popup blocker allows the tab only inside the click or key press, so it
// opens before the first await. `fallback` is browser print, for a tab whose edits the server may not have, a
// blocked tab or a PDF that fails. A PDF that left something out says so, as a download does.
export function usePrintPdf(fallback: () => void): {
    printPdf: (ownerId: string, mountId: string, pathId: string, canUsePdf: boolean) => Promise<void>;
} {
    const printPdf = useCallback(
        async (ownerId: string, mountId: string, pathId: string, canUsePdf: boolean) => {
            if (!canUsePdf) return printWithoutBands(fallback, 'Your latest edits have not reached the server yet.');
            const tab = window.open('', '_blank');
            if (!tab) return printWithoutBands(fallback, 'The browser blocked the tab for the PDF.');
            try {
                const response = await fetch(getDriveExportUrl(ownerId, mountId, pathId, 'pdf'), {
                    credentials: 'include',
                });
                if (!response.ok) {
                    const value = await response.text();
                    throw new AppError({ error: { status: response.status, value }, status: response.status });
                }
                const blob = await response.blob();
                if (tab.closed) return;
                const url = URL.createObjectURL(blob);
                tab.location.href = url;
                toastExportSummary(response.headers);
                const poll = setInterval(() => {
                    if (!tab.closed) return;
                    clearInterval(poll);
                    URL.revokeObjectURL(url);
                }, TAB_CLOSED_POLL_MS);
            } catch (error) {
                tab.close();
                printWithoutBands(fallback, `The PDF failed: ${getErrorMessage(error)}`);
            }
        },
        [fallback],
    );

    return { printPdf };
}
