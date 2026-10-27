// A download from the export route saves the file, then says what the file left out, which the route sends in a header
// beside the bytes; a file that lost nothing says nothing, and a failed download toasts only its error.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EXPORT_SUMMARY_HEADER } from '../../../../types/drive';
import { installHappyDom } from '../../../happy-dom';

installHappyDom();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

// The saves and the toasts in one list, so a test can tell the toast came after the save.
const events: string[] = [];
const realSonnerModule = await import('sonner');
mock.module('sonner', () => ({
    toast: {
        info: (message: string) => events.push(`info: ${message}`),
        error: (message: string) => events.push(`error: ${message}`),
    },
}));

const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
URL.createObjectURL = () => {
    events.push('save');
    return 'blob:http://localhost:3000/export';
};
URL.revokeObjectURL = () => {};

afterAll(() => {
    mock.module('sonner', () => realSonnerModule);
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevokeObjectURL;
});

let answer: () => Response = () => new Response('');

beforeEach(() => {
    events.length = 0;
    g.fetch = async () => answer();
});

async function exportPptx(): Promise<string[]> {
    const { QueryClient } = await import('@tanstack/react-query');
    const { renderHook } = await import('../../../render-hook');
    const { useExportDocument } = await import('../../../../core/drive/hooks/use-export-document');
    const { latest, unmount } = await renderHook(() => useExportDocument(), new QueryClient());
    await latest.exportDocument('owner', 'mount', 'deck', 'pptx');
    await unmount();
    return [...events];
}

describe('useExportDocument', () => {
    test("toasts the file's summary after it saves the file", async () => {
        const summary = "1 part of the document couldn't be read and is missing; 2 fills were simplified.";
        answer = () => new Response('PK', { headers: { [EXPORT_SUMMARY_HEADER]: encodeURIComponent(summary) } });

        expect(await exportPptx()).toEqual(['save', `info: ${summary}`]);
    });

    test('a file that lost nothing toasts nothing', async () => {
        answer = () => new Response('PK');

        expect(await exportPptx()).toEqual(['save']);
    });

    test('a failed export toasts its error and no summary', async () => {
        answer = () => new Response('Server is busy', { status: 503, headers: { [EXPORT_SUMMARY_HEADER]: 'unused' } });

        expect(await exportPptx()).toEqual(['error: Server is busy']);
    });
});
