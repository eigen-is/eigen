// Drive's Upload files: files chosen in the picker or dropped on the list go up as one request with one row in the
// upload provider, a render never sends them again, a refusal toasts the server's reason, and the row's cancel
// aborts the request without a toast.
import { beforeEach, expect, mock, test } from 'bun:test';
import { DRIVE_MIME_FOLDER } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const toasts: string[] = [];
const realSonner = { ...(await import('sonner')) };
mock.module('sonner', () => ({
    ...realSonner,
    toast: { ...realSonner.toast, error: (message: string) => toasts.push(message) },
}));

class FakeXHR {
    public static sent: FakeXHR[] = [];
    public withCredentials = false;
    public status = 0;
    public responseText = '';
    public body: FormData | null = null;
    public aborted = false;
    public upload: { onprogress: (() => void) | null } = { onprogress: null };
    public onload: (() => void) | null = null;
    public onerror: (() => void) | null = null;
    public onabort: (() => void) | null = null;

    public open() {}

    public send(body: FormData) {
        this.body = body;
        FakeXHR.sent.push(this);
    }

    public abort() {
        this.aborted = true;
        this.onabort?.();
    }

    public getResponseHeader(): string {
        return 'text/plain';
    }

    public respond(status: number, body: string) {
        this.status = status;
        this.responseText = body;
        this.onload?.();
    }
}

globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;

const { act, createElement } = await import('react');
const { UploadProvider } = await import('../../../components/upload-provider/upload-provider');
const { useDriveUploadFiles } = await import('../../../components/drive/use-drive-upload-files');

const folder = drivePath({ id: 'folder', name: 'Folder', type: 'folder', mimeType: DRIVE_MIME_FOLDER });
const files = [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')];

beforeEach(() => {
    FakeXHR.sent.length = 0;
    toasts.length = 0;
});

async function renderUpload() {
    const seen: { upload: (files: File[]) => void } = { upload: () => {} };
    function Probe() {
        const { upload, input } = useDriveUploadFiles(folder);
        seen.upload = upload;
        return input;
    }
    const { container } = await renderInDocument(createElement(UploadProvider, null, createElement(Probe)));
    const input = container.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error('no file input');
    const choose = async (chosen: File[]) => {
        Object.defineProperty(input, 'files', { configurable: true, value: chosen });
        await act(async () => {
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    };
    // The mutation sends a few ticks after it starts.
    const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    return { container, choose, settle, seen };
}

test('choosing files sends them in one upload', async () => {
    const { choose, settle } = await renderUpload();
    await choose(files);
    await settle();
    expect(FakeXHR.sent.map((request) => request.body?.getAll('file').length)).toEqual([2]);
});

test('dropped files go up once, however often the host renders', async () => {
    const { container, seen, settle } = await renderUpload();
    await act(async () => seen.upload(files));
    await settle();
    await settle();
    expect(FakeXHR.sent).toHaveLength(1);
    expect(container.ownerDocument.body.textContent).toContain('Uploading multiple files');
});

test('a refusal toasts the reason the server gave', async () => {
    const { choose, settle } = await renderUpload();
    await choose([files[0]]);
    await settle();
    await act(async () => FakeXHR.sent[0].respond(413, 'Upload too large'));
    await settle();
    expect(toasts).toEqual(['Upload too large (413)']);
});

test('cancel aborts the upload and shows no error', async () => {
    const { container, choose, settle } = await renderUpload();
    await choose([files[0]]);
    await settle();
    const cancel = [...container.ownerDocument.querySelectorAll('button')].find(
        (button) => button.textContent === 'Cancel',
    );
    if (!cancel) throw new Error('no cancel button');
    await act(async () => {
        cancel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
    expect(FakeXHR.sent[0].aborted).toBe(true);
    expect(toasts).toEqual([]);
    expect(container.ownerDocument.body.textContent).not.toContain('Uploading a.txt');
});
