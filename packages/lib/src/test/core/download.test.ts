// The name a download saves under comes from the response's Content-Disposition (RFC 6266), which
// useFileDownload reads off the anchor it clicks.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { installHappyDom } from '../happy-dom';
import { renderHook } from '../render-hook';

const window = installHappyDom();

const { useFileDownload } = await import('../../core/download');

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

async function savedName(header: string | null, fallback: string): Promise<string> {
    const headers = new Headers(header ? [['Content-Disposition', header]] : []);
    globalThis.fetch = Object.assign(async () => new Response('x', { headers }), { preconnect: realFetch.preconnect });
    const names: string[] = [];
    const click = spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: {
        download: string;
    }) {
        names.push(this.download);
    });
    const { latest, unmount } = await renderHook(() => useFileDownload(), new QueryClient());
    const { act } = await import('react');
    await act(async () => {
        await latest.download('/download', fallback);
    });
    await unmount();
    click.mockRestore();
    return names[0] ?? '';
}

describe('useFileDownload', () => {
    test('reads a quoted plain filename, spaces and all', async () => {
        expect(await savedName('attachment; filename="a b.vcf"', 'fallback.vcf')).toBe('a b.vcf');
    });

    test('reads an unquoted plain filename', async () => {
        expect(await savedName('attachment; filename=contacts.vcf', 'fallback.vcf')).toBe('contacts.vcf');
    });

    test('decodes the RFC 5987 filename*', async () => {
        expect(await savedName("attachment; filename*=UTF-8''a%20b.vcf", 'fallback.vcf')).toBe('a b.vcf');
    });

    test('filename* wins over the ASCII-mangled plain filename the server sends beside it', async () => {
        const header = `attachment; filename="Rapport_2024.pdf"; filename*=UTF-8''${encodeURIComponent('Rapporté 2024.pdf')}`;

        expect(await savedName(header, 'export.pdf')).toBe('Rapporté 2024.pdf');
    });

    test('a missing header falls back', async () => {
        expect(await savedName(null, 'contacts.vcf')).toBe('contacts.vcf');
    });

    test('a header without a filename parameter falls back', async () => {
        expect(await savedName('attachment', 'contacts.vcf')).toBe('contacts.vcf');
    });
});
