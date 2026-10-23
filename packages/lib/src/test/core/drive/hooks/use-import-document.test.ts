// What a pptx left out reaches the user as one toast from the import hook, whichever way the file came in; an import
// that lost nothing says nothing.
import { beforeEach, describe, expect, test } from 'bun:test';
import type { DocumentImportOptions, ImportResult } from '@workspace/lib/types/drive';
import { renderHook } from '../../../render-hook';
import { fetchCalls, installTransferHarness, OWNER, served, toasts, trackingClient } from '../../../transfer-harness';

installTransferHarness();

const SUMMARY = '1 table was not imported.';
const INSERT: DocumentImportOptions = { mode: 'insert', afterFrameId: 'fr 1' };

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
                ? latest.device.mutateAsync({ pathId: 'deck', file: new File(['x'], 'a.pptx'), options: INSERT })
                : latest.drive.mutateAsync({
                      pathId: 'deck',
                      sourceOwnerId: OWNER,
                      sourceMountId: 'm1',
                      sourcePathId: 'pptx',
                      options: INSERT,
                  });
        await done.catch(() => {});
    });
    await unmount();
    return [...toasts];
}

describe('Import… of a pptx', () => {
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

describe('the import mode', () => {
    test('rides in the query of an upload, whose body is the file', async () => {
        fetchCalls.length = 0;
        await importFrom('device', { success: true, summary: null });
        expect(fetchCalls[0]?.url).toEndWith('/file/deck/import?mode=insert&afterFrameId=fr%201');
    });

    test('rides in the body of a Drive pick, beside its source', async () => {
        fetchCalls.length = 0;
        await importFrom('drive', { success: true, summary: null });
        expect(JSON.parse(String(fetchCalls[0]?.body))).toEqual({
            sourceOwnerId: OWNER,
            sourceMountId: 'm1',
            sourcePathId: 'pptx',
            mode: 'insert',
            afterFrameId: 'fr 1',
        });
    });
});
