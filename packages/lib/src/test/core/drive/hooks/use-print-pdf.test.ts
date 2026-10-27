// File → Print in Docs prints the server's PDF from a tab of its own. A popup blocker allows that tab only inside the
// click or key press, so it must open before the first await; every way the PDF can't be had falls back to browser
// print, says what is left out, and leaves no empty tab behind.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EXPORT_SUMMARY_HEADER } from '../../../../types/drive';
import { installHappyDom } from '../../../happy-dom';

installHappyDom();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;

const toasts: string[] = [];
const realSonnerModule = await import('sonner');
mock.module('sonner', () => ({
    toast: {
        info: (message: string) => toasts.push(`info: ${message}`),
        error: (message: string) => toasts.push(`error: ${message}`),
    },
}));

const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
const revoked: string[] = [];
URL.createObjectURL = () => 'blob:http://localhost:3000/pdf';
URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
};

afterAll(() => {
    mock.module('sonner', () => realSonnerModule);
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevokeObjectURL;
});

type FakeTab = { closed: boolean; close: () => void; location: { href: string } };

// Every call, in order, so a test can tell the tab opened before the request went out.
let calls: string[] = [];
let tab: FakeTab | null = null;
let answer: () => Promise<Response> = async () => new Response('');
let fallbacks = 0;
const fallback = () => {
    fallbacks++;
};

beforeEach(() => {
    calls = [];
    toasts.length = 0;
    revoked.length = 0;
    fallbacks = 0;
    tab = {
        closed: false,
        close() {
            this.closed = true;
        },
        location: { href: '' },
    };
    g.window.open = (url: string, target: string) => {
        calls.push(`open ${url} ${target}`);
        return tab;
    };
    g.fetch = (url: string, init?: RequestInit) => {
        calls.push(`fetch ${url} ${init?.credentials}`);
        return answer();
    };
});

async function renderPrint() {
    const { QueryClient } = await import('@tanstack/react-query');
    const { renderHook } = await import('../../../render-hook');
    const { usePrintPdf } = await import('../../../../core/drive/hooks/use-print-pdf');
    return renderHook(() => usePrintPdf(fallback), new QueryClient());
}

describe('usePrintPdf', () => {
    test('opens the tab before the request, then shows the PDF in it', async () => {
        let resolve: (response: Response) => void = () => {};
        answer = () =>
            new Promise((r) => {
                resolve = r;
            });
        const { latest, unmount } = await renderPrint();

        const printing = latest.printPdf('owner', 'mount', 'path', true);
        const { getDriveExportUrl } = await import('../../../../core/api');
        expect(calls).toEqual(['open  _blank', `fetch ${getDriveExportUrl('owner', 'mount', 'path', 'pdf')} include`]);
        expect(tab?.location.href).toBe('');

        resolve(new Response('%PDF-1.7', { headers: { 'Content-Type': 'application/pdf' } }));
        await printing;
        await unmount();

        expect(tab?.location.href).toBe('blob:http://localhost:3000/pdf');
        expect(fallbacks).toBe(0);
        expect(toasts).toEqual([]);
    });

    test('says what the PDF left out once it shows in its tab', async () => {
        const summary = '1 header or footer was cut to fit.';
        answer = async () =>
            new Response('%PDF-1.7', { headers: { [EXPORT_SUMMARY_HEADER]: encodeURIComponent(summary) } });
        const { latest, unmount } = await renderPrint();

        await latest.printPdf('owner', 'mount', 'path', true);
        await unmount();

        expect(tab?.location.href).toBe('blob:http://localhost:3000/pdf');
        expect(fallbacks).toBe(0);
        expect(toasts).toEqual([`info: ${summary}`]);
    });

    test('keeps the blob URL while the tab is open and revokes it once the tab closes', async () => {
        answer = async () => new Response('%PDF-1.7');
        const { latest, unmount } = await renderPrint();

        await latest.printPdf('owner', 'mount', 'path', true);
        await new Promise((r) => setTimeout(r, 1100));
        expect(revoked).toEqual([]);

        tab?.close();
        await new Promise((r) => setTimeout(r, 1100));
        await unmount();

        expect(revoked).toEqual(['blob:http://localhost:3000/pdf']);
    });

    test('a failed PDF closes the tab and falls back to browser print with a toast', async () => {
        answer = async () => new Response('WeasyPrint 68 or later is not installed', { status: 501 });
        const { latest, unmount } = await renderPrint();

        await latest.printPdf('owner', 'mount', 'path', true);
        await unmount();

        expect(tab?.closed).toBe(true);
        expect(fallbacks).toBe(1);
        expect(toasts).toEqual([
            'info: Printing without headers and footers. The PDF failed: WeasyPrint 68 or later is not installed (501)',
        ]);
    });

    test('a request that never reaches the server falls back too', async () => {
        answer = () => Promise.reject(new TypeError('Failed to fetch'));
        const { latest, unmount } = await renderPrint();

        await latest.printPdf('owner', 'mount', 'path', true);
        await unmount();

        expect(tab?.closed).toBe(true);
        expect(fallbacks).toBe(1);
        expect(toasts).toEqual(['info: Printing without headers and footers. The PDF failed: Failed to fetch']);
    });

    test('offline or with unsynced edits it prints in the browser and opens no tab', async () => {
        const { latest, unmount } = await renderPrint();

        await latest.printPdf('owner', 'mount', 'path', false);
        await unmount();

        expect(calls).toEqual([]);
        expect(fallbacks).toBe(1);
        expect(toasts).toEqual([
            'info: Printing without headers and footers. Your latest edits have not reached the server yet.',
        ]);
    });

    test('a blocked tab prints in the browser and sends no request', async () => {
        tab = null;
        const { latest, unmount } = await renderPrint();

        await latest.printPdf('owner', 'mount', 'path', true);
        await unmount();

        expect(calls).toEqual(['open  _blank']);
        expect(fallbacks).toBe(1);
        expect(toasts).toEqual([
            'info: Printing without headers and footers. The browser blocked the tab for the PDF.',
        ]);
    });
});
