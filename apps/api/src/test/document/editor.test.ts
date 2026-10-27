import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { DrivePath, EditorSaveResult, FileEditorContent } from '@workspace/lib/types/drive';
import { DRIVE_MIME_DOC } from '@workspace/lib/types/drive';
import { MAX_INLINE_EDIT_SIZE } from '../../lib/drive/inline-edit';
import { getHome } from '../../lib/home';
import { authedRequest, driveGet, drivePut, driveUpload, getTestContext } from '../setup';

describe('Editor', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = 'default';
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
    });

    async function uploadTextFile(name: string, content: string, mimeType = 'text/plain') {
        const file = new File([content], name, { type: mimeType });
        return driveUpload<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, rootId, file);
    }

    async function editorGet(pathId: string): Promise<{ status: number; data: FileEditorContent }> {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/editor/${ctx.alice.user.id}/${mountId}/${pathId}/content`,
        );
        return { status: res.status, data: await res.json() };
    }

    async function editorPut(
        pathId: string,
        body: Record<string, unknown>,
        token = ctx.alice.user.sessionToken,
    ): Promise<{ status: number; data: EditorSaveResult | null }> {
        const res = await authedRequest(token, `/editor/${ctx.alice.user.id}/${mountId}/${pathId}/content`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        // Error responses (413/507) return a plain-text ApiError message, not JSON — tolerate that.
        return { status: res.status, data: await res.json().catch(() => null) };
    }

    describe('GET content', () => {
        test('returns markdown editMode for .md files', async () => {
            const uploaded = await uploadTextFile('test.md', '# Hello\n\nWorld', 'text/markdown');
            const { status, data } = await editorGet(uploaded.id);
            expect(status).toBe(200);
            expect(data.editMode).toBe('markdown');
            expect(data.content).toBe('# Hello\n\nWorld');
            expect(data.frontmatter).toBeNull();
        });

        test('extracts frontmatter from markdown', async () => {
            const content = '---\ntitle: Test\nauthor: Alice\n---\n# Hello';
            const uploaded = await uploadTextFile('frontmatter.md', content, 'text/markdown');
            const { data } = await editorGet(uploaded.id);
            expect(data.editMode).toBe('markdown');
            expect(data.frontmatter).toBe('title: Test\nauthor: Alice');
            expect(data.content).toBe('# Hello');
        });

        test('returns code editMode for .json files', async () => {
            const uploaded = await uploadTextFile('config.json', '{"key": "value"}', 'application/json');
            const { data } = await editorGet(uploaded.id);
            expect(data.editMode).toBe('code');
            expect(data.content).toBe('{"key": "value"}');
        });

        test('returns code editMode for .ts files', async () => {
            const uploaded = await uploadTextFile('app.ts', 'const x: number = 1;', 'text/typescript');
            const { data } = await editorGet(uploaded.id);
            expect(data.editMode).toBe('code');
        });

        test('returns code editMode for .sh files', async () => {
            const uploaded = await uploadTextFile('run.sh', '#!/bin/bash\necho hello', 'text/x-shellscript');
            const { data } = await editorGet(uploaded.id);
            expect(data.editMode).toBe('code');
        });

        test('returns plaintext editMode for .txt files', async () => {
            const uploaded = await uploadTextFile('notes.txt', 'Some notes');
            const { data } = await editorGet(uploaded.id);
            expect(data.editMode).toBe('plaintext');
        });

        test('a loose file under an Eigen mime edits by its name, frontmatter split off', async () => {
            const uploaded = await uploadTextFile('loose.md', '---\ntitle: Loose\n---\n# Body', DRIVE_MIME_DOC);
            const { data } = await editorGet(uploaded.id);
            expect(data.editMode).toBe('markdown');
            expect(data.frontmatter).toBe('title: Loose');
        });

        test('returns 400 for unsupported file types', async () => {
            const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'photo.jpg', { type: 'image/jpeg' });
            const uploaded = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, rootId, file);
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/editor/${ctx.alice.user.id}/${mountId}/${uploaded.id}/content`,
            );
            expect(res.status).toBe(400);
        });

        test('returns 400 for non-UTF-8 files', async () => {
            const buf = new Uint8Array([0x80, 0x81, 0x82, 0x83]);
            const file = new File([buf], 'binary.txt', { type: 'text/plain' });
            const uploaded = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, rootId, file);
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/editor/${ctx.alice.user.id}/${mountId}/${uploaded.id}/content`,
            );
            expect(res.status).toBe(400);
        });
    });

    describe('PUT content', () => {
        test('saves content when the etag matches, and answers the new one', async () => {
            const uploaded = await uploadTextFile('editable.txt', 'original');
            const { data: initial } = await editorGet(uploaded.id);

            const { status, data } = await editorPut(uploaded.id, { content: 'modified', expectedEtag: initial.etag });
            expect(status).toBe(200);
            if (data?.conflict !== false) throw new Error('expected a saved result');

            const { data: reloaded } = await editorGet(uploaded.id);
            expect(reloaded.content).toBe('modified');
            expect(data.etag).toBe(reloaded.etag);
        });

        // updatedAt has second precision, so a check on it let the second save of a second through.
        test('of two saves from one etag within one second, the second is a conflict', async () => {
            const uploaded = await uploadTextFile('conflict.txt', 'original');
            const { data: initial } = await editorGet(uploaded.id);

            const { data: saved } = await editorPut(uploaded.id, { content: 'version2', expectedEtag: initial.etag });
            expect(saved?.conflict).toBe(false);
            const { data } = await editorPut(uploaded.id, { content: 'version3', expectedEtag: initial.etag });

            if (data?.conflict !== true) throw new Error('expected a conflict');
            const { data: reloaded } = await editorGet(uploaded.id);
            expect(reloaded.content).toBe('version2');
            expect(data.currentEtag).toBe(reloaded.etag);
        });

        // A tab opened before the editor sent an etag still sends the updatedAt it loaded. It gets the
        // conflict dialog, whose Download and Overwrite keep its edits.
        test('a save from a tab that sends updatedAt is a conflict, and its forced save lands', async () => {
            const uploaded = await uploadTextFile('no-etag.txt', 'original');
            const { updatedAt } = uploaded;

            const { status, data } = await editorPut(uploaded.id, {
                content: 'unguarded',
                expectedUpdatedAt: updatedAt,
            });
            expect(status).toBe(200);
            expect(data?.conflict).toBe(true);
            expect((await editorGet(uploaded.id)).data.content).toBe('original');

            const { data: forced } = await editorPut(uploaded.id, {
                content: 'forced',
                expectedUpdatedAt: updatedAt,
                force: true,
            });
            expect(forced?.conflict).toBe(false);
            expect((await editorGet(uploaded.id)).data.content).toBe('forced');
        });

        test('of two saves from one etag, the one that writes second is a conflict', async () => {
            const uploaded = await uploadTextFile('race.txt', 'original');
            const { data: initial } = await editorGet(uploaded.id);

            // Hold the file's lock until both saves have passed every check before it and wait on it.
            const { mount } = await (await getHome(ctx.alice.user.id)).drive.resolveFile(mountId, uploaded.id);
            const hold = Promise.withResolvers<void>();
            const held = mount.withPathLock(uploaded.id, () => hold.promise);
            const bothWaiting = Promise.withResolvers<void>();
            let waiting = 0;
            const withPathLock = mount.withPathLock.bind(mount);
            const lock = spyOn(mount, 'withPathLock').mockImplementation(<T>(pathId: string, fn: () => Promise<T>) => {
                if (pathId === uploaded.id && ++waiting === 2) bothWaiting.resolve();
                return withPathLock(pathId, fn);
            });
            let results: Awaited<ReturnType<typeof editorPut>>[];
            try {
                const saves = Promise.all(
                    ['first', 'second'].map((content) =>
                        editorPut(uploaded.id, { content, expectedEtag: initial.etag }),
                    ),
                );
                await bothWaiting.promise;
                hold.resolve();
                await held;
                results = await saves;
            } finally {
                hold.resolve();
                lock.mockRestore();
            }

            expect(results.map((r) => r.status)).toEqual([200, 200]);
            const saved = results.filter((r) => r.data?.conflict === false);
            const conflicts = results.filter((r) => r.data?.conflict === true);
            expect(saved).toHaveLength(1);
            expect(conflicts).toHaveLength(1);

            const { data: reloaded } = await editorGet(uploaded.id);
            expect(reloaded.content).toBe(results.indexOf(saved[0]) === 0 ? 'first' : 'second');
            if (conflicts[0].data?.conflict !== true) throw new Error('expected a conflict');
            expect(conflicts[0].data.currentEtag).toBe(reloaded.etag);
        });

        test('force save ignores a stale etag', async () => {
            const uploaded = await uploadTextFile('force.txt', 'original');
            const { data: initial } = await editorGet(uploaded.id);
            await editorPut(uploaded.id, { content: 'version2', expectedEtag: initial.etag });

            const { data } = await editorPut(uploaded.id, {
                content: 'forced',
                expectedEtag: initial.etag,
                force: true,
            });
            expect(data?.conflict).toBe(false);

            const { data: reloaded } = await editorGet(uploaded.id);
            expect(reloaded.content).toBe('forced');
        });

        test('reattaches frontmatter for markdown', async () => {
            const content = '---\ntitle: Test\n---\n# Hello';
            const uploaded = await uploadTextFile('fm-save.md', content, 'text/markdown');
            const { data: initial } = await editorGet(uploaded.id);

            await editorPut(uploaded.id, {
                content: '# Updated',
                frontmatter: 'title: Test',
                expectedEtag: initial.etag,
            });

            const { data: reloaded } = await editorGet(uploaded.id);
            expect(reloaded.frontmatter).toBe('title: Test');
            expect(reloaded.content).toBe('# Updated');
        });

        test('rejects a save larger than the inline-edit cap with 413', async () => {
            const uploaded = await uploadTextFile('too-big.txt', 'seed');
            const { data: initial } = await editorGet(uploaded.id);
            const { status } = await editorPut(uploaded.id, {
                content: 'x'.repeat(MAX_INLINE_EDIT_SIZE + 1),
                expectedEtag: initial.etag,
            });
            expect(status).toBe(413);
        });

        // The default mount persists maxSizeMB (500) and team overrides only *raise* it, so this shrinks
        // the live mount config directly (mirrors team-mount-live-update.test.ts) to leave room for the
        // seed but not for a 4 MB save. getMountConfig returns the live object and applyConfig mutates it
        // in place, so the restore needs a detached copy of the values before the change.
        async function withFullMount(run: () => Promise<void>): Promise<void> {
            const home = await getHome(ctx.alice.user.id);
            const snapshot = { ...home.drive.getMountConfig(mountId) };
            const usedMB = (await home.drive.size(mountId)) / (1024 * 1024);
            await home.drive.updateMount({ ...snapshot, maxSizeMB: usedMB + 1 }, true);
            try {
                await run();
            } finally {
                await home.drive.updateMount(snapshot, true);
            }
        }
        const tooBig = 'y'.repeat(4 * 1024 * 1024);

        test('rejects a save that would exceed the mount quota with 507', async () => {
            const editable = await uploadTextFile('quota-edit.txt', 'seed');
            const { data: initial } = await editorGet(editable.id);
            await withFullMount(async () => {
                const { status } = await editorPut(editable.id, { content: tooBig, expectedEtag: initial.etag });
                expect(status).toBe(507);
            });
        });

        test("a reader's save on a full mount is refused with 403", async () => {
            const shared = await uploadTextFile('quota-reader.txt', 'seed');
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${shared.id}/acl`, {
                add: [{ id: ctx.bob.user.email, read: true, write: false }],
            });
            const { data: initial } = await editorGet(shared.id);
            await withFullMount(async () => {
                const { status } = await editorPut(
                    shared.id,
                    { content: tooBig, expectedEtag: initial.etag },
                    ctx.bob.user.sessionToken,
                );
                expect(status).toBe(403);
            });
        });

        test('a stale save on a full mount is a conflict', async () => {
            const editable = await uploadTextFile('quota-stale.txt', 'seed');
            const { data: initial } = await editorGet(editable.id);
            await editorPut(editable.id, { content: 'changed', expectedEtag: initial.etag });
            await withFullMount(async () => {
                const { status, data } = await editorPut(editable.id, { content: tooBig, expectedEtag: initial.etag });
                expect(status).toBe(200);
                expect(data?.conflict).toBe(true);
            });
        });
    });
});
