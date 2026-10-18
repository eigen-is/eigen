// What a pptx left out reaches the user as one toast from the import hook, whichever way the file came in; an import
// that lost nothing says nothing.
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ImportResult } from '@workspace/lib/types/drive';
import { renderHook } from '../../../render-hook';
import { installTransferHarness, OWNER, served, toasts, trackingClient } from '../../../transfer-harness';

installTransferHarness();

const SUMMARY = '1 table was not imported.';

async function importFrom(source: 'device' | 'drive', result: ImportResult | { summary: unknown }): Promise<string[]> {
    const { act } = await import('react');
    const { useImportDocument, useImportFromDrive } = await import('../../../../core/drive/hooks/use-import-document');
    served.importResponse = result;
    const { queryClient } = trackingClient();
    const { latest, unmount } = await renderHook(
        () => ({ device: useImportDocument(OWNER, 'm1'), drive: useImportFromDrive(OWNER, 'm1') }),
        queryClient,
    );
    await act(async () => {
        // A failed mutation has toasted its error by the time it rejects, which is what a test reads.
        const done =
            source === 'device'
                ? latest.device.mutateAsync({ pathId: 'deck', file: new File(['x'], 'a.pptx') })
                : latest.drive.mutateAsync({
                      pathId: 'deck',
                      sourceOwnerId: OWNER,
                      sourceMountId: 'm1',
                      sourcePathId: 'pptx',
                  });
        await done.catch(() => {});
    });
    await unmount();
    return [...toasts];
}

describe('Import slides…', () => {
    beforeEach(() => {
        toasts.length = 0;
    });

    test('a file from the device toasts its summary', async () => {
        expect(await importFrom('device', { success: true, summary: SUMMARY })).toEqual([`info: ${SUMMARY}`]);
    });

    test('a file from Drive toasts its summary', async () => {
        expect(await importFrom('drive', { success: true, summary: SUMMARY })).toEqual([`info: ${SUMMARY}`]);
    });

    test('an import that lost nothing toasts nothing', async () => {
        expect(await importFrom('device', { success: true, summary: null })).toEqual([]);
    });

    test('a body that is no import result is an error, never a summary', async () => {
        expect(await importFrom('device', { success: true, summary: 3 })).toEqual([
            'error: Unexpected response from the import',
        ]);
    });
});
