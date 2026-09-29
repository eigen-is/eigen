import { describe, expect, spyOn, test } from 'bun:test';
import { htmlToPdf, isWeasyPrintAvailable } from '../../lib/export/weasyprint';

const wp = await isWeasyPrintAvailable();
const suite = wp ? describe : describe.skip;

const HTML = '<!DOCTYPE html><html><body>x</body></html>';

// One macrotask: htmlToPdf has spawned WeasyPrint.
const rendering = () => new Promise((resolve) => setImmediate(resolve));

suite('htmlToPdf', () => {
    test('a render killed by the timeout is a 504, not a failed render', async () => {
        const spawn = spyOn(Bun, 'spawn');
        try {
            const pending = htmlToPdf(HTML);
            await rendering();
            // SIGTERM is what the spawn timeout sends.
            const spawned = spawn.mock.results.at(-1);
            if (spawned?.type === 'return') spawned.value.kill();
            await expect(pending).rejects.toMatchObject({ status: 504 });
        } finally {
            spawn.mockRestore();
        }
    });

    test('a render that finishes returns the PDF', async () => {
        const pdf = await htmlToPdf(HTML);
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    });
});
