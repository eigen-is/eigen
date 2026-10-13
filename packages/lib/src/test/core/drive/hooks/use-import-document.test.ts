// What a pptx left out reaches the user as one toast, from the hook that ran the Convert or the Import, whichever way
// the file came in; an import that lost nothing says nothing.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ConvertResult, DrivePath, ImportResult } from '@workspace/lib/types/drive';
import { renderHook } from '../../../render-hook';
import { installTransferHarness, OWNER, served, toasts, trackingClient } from '../../../transfer-harness';

installTransferHarness();

const SUMMARY = '1 table was not imported.';

// The Eden client, stubbed to the one call a convert makes.
let convertResult: ConvertResult | null = null;
const realApiModule = await import('../../../../core/api');
mock.module('../../../../core/api', () => ({
    ...realApiModule,
    driveApi: () => () => ({
        file: () => ({ convert: () => ({ post: async () => ({ data: convertResult, error: null, status: 200 }) }) }),
    }),
}));

afterAll(() => {
    mock.module('../../../../core/api', () => realApiModule);
});

async function importFrom(source: 'device' | 'drive', result: ImportResult): Promise<string[]> {
    const { act } = await import('react');
    const { useImportDocument, useImportFromDrive } = await import('../../../../core/drive/hooks/use-import-document');
    served.importResponse = result;
    const { queryClient } = trackingClient();
    const { latest, unmount } = await renderHook(
        () => ({ device: useImportDocument(OWNER, 'm1'), drive: useImportFromDrive(OWNER, 'm1') }),
        queryClient,
    );
    await act(async () => {
        if (source === 'device') await latest.device.mutateAsync({ pathId: 'deck', file: new File(['x'], 'a.pptx') });
        else
            await latest.drive.mutateAsync({
                pathId: 'deck',
                sourceOwnerId: OWNER,
                sourceMountId: 'm1',
                sourcePathId: 'pptx',
            });
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
});

describe('Convert to Slides', () => {
    beforeEach(() => {
        toasts.length = 0;
    });

    test('toasts the summary of the deck it made', async () => {
        const { act } = await import('react');
        const { useConvertDocument } = await import('../../../../core/drive/hooks/use-convert-document');
        convertResult = { path: { id: 'deck' } as DrivePath, summary: SUMMARY };
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useConvertDocument(), queryClient);
        await act(async () => {
            await latest.mutateAsync({
                ownerId: OWNER,
                mountId: 'm1',
                pathId: 'pptx',
                parentId: 'root',
                targetType: 'eigenslides',
            });
        });
        await unmount();
        expect(toasts).toEqual([`info: ${SUMMARY}`]);
    });
});
