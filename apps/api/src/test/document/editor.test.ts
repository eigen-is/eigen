import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath, EditorSaveResult, FileEditorContent } from '@workspace/lib/types/drive';
import { MAX_INLINE_EDIT_SIZE } from '../../lib/drive/inline-edit';
import { getHome } from '../../lib/home';
import { authedRequest, driveGet, driveUpload, getTestContext } from '../setup';

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
    ): Promise<{ status: number; data: EditorSaveResult | null }> {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/editor/${ctx.alice.user.id}/${mountId}/${pathId}/content`,
            { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        );
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
        test('saves content when updatedAt matches', async () => {
            const uploaded = await uploadTextFile('editable.txt', 'original');
            const { data: initial } = await editorGet(uploaded.id);
            const updatedAt = initial.updatedAt;

            const { status, data } = await editorPut(uploaded.id, {
                content: 'modified',
                expectedUpdatedAt: updatedAt,
            });
            expect(status).toBe(200);
            expect(data?.conflict).toBe(false);
            expect(data?.updatedAt).toBeDefined();

            // Verify content was saved
            const { data: reloaded } = await editorGet(uploaded.id);
            expect(reloaded.content).toBe('modified');
        });

        test('returns conflict when updatedAt is stale', async () => {
            const uploaded = await uploadTextFile('conflict.txt', 'original');
            const { data: initial } = await editorGet(uploaded.id);
            const updatedAt = initial.updatedAt;

            // Wait so updatedAt will differ after save
            await new Promise((r) => setTimeout(r, 1100));

            // First save succeeds and bumps updatedAt
            const { data: saved } = await editorPut(uploaded.id, { content: 'version2', expectedUpdatedAt: updatedAt });
            expect(saved?.conflict).toBe(false);

            // Verify the first save actually changed updatedAt
            const { data: refreshed } = await editorGet(uploaded.id);
            const newUpdatedAt = refreshed.updatedAt;
            expect(newUpdatedAt).not.toBe(updatedAt);

            // Second save with original (now stale) updatedAt returns conflict
            const { data } = await editorPut(uploaded.id, {
                content: 'version3',
                expectedUpdatedAt: updatedAt, // stale!
            });
            expect(data?.conflict).toBe(true);
            expect(data?.currentUpdatedAt).toBeDefined();
        });

        test('force save ignores stale updatedAt', async () => {
            const uploaded = await uploadTextFile('force.txt', 'original');
            const { data: initial } = await editorGet(uploaded.id);
            const updatedAt = initial.updatedAt;

            await new Promise((r) => setTimeout(r, 1100));

            // First save bumps updatedAt
            await editorPut(uploaded.id, { content: 'version2', expectedUpdatedAt: updatedAt });

            // Force save with stale updatedAt
            const { data } = await editorPut(uploaded.id, {
                content: 'forced',
                expectedUpdatedAt: updatedAt,
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
            const updatedAt = initial.updatedAt;

            await editorPut(uploaded.id, {
                content: '# Updated',
                frontmatter: 'title: Test',
                expectedUpdatedAt: updatedAt,
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
                expectedUpdatedAt: initial.updatedAt,
            });
            expect(status).toBe(413);
        });

        test('rejects a save that would exceed the mount quota with 507', async () => {
            const editable = await uploadTextFile('quota-edit.txt', 'seed');
            const { data: initial } = await editorGet(editable.id);

            // The default mount persists maxSizeMB (500) and team overrides only *raise* it, so shrink
            // the live mount config directly (mirrors team-mount-live-update.test.ts) to leave room for
            // the seed but not for the 4 MB save. Snapshot a detached copy — getMountConfig returns the
            // live object and applyConfig mutates it in place, so restore needs the pre-change values.
            const home = await getHome(ctx.alice.user.id);
            const snapshot = { ...home.drive.getMountConfig(mountId) };
            const usedMB = (await home.drive.size(mountId)) / (1024 * 1024);
            await home.drive.updateMount({ ...snapshot, maxSizeMB: usedMB + 1 }, true);
            try {
                const { status } = await editorPut(editable.id, {
                    content: 'y'.repeat(4 * 1024 * 1024),
                    expectedUpdatedAt: initial.updatedAt,
                });
                expect(status).toBe(507);
            } finally {
                await home.drive.updateMount(snapshot, true);
            }
        });
    });
});
