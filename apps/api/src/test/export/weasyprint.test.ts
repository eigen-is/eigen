import { describe, expect, spyOn, test } from 'bun:test';
import { htmlToPdf, isWeasyPrintAvailable } from '../../lib/export/weasyprint';

const wp = await isWeasyPrintAvailable();
const suite = wp ? describe : describe.skip;

suite('htmlToPdf', () => {
    test('a render killed by the timeout is a 504, not a failed render', async () => {
        const realSetTimeout = setTimeout;
        // The 60s deadline fires at once, killing WeasyPrint mid-render.
        const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) =>
            realSetTimeout(fn, 0)) as unknown as typeof setTimeout);
        try {
            await expect(htmlToPdf('<!DOCTYPE html><html><body>x</body></html>')).rejects.toMatchObject({
                status: 504,
            });
        } finally {
            timer.mockRestore();
        }
    });
});
