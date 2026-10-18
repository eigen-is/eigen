import { beforeAll, describe, expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap';
import {
    BAND_ROOTS,
    DEFAULT_NORMAL_STYLE,
    DEFAULT_PAGE_SETUP,
    getDocExtensions,
    PAGE_ROOT,
    pageRecord,
    STYLE_ROOT,
} from '@workspace/lib/docs/eigendoc';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import { commitEigendocImport, readEigendocFromDoc, readEigendocPage, readEigendocStyle } from '../../lib/document/doc';
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

    test('commitEigendocImport replaces the body, the bands, the page and the Normal in one transaction', () => {
        const doc = new Y.Doc();
        seedEigendoc(doc, {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'PRIOR' }] }],
        });
        for (const root of BAND_ROOTS) {
            const band = prosemirrorJSONToYDoc(
                schema,
                { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'LETTERHEAD' }] }] },
                root,
            );
            Y.applyUpdate(doc, Y.encodeStateAsUpdate(band));
            band.destroy();
        }
        doc.getMap(PAGE_ROOT).set('marginLeft', 50);
        doc.getMap(PAGE_ROOT).set('differentFirstPage', true);
        doc.getMap(STYLE_ROOT).set('font', 'JetBrains Mono');
        doc.getMap(STYLE_ROOT).set('color', '#ff0000');

        const tempDoc = prosemirrorJSONToYDoc(
            schema,
            { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'IMPORTED' }] }] },
            'default',
        );
        const letter = {
            width: 279.4,
            height: 215.9,
            margin: { top: 10, right: 10, bottom: 10, left: 10 },
            differentFirstPage: false,
        };
        let transactions = 0;
        doc.on('afterTransaction', () => transactions++);
        const style = { ...DEFAULT_NORMAL_STYLE, size: 12, lineSpacing: 1.15, spaceAfter: 10 };
        commitEigendocImport(doc, { update: Y.encodeStateAsUpdate(tempDoc), page: letter, style });
        tempDoc.destroy();

        expect(transactions).toBe(1);
        const json = JSON.stringify(readEigendocFromDoc(doc));
        expect(json).toContain('IMPORTED');
        expect(json).not.toContain('PRIOR');
        for (const root of BAND_ROOTS) expect(doc.getXmlFragment(root).length).toBe(0);
        expect(doc.getMap(PAGE_ROOT).toJSON()).toEqual(pageRecord(letter));
        expect(readEigendocPage(doc)).toEqual(letter);
        // Every key, the default's too, so the file's Normal replaces the doc's whole.
        expect(doc.getMap(STYLE_ROOT).toJSON()).toEqual(style);
        expect(readEigendocStyle(doc)).toEqual(style);
        doc.destroy();
    });

    test('a doc with no page or style map reads the default page and Normal', () => {
        const doc = new Y.Doc();
        expect(readEigendocPage(doc)).toEqual(DEFAULT_PAGE_SETUP);
        expect(readEigendocStyle(doc)).toEqual(DEFAULT_NORMAL_STYLE);
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
