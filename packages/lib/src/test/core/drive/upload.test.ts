// Every Drive upload is one multipart POST. A refusal carries the server's status and reason to the toast, so the
// user reads "Upload too large (413)" rather than a bare status. The upload reports its progress, a cancel aborts
// the request without a toast, and a batch refreshes its folder once.
import { beforeEach, describe, expect, test } from 'bun:test';
import type { DrivePath } from '../../../types/drive';
import { renderHook } from '../../render-hook';
import { hasKey, installTransferHarness, OWNER, toasts, trackingClient } from '../../transfer-harness';

installTransferHarness();

type ProgressEvent = { lengthComputable: boolean; loaded: number; total: number };

// The request the code under test sent, answered by the test.
class FakeXHR {
    public static sent: FakeXHR[] = [];
    public withCredentials = false;
    public status = 0;
    public responseText = '';
    public url = '';
    public body: FormData | null = null;
    public aborted = false;
    public upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
    public onload: (() => void) | null = null;
    public onerror: (() => void) | null = null;
    public onabort: (() => void) | null = null;
    private contentType = '';

    public open(_method: string, url: string) {
        this.url = url;
    }

    public send(body: FormData) {
        this.body = body;
        FakeXHR.sent.push(this);
    }

    public abort() {
        this.aborted = true;
        this.onabort?.();
    }

    public getResponseHeader(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? this.contentType : null;
    }

    public respond(status: number, body: string, contentType: string) {
        this.status = status;
        this.responseText = body;
        this.contentType = contentType;
        this.onload?.();
    }
}

globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;

const { uploadFiles } = await import('../../../core/drive/upload');
const { useUploadFile, useUploadFiles } = await import('../../../core/drive/hooks/writes');

const FOLDER: DrivePath = {
    id: 'folder',
    name: 'Folder',
    mountId: 'm1',
    type: 'folder',
    parentId: 'root',
    ownerId: OWNER,
    mimeType: 'inode/directory',
    size: 0,
    hash: null,
    thumbnail: null,
    acl: null,
    visibility: 'private',
    sharingRestricted: false,
    details: null,
    trashedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
};

const served = (name: string) => ({ ...FOLDER, id: name, name, type: 'file', parentId: FOLDER.id });
const file = (name: string) => new File(['x'], name);
// A mutation sends a few ticks after it is called, so this waits for the request.
async function sentRequest(): Promise<FakeXHR> {
    for (let tick = 0; tick < 20; tick++) {
        const request = FakeXHR.sent.at(-1);
        if (request) return request;
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error('nothing was sent');
}
const answerOk = async (names: string[]) =>
    (await sentRequest()).respond(200, JSON.stringify(names.map(served)), 'application/json');

beforeEach(() => {
    FakeXHR.sent.length = 0;
    toasts.length = 0;
});

describe('uploadFiles', () => {
    test('posts every file in one request and resolves with the paths, dates revived', async () => {
        const done = uploadFiles(OWNER, 'm1', 'folder', [file('a.txt'), file('b.txt')]);
        await answerOk(['a.txt', 'b.txt']);
        const paths = await done;
        const request = await sentRequest();
        expect(FakeXHR.sent).toHaveLength(1);
        expect(request.url).toEndWith(`/drive/${OWNER}/m1/file/folder`);
        expect(request.withCredentials).toBe(true);
        expect(request.body?.getAll('file')).toHaveLength(2);
        expect(paths.map((path) => path.name)).toEqual(['a.txt', 'b.txt']);
        expect(paths[0].createdAt).toBeInstanceOf(Date);
        expect(paths[0].trashedAt).toBeNull();
    });

    test('a refusal rejects with the status and the text the server gave', async () => {
        const done = uploadFiles(OWNER, 'm1', 'folder', [file('big.bin')]);
        (await sentRequest()).respond(413, 'Upload too large', 'text/plain;charset=utf-8');
        await expect(done).rejects.toMatchObject({ status: 413, message: 'Upload too large' });
    });

    test('a refusal with a JSON body reads its message', async () => {
        const done = uploadFiles(OWNER, 'm1', 'folder', [file('a.txt')]);
        (await sentRequest()).respond(422, JSON.stringify({ message: 'Bad name' }), 'application/json');
        await expect(done).rejects.toMatchObject({ status: 422, message: 'Bad name' });
    });

    test('reports progress in whole percents', async () => {
        const seen: number[] = [];
        const done = uploadFiles(OWNER, 'm1', 'folder', [file('a.txt')], { onProgress: (p) => seen.push(p) });
        (await sentRequest()).upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 3 });
        await answerOk(['a.txt']);
        await done;
        expect(seen).toEqual([33]);
    });

    test('the signal aborts the request and rejects with its reason', async () => {
        const controller = new AbortController();
        const done = uploadFiles(OWNER, 'm1', 'folder', [file('a.txt')], { signal: controller.signal });
        controller.abort();
        await expect(done).rejects.toMatchObject({ name: 'AbortError' });
        expect((await sentRequest()).aborted).toBe(true);
    });

    // A mutation that waits for the network may start after its cancel.
    test('a signal aborted before the start sends nothing', async () => {
        const signal = AbortSignal.abort();
        await expect(uploadFiles(OWNER, 'm1', 'folder', [file('a.txt')], { signal })).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(FakeXHR.sent).toHaveLength(0);
    });
});

async function renderUploads() {
    const { queryClient, invalidated } = trackingClient();
    const { latest, unmount } = await renderHook(
        () => ({ one: useUploadFile(OWNER, 'm1'), many: useUploadFiles() }),
        queryClient,
    );
    return { latest, unmount, invalidated };
}

describe('useUploadFile', () => {
    test('toasts the reason the server gave', async () => {
        const { act } = await import('react');
        const { latest, unmount } = await renderUploads();
        await act(async () => {
            const done = latest.one.mutateAsync({ parentId: 'folder', file: file('big.bin') });
            (await sentRequest()).respond(413, 'Upload too large', 'text/plain');
            await done.catch(() => {});
        });
        await unmount();
        expect(toasts).toEqual(['error: Upload too large (413)']);
    });

    test('resolves with the one path the server made', async () => {
        const { act } = await import('react');
        const { latest, unmount } = await renderUploads();
        let path: DrivePath | undefined;
        await act(async () => {
            const done = latest.one.mutateAsync({ parentId: 'folder', file: file('a.png') });
            await answerOk(['a.png']);
            path = await done;
        });
        await unmount();
        expect(path?.name).toBe('a.png');
    });
});

describe('useUploadFiles', () => {
    const listing = ['drive', OWNER, 'folder', 'm1', 'folder'];

    test('a batch refreshes its folder once', async () => {
        const { act } = await import('react');
        const { latest, unmount, invalidated } = await renderUploads();
        await act(async () => {
            const done = latest.many.mutateAsync({ folder: FOLDER, files: [file('a.txt'), file('b.txt')] });
            await answerOk(['a.txt', 'b.txt']);
            await done;
        });
        await unmount();
        expect(FakeXHR.sent).toHaveLength(1);
        expect(invalidated.filter((key) => hasKey([key], listing))).toHaveLength(1);
    });

    test('a refusal toasts the server reason', async () => {
        const { act } = await import('react');
        const { latest, unmount } = await renderUploads();
        await act(async () => {
            const done = latest.many.mutateAsync({ folder: FOLDER, files: [file('a.txt')] });
            (await sentRequest()).respond(507, 'Insufficient storage', 'text/plain');
            await done.catch(() => {});
        });
        await unmount();
        expect(toasts).toEqual(['error: Insufficient storage (507)']);
    });

    test('a cancelled upload toasts nothing', async () => {
        const { act } = await import('react');
        const { latest, unmount } = await renderUploads();
        const controller = new AbortController();
        await act(async () => {
            const done = latest.many.mutateAsync({ folder: FOLDER, files: [file('a.txt')], signal: controller.signal });
            await sentRequest();
            controller.abort();
            await done.catch(() => {});
        });
        await unmount();
        expect(toasts).toEqual([]);
    });
});
