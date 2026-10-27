// What a forward does with each part of the message it forwards: the browser fetches the part from its
// download route and uploads it to the draft's upload route, so it lands as a staged upload exactly like a
// file the user picked, under the part's own name and type.
import { beforeEach, describe, expect, test } from 'bun:test';
import type { DraftAttachmentUpload } from '@workspace/lib/types/mail';
import { getMailAttachmentUrl, getMailDraftAttachmentUploadUrl } from '../../../../core/api';
import { subjectFromMailAttachment } from '../../../../core/file-subject';
import { renderHook } from '../../../render-hook';
import { fetchCalls, installTransferHarness, OWNER, served, toasts, trackingClient } from '../../../transfer-harness';

installTransferHarness();

const staged: DraftAttachmentUpload = {
    tempId: 'temp-1',
    filename: 'invoice.pdf',
    size: 12,
    contentType: 'application/pdf',
};

describe('useAttachMailPart', () => {
    beforeEach(() => {
        toasts.length = 0;
        fetchCalls.length = 0;
        served.importResponse = staged;
    });

    test("a forwarded part is fetched from its download route and uploaded under the part's name and type", async () => {
        const { act } = await import('react');
        const { useAttachMailPart } = await import('../../../../core/mail/hooks/use-draft');
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useAttachMailPart(), queryClient);

        const subject = subjectFromMailAttachment(OWNER, 'm1', 2, {
            filename: 'invoice.pdf',
            contentType: 'application/pdf',
            size: 12,
        });
        let result: DraftAttachmentUpload | undefined;
        await act(async () => {
            result = await latest.mutateAsync(subject);
        });
        await unmount();

        expect(fetchCalls.map((c) => c.url)).toEqual([
            getMailAttachmentUrl(OWNER, 'm1', 2, 'invoice.pdf'),
            getMailDraftAttachmentUploadUrl(OWNER),
        ]);
        const body = fetchCalls[1]!.body;
        if (!(body instanceof FormData)) throw new Error('the upload is not multipart');
        const file = body.get('file');
        if (!(file instanceof File)) throw new Error('the upload carries no file');
        expect(file.name).toBe('invoice.pdf');
        expect(file.type).toBe('application/pdf');
        // The harness answers the download with the staged JSON, so those are the bytes that travel on.
        expect(await file.text()).toBe(JSON.stringify(staged));
        expect(result).toEqual(staged);
        expect(toasts).toEqual([]);
    });

    test('a nameless part travels under the name its chip shows', async () => {
        const { act } = await import('react');
        const { useAttachMailPart } = await import('../../../../core/mail/hooks/use-draft');
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useAttachMailPart(), queryClient);

        await act(async () => {
            await latest.mutateAsync(
                subjectFromMailAttachment(OWNER, 'm1', 0, { filename: undefined, contentType: 'image/png', size: 3 }),
            );
        });
        await unmount();

        const body = fetchCalls[1]!.body;
        if (!(body instanceof FormData)) throw new Error('the upload is not multipart');
        const file = body.get('file');
        if (!(file instanceof File)) throw new Error('the upload carries no file');
        expect(file.name).toBe('attachment-1');
    });

    test('a part the download route refuses is toasted and never uploaded', async () => {
        const { act } = await import('react');
        const { useAttachMailPart } = await import('../../../../core/mail/hooks/use-draft');
        const { queryClient } = trackingClient();
        const { latest, unmount } = await renderHook(() => useAttachMailPart(), queryClient);

        // `preconnect` is carried over from the harness's fetch so the stub satisfies Bun's `typeof fetch`.
        const harnessFetch = globalThis.fetch;
        const refuse = async (url: RequestInfo | URL) => {
            fetchCalls.push({ url: String(url), body: undefined });
            return new Response('Attachment 9 not found', { status: 404 });
        };
        globalThis.fetch = Object.assign(refuse, { preconnect: harnessFetch.preconnect });
        await act(async () => {
            await latest
                .mutateAsync(subjectFromMailAttachment(OWNER, 'm1', 9, { contentType: 'text/plain', size: 1 }))
                .catch(() => null);
        });
        globalThis.fetch = harnessFetch;
        await unmount();

        expect(fetchCalls).toHaveLength(1);
        expect(toasts).toEqual(['error: Attachment 9 not found']);
    });
});
