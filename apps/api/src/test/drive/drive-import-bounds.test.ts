import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { authedRequest, driveGet, drivePost, getTestContext, setMaxUploadSizeMB } from '../setup';

// The raw import route reads its body through the shared bounded reader (the contacts import's seam), so a
// body over the upload ceiling is refused without being buffered: an honest Content-Length loses before a
// byte is read, and a chunked one has its stream cancelled mid-flight.

const MB = 1024 * 1024;

let ctx: Awaited<ReturnType<typeof getTestContext>>;
const mountId = 'default';
let targetId: string;

beforeAll(async () => {
    ctx = await getTestContext();
    const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
    const target = await drivePost<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        `folder/${root.id}/create/doc`,
        { fileName: 'import-bounds-target' },
    );
    targetId = target.id;
});

function importRequest(body: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
    return authedRequest(
        ctx.alice.user.sessionToken,
        `/drive/${ctx.alice.user.id}/${mountId}/file/${targetId}/import`,
        {
            method: 'POST',
            headers,
            body,
        },
    );
}

describe('Drive raw import — body bounds', () => {
    test('a lying Content-Length is 413 before the body is read', async () => {
        // The body is a fragment no importer would accept (a 400 if it ever reached one), so a 413 can only
        // come from the header check that runs first.
        await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 1);
        try {
            const res = await importRequest(new Blob([new Uint8Array(16)]), { 'Content-Length': String(2 * MB) });
            expect(res.status).toBe(413);
        } finally {
            await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 35);
        }
    });

    test('a chunked body over the ceiling is cancelled, not read to the end', async () => {
        const chunk = new Uint8Array(64 * 1024);
        const total = 64; // 4 MB offered against a 1 MB ceiling
        let pulled = 0;
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (pulled === total) {
                    controller.close();
                    return;
                }
                pulled++;
                controller.enqueue(chunk);
            },
            cancel() {
                cancelled = true;
            },
        });

        await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 1);
        try {
            // No Content-Length: the read loop's running total is the only thing standing between the body
            // and the buffer it used to fill.
            const res = await importRequest(body);
            expect(res.status).toBe(413);
            expect(cancelled).toBe(true);
            expect(pulled).toBeLessThan(total);
        } finally {
            await setMaxUploadSizeMB(ctx.alice.user.sessionToken, 35);
        }
    });
});
