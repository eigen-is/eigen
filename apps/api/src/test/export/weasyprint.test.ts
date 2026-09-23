import { afterEach, describe, expect, jest, spyOn, test } from 'bun:test';
import { htmlToPdf, isWeasyPrintAvailable } from '../../lib/export/weasyprint';

const wp = await isWeasyPrintAvailable();
const suite = wp ? describe : describe.skip;

const HTML = '<!DOCTYPE html><html><body>x</body></html>';
const DEADLINE = 60_000;

// One macrotask: htmlToPdf has spawned WeasyPrint and armed its deadline.
const rendering = () => new Promise((resolve) => setImmediate(resolve));

suite('htmlToPdf', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    test('a render killed by the timeout is a 504, not a failed render', async () => {
        jest.useFakeTimers();
        const pending = htmlToPdf(HTML);
        await rendering();
        jest.advanceTimersByTime(DEADLINE);
        await expect(pending).rejects.toMatchObject({ status: 504 });
    });

    test('a deadline that fires after a clean exit still returns the PDF', async () => {
        const spawn = spyOn(Bun, 'spawn');
        jest.useFakeTimers();
        try {
            const pending = htmlToPdf(HTML);
            await rendering();
            // The deadline fires the moment WeasyPrint exits 0, before htmlToPdf resumes from its await.
            const spawned = spawn.mock.results.at(-1);
            if (spawned?.type === 'return') spawned.value.exited.then(() => jest.advanceTimersByTime(DEADLINE));
            const pdf = await pending;
            expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
        } finally {
            spawn.mockRestore();
        }
    });
});
