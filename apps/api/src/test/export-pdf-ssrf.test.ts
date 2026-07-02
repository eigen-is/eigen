import { describe, expect, test } from 'bun:test';
import { htmlToPdf, isWeasyPrintAvailable } from '../lib/export/weasyprint';

// SSRF regression: a collaborator can inject `url(http://…)` into a schemaless slide/sheet
// color, which lands in CSS the server-side PDF renderer would otherwise fetch (SSRF from
// the API host). All legitimate export resources are embedded as `data:` URIs, so the
// renderer must never reach the network. Skipped where WeasyPrint isn't installed.
const wp = await isWeasyPrintAvailable();
const suite = wp ? describe : describe.skip;

// 1x1 PNG — the only legitimate resource shape exports embed (fonts/images are data: URIs).
const DATA_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

suite('PDF export SSRF', () => {
    test('an injected remote url() does not trigger a network fetch', async () => {
        let connections = 0;
        const server = Bun.listen({
            hostname: '127.0.0.1',
            port: 0,
            socket: {
                open(socket) {
                    connections++;
                    socket.end();
                },
                data() {},
                close() {},
            },
        });
        try {
            const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div style="width:200px;height:100px;background-image:url(http://127.0.0.1:${server.port}/pwn.png)">x</div>
</body></html>`;
            await htmlToPdf(html);
            await Bun.sleep(250); // let any async fetch land before asserting
            expect(connections).toBe(0);
        } finally {
            server.stop(true);
        }
    });

    test('an embedded data: image still renders (legit resources unaffected)', async () => {
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><img src="${DATA_PNG}" style="width:50px;height:50px"></body></html>`;
        const pdf = await htmlToPdf(html);
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    });
});
