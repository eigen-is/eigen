import { beforeAll, describe, expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import {
    readEigendocContent,
    readEigendocFromDoc,
    writeEigendocToYjs,
    writeEigendocUpdateToYjs,
} from '../lib/document/doc';
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

    test('writeEigendocUpdateToYjs commits a prepared update to the same end state', () => {
        // The import commit path: the Worker converts ProseMirror JSON to a Yjs
        // update, the main thread only applies it.
        const json = {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From the Worker.' }] }],
        };
        const viaJson = new Y.Doc();
        writeEigendocToYjs(viaJson, json, schema);

        const tempDoc = prosemirrorJSONToYDoc(schema, json, 'default');
        const viaUpdate = new Y.Doc();
        writeEigendocUpdateToYjs(viaUpdate, Y.encodeStateAsUpdate(tempDoc));
        tempDoc.destroy();

        expect(readEigendocFromDoc(viaUpdate)).toEqual(readEigendocFromDoc(viaJson));
        viaJson.destroy();
        viaUpdate.destroy();
    });

    test('writeEigendocUpdateToYjs replaces existing content instead of appending', () => {
        const doc = new Y.Doc();
        writeEigendocToYjs(
            doc,
            { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PRIOR' }] }] },
            schema,
        );

        const tempDoc = prosemirrorJSONToYDoc(
            schema,
            { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'IMPORTED' }] }] },
            'default',
        );
        writeEigendocUpdateToYjs(doc, Y.encodeStateAsUpdate(tempDoc));
        tempDoc.destroy();

        const json = JSON.stringify(readEigendocFromDoc(doc));
        expect(json).toContain('IMPORTED');
        expect(json).not.toContain('PRIOR');
        doc.destroy();
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
