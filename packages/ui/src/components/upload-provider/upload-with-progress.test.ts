import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { uploadWithProgress } from './upload-with-progress';

// The transport has a single outcome channel: the returned promise. A failure rejects exactly
// once (no second onError callback), carrying the server's message so callers can show something
// actionable; success resolves with the response body.

type Scenario =
    | { kind: 'success'; status: number; body: string }
    | { kind: 'http-error'; status: number; body: string }
    | { kind: 'network-error' };

let scenario: Scenario;

class FakeXHR {
    withCredentials = false;
    status = 0;
    statusText = '';
    response = '';
    responseText = '';
    upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
        onprogress: null,
    };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    open(_method: string, _url: string) {}

    send(_body: unknown) {
        queueMicrotask(() => {
            if (scenario.kind === 'network-error') {
                this.onerror?.();
                return;
            }
            this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
            this.status = scenario.status;
            this.response = scenario.body;
            this.responseText = scenario.body;
            this.onload?.();
        });
    }
}

const originalXHR = globalThis.XMLHttpRequest;

beforeEach(() => {
    globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
});

afterEach(() => {
    globalThis.XMLHttpRequest = originalXHR;
});

function upload(onProgress?: (progress: number) => void) {
    return uploadWithProgress({ url: 'https://example.test/upload', formData: new FormData(), onProgress });
}

describe('uploadWithProgress', () => {
    test('a failed HTTP response rejects once, carrying the server message', async () => {
        scenario = { kind: 'http-error', status: 507, body: 'Insufficient Storage' };
        await expect(upload()).rejects.toThrow('Insufficient Storage');
    });

    test('a network failure rejects with a network error', async () => {
        scenario = { kind: 'network-error' };
        await expect(upload()).rejects.toThrow('Network Error');
    });

    test('success resolves with the response body and reports progress', async () => {
        scenario = { kind: 'success', status: 200, body: 'contacts/u1/avatar/a.webp' };
        const seen: number[] = [];
        const body = await upload((progress) => seen.push(progress));
        expect(body).toBe('contacts/u1/avatar/a.webp');
        expect(seen).toEqual([50]);
    });
});
