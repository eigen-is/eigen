import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getHome } from '../../lib/home';
import { collectStickiesText, extractText } from '../../lib/search/extract-text';
import { CONTENT_INDEX_MAX_BYTES } from '../../lib/search/limits';
import { driveGet, driveUpload, getTestContext } from '../setup';

// The main-thread half of search extraction — stickies, chat and plain files are light
// reads. The three collab types extract in the Worker (extract-render.test.ts).

describe('content collectors', () => {
    test('collectStickiesText pulls card titles + descriptions + column titles', () => {
        const content = {
            tasks: [{ title: 'Fix bug', description: 'in the parser' }],
            columns: [{ title: 'In Progress' }],
        };
        const text = collectStickiesText(content, CONTENT_INDEX_MAX_BYTES);
        expect(text).toContain('Fix bug');
        expect(text).toContain('in the parser');
        expect(text).toContain('In Progress');
    });
});

describe('extraction dispatch', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        mountId = mounts![0].id;
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
    });

    async function resolve(pathId: string) {
        const home = await getHome(ctx.alice.user.id);
        return home.drive.resolveFile(mountId, pathId);
    }

    // mimeType is caller-controlled on upload, so the container TYPE decides the branch: a plain
    // file claiming an eigen mime has no data.db, and must be skipped rather than handed to a
    // transform that can only ever fail (and leave the row dirty for every later drain).
    test('a plain file wearing an eigen mime is skipped, not sent to the collab loader', async () => {
        const uploaded = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            new File(['zaphod beeblebrox'], 'spoof-extract.txt', { type: 'application/eigenvector' }),
        );
        expect(uploaded.type).toBe('file');

        const { mount, path } = await resolve(uploaded.id);
        expect(await extractText(mount, path)).toBe('');
    });

    test('a plain text file still reads its own bytes', async () => {
        const uploaded = await driveUpload<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            rootId,
            new File(['ford prefect'], 'plain-extract.txt', { type: 'text/plain' }),
        );

        const { mount, path } = await resolve(uploaded.id);
        expect(await extractText(mount, path)).toBe('ford prefect');
    });
});
