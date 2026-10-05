import { beforeAll, describe, expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import { readEigendocFromDoc, writeEigendocUpdateToYjs } from '../../lib/document/doc';
import { captureCollabSource } from '../../lib/document/transform/collab-source';
import { getHome } from '../../lib/home/get-home';
import { seedEigendoc } from '../fixtures/golden-documents';
import { readPersistedDoc } from '../fixtures/transform-results';
import { driveGet, drivePost, getTestContext } from '../setup';

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

    test('round-trip: a committed eigendoc reads back the same shape once persisted', async () => {
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

        seedEigendoc(collab.doc, json);

        const { mount, path } = await home.drive.resolveFile(mountId, docPath.id);
        const persisted = await readPersistedDoc(mount, path);

        expect(readEigendocFromDoc(persisted)).toMatchObject(json);
        persisted.destroy();
    });

    test('writeEigendocUpdateToYjs replaces existing content instead of appending', () => {
        const doc = new Y.Doc();
        seedEigendoc(doc, {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PRIOR' }] }],
        });

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

    test('reading an eigendoc container without a data.db throws', async () => {
        const folder = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}`,
            { folderName: 'no-data-db.eigendoc' },
        );

        const home = await getHome(ctx.alice.user.id);
        const { mount, path } = await home.drive.resolveFile(mountId, folder.id);

        await expect(captureCollabSource(mount, path)).rejects.toThrow('data.db missing');
    });
});
