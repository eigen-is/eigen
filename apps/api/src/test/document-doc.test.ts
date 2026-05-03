import { beforeAll, describe, expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import type { DrivePath } from '@workspace/lib/types/drive';
import { readEigendocContent, writeEigendocToYjs } from '../lib/document/doc';
import { getHome } from '../lib/home/get-home';
import { driveGet, drivePost, getTestContext } from './setup';

const extensions = getDocExtensions();
const schema = getSchema(extensions);

describe('document/doc', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    let rootId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = 'default';
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
    });

    test('round-trip: writeEigendocToYjs then readEigendocContent returns same shape', async () => {
        const docPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/doc`,
            { fileName: 'round-trip-doc' },
        );

        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, docPath.id);
        const json = {
            type: 'doc',
            content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Hello, world!' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'Second paragraph.' }] },
            ],
        };

        writeEigendocToYjs(collab.doc, json, schema);

        const { mount, path } = await home.drive.resolveFile(mountId, docPath.id);
        const content = await readEigendocContent(mount, path);

        expect(content.json).toMatchObject(json);
        expect(content.mediaByName).toBeInstanceOf(Map);
    });

    test('readEigendocContent throws when data.db is missing', async () => {
        const folder = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}`,
            { folderName: 'no-data-db.eigendoc' },
        );

        const home = await getHome(ctx.alice.user.id);
        const { mount, path } = await home.drive.resolveFile(mountId, folder.id);

        await expect(readEigendocContent(mount, path)).rejects.toThrow('eigendoc data.db missing');
    });
});
