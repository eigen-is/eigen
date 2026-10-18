import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PPTX_MIME } from '@workspace/lib/constants/mime';
import type { DrivePath, ImportResult } from '@workspace/lib/types/drive';
import {
    readVectorFromDoc,
    SLIDES_STYLE_DEFAULTS,
    type VectorScene,
    writeElementInDoc,
    writeFrameInDoc,
} from '@workspace/lib/vector';
import { ApiError } from '../../lib/core';
import { toTransferableBuffer } from '../../lib/document/transform/protocol';
import { documentTransformRunner } from '../../lib/document/transform/runner';
import { getSharedDrive } from '../../lib/drive/get-drive';
import { getHome } from '../../lib/home/get-home';
import { convertToDocument, importIntoDocument } from '../../lib/import/import-document';
import { getUserById } from '../../lib/user';
import { box, buildPptx, graphicFrame, PIXEL_PNG, para, pic, rel, solid, sp, xfrm } from '../fixtures/pptx';
import {
    assertJson,
    authedRequest,
    driveGet,
    driveGetList,
    drivePost,
    drivePut,
    driveUpload,
    getTestContext,
} from '../setup';

// Route contract of Convert to Slides and Import slides…: what a deck holds after each, what its media folder gets,
// the summary Import slides… answers with, and what is refused before anything is written.

const TABLE_URI = 'http://schemas.openxmlformats.org/drawingml/2006/table';

// Two slides: a title over a red box, then a picture beside a table the import drops.
const PPTX = toTransferableBuffer(
    buildPptx({
        slides: [
            {
                shapes:
                    sp({ ph: '<p:ph type="title"/>', xfrm: box(100, 50, 1000, 100), text: para('Welcome') }) +
                    sp({ xfrm: box(100, 300, 400, 200), spPr: solid('FF0000') }),
            },
            {
                shapes:
                    pic({ xfrm: box(0, 0, 960, 540), embed: 'rId2' }) + graphicFrame(TABLE_URI, 0, 0, 635000, 635000),
                rels: rel('rId2', 'image', '../media/image1.png'),
            },
        ],
        files: { 'ppt/media/image1.png': PIXEL_PNG },
    }),
);

const EMPTY_PPTX = toTransferableBuffer(buildPptx({ slides: [] }));

// One slide covered by one box, 4:3 or 16:9.
const filled = (cx: number, cy: number) =>
    toTransferableBuffer(
        buildPptx({
            sldSz: `<p:sldSz cx="${cx}" cy="${cy}"/>`,
            slides: [{ shapes: sp({ xfrm: xfrm(0, 0, cx, cy), spPr: solid('FF0000') }) }],
        }),
    );
const STANDARD_PPTX = filled(9144000, 6858000);
const WIDE_PPTX = filled(12192000, 6858000);

// No pictures, so no media write of its own stands between a revoked writer and the deck.
const TEXT_PPTX = toTransferableBuffer(
    buildPptx({ slides: [{ shapes: sp({ xfrm: box(100, 50, 1000, 100), text: para('Only text') }) }] }),
);

let ctx: Awaited<ReturnType<typeof getTestContext>>;
const mountId = 'default';
let rootId: string;

beforeAll(async () => {
    ctx = await getTestContext();
    const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
    rootId = root.id;
});

function folder(name: string): Promise<DrivePath> {
    return drivePost<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `folder/${rootId}`, {
        folderName: name,
    });
}

function upload(bytes: ArrayBuffer | string, fileName: string, parentId = rootId): Promise<DrivePath> {
    return driveUpload<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        parentId,
        new File([bytes], fileName, { type: PPTX_MIME }),
    );
}

function createDeck(fileName: string): Promise<DrivePath> {
    return drivePost<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        `folder/${rootId}/create/slides`,
        {
            fileName,
        },
    );
}

function convertRequest(pathId: string): Promise<Response> {
    return authedRequest(
        ctx.alice.user.sessionToken,
        `/drive/${ctx.alice.user.id}/${mountId}/file/${pathId}/convert/eigenslides`,
        { method: 'POST' },
    );
}

function importRequest(pathId: string, body: ArrayBuffer): Promise<Response> {
    return authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/${mountId}/file/${pathId}/import`, {
        method: 'POST',
        body,
    });
}

async function readDeck(pathId: string): Promise<VectorScene> {
    const home = await getHome(ctx.alice.user.id);
    const collab = await home.drive.getCollabDocument(mountId, pathId);
    return readVectorFromDoc(collab.doc);
}

async function mediaNames(pathId: string): Promise<string[]> {
    const home = await getHome(ctx.alice.user.id);
    const { mount } = await home.drive.resolveFile(mountId, pathId);
    const media = await mount.getChildByName(pathId, 'media');
    if (!media) throw new Error('media folder missing');
    return (await mount.listFolder(media.id)).map((child) => child.name);
}

async function listing(parentId: string): Promise<string[]> {
    const entries = await driveGetList(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'folder', parentId);
    return entries.map((entry) => entry.name).sort();
}

// A deck someone works in: one slide holding one box, and a meta key of its own.
async function seededDeck(fileName: string, meta: Record<string, string> = { own: 'kept' }): Promise<DrivePath> {
    const deck = await createDeck(fileName);
    const home = await getHome(ctx.alice.user.id);
    const { doc } = await home.drive.getCollabDocument(mountId, deck.id);
    doc.transact(() => {
        writeFrameInDoc(doc, { id: 'fr-own', index: 'a0', name: 'Own slide' });
        writeElementInDoc(
            doc,
            { type: 'rectangle', frameId: 'fr-own', x: 10, y: 10, width: 100, height: 100 },
            'a0',
            SLIDES_STYLE_DEFAULTS,
            'el-own',
        );
        for (const [key, value] of Object.entries(meta)) doc.getMap('meta').set(key, value);
    });
    return deck;
}

describe('Convert to Slides', () => {
    test('makes a deck beside the .pptx with its slides, shapes and pictures, and answers only its path', async () => {
        const uploaded = await upload(PPTX, 'pitch.pptx');
        const result = await assertJson<DrivePath>(await convertRequest(uploaded.id));
        expect(result.type).toBe('slides');
        expect(result.name).toBe('pitch.eigenslides');
        expect(result.parentId).toBe(rootId);
        expect(result).not.toHaveProperty('summary');

        const deck = await readDeck(result.id);
        expect(deck.frames.map((frame) => frame.name)).toEqual(['Welcome', '']);
        const [first, second] = deck.frames;
        const on = (frameId: string | undefined) => deck.elements.filter((el) => el.frameId === frameId);
        expect(on(first?.id).map((el) => el.type)).toEqual(['richtext', 'rectangle']);
        // The table's placeholder box, saying what was there, sits above the picture.
        expect(on(second?.id).map((el) => el.type)).toEqual(['image', 'richtext']);

        const [image] = on(second?.id);
        if (image?.type !== 'image') throw new Error('picture missing');
        expect(await mediaNames(result.id)).toEqual([image.mediaName]);
    }, 60_000);

    test('a 4:3 .pptx makes a 4:3 deck, its slides filling the frame', async () => {
        const uploaded = await upload(STANDARD_PPTX, 'standard.pptx');
        const result = await assertJson<DrivePath>(await convertRequest(uploaded.id));
        const deck = await readDeck(result.id);
        expect(deck.meta.slideSize).toBe('4:3');
        expect(deck.frames.map((frame) => [frame.width, frame.height])).toEqual([[1920, 1440]]);
        expect(deck.elements[0]).toMatchObject({ x: 0, y: 0, width: 1920, height: 1440 });
    }, 60_000);

    test('a .pptx with no slides makes a deck with no slides, which the editor seeds as it does a new one', async () => {
        const uploaded = await upload(EMPTY_PPTX, 'empty.pptx');
        const result = await assertJson<DrivePath>(await convertRequest(uploaded.id));
        const deck = await readDeck(result.id);
        expect(deck.frames).toEqual([]);
        expect(deck.elements).toEqual([]);
    }, 60_000);

    test('a .pptm is refused on its name before anything is created', async () => {
        const parent = await folder('convert-pptm');
        const uploaded = await upload(PPTX, 'macros.pptm', parent.id);
        const res = await convertRequest(uploaded.id);
        expect(res.status).toBe(400);
        expect(await res.text()).toBe('Only .pptx files can be converted to Slides');
        expect(await listing(parent.id)).toEqual(['macros.pptm']);
    }, 60_000);

    test('a folder the caller only reads refuses the convert before the file is transformed', async () => {
        const parent = await folder('convert-read-only');
        const uploaded = await upload(PPTX, 'shared.pptx', parent.id);
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${parent.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: false }],
        });
        const runSpy = spyOn(documentTransformRunner, 'run');
        try {
            const res = await authedRequest(
                ctx.bob.user.sessionToken,
                `/drive/${ctx.alice.user.id}/${mountId}/file/${uploaded.id}/convert/eigenslides`,
                { method: 'POST' },
            );
            expect(res.status).toBe(403);
            expect(runSpy).not.toHaveBeenCalled();
        } finally {
            runSpy.mockRestore();
        }
        expect(await listing(parent.id)).toEqual(['shared.pptx']);
    }, 60_000);

    test('a picture that fails to save trashes the new deck and answers the failure', async () => {
        const parent = await folder('convert-media-fails');
        const uploaded = await upload(PPTX, 'pictures.pptx', parent.id);
        const alice = await getUserById(ctx.alice.user.id);
        if (!alice) throw new Error('alice missing');
        const drive = await getSharedDrive(ctx.alice.user.id, alice);
        const { mount, path } = await drive.resolveFile(mountId, uploaded.id);
        const failure = new ApiError(409, 'media/taken.png is not a file');
        const createSpy = spyOn(drive, 'createFileFromData').mockRejectedValue(failure);
        try {
            await expect(convertToDocument(drive, mount, path, 'eigenslides', alice)).rejects.toBe(failure);
        } finally {
            createSpy.mockRestore();
        }
        expect(await listing(parent.id)).toEqual(['pictures.pptx']);
    }, 60_000);

    test('a .pptx that is no zip is refused before anything is created', async () => {
        const parent = await folder('convert-garbage');
        const uploaded = await upload('not a presentation', 'garbage.pptx', parent.id);
        const res = await convertRequest(uploaded.id);
        expect(res.status).toBe(400);
        expect(await res.text()).toBe('Not a valid pptx file');
        expect(await listing(parent.id)).toEqual(['garbage.pptx']);
    }, 60_000);
});

describe('Import slides…', () => {
    test("appends the file's slides after the deck's own and leaves its slides and meta alone", async () => {
        const deck = await seededDeck('import-target');
        const result = await assertJson<ImportResult>(await importRequest(deck.id, PPTX));
        expect(result).toEqual({ success: true, summary: '1 table was not imported.' });

        const scene = await readDeck(deck.id);
        expect(scene.frames.map((frame) => frame.name)).toEqual(['Own slide', 'Welcome', '']);
        expect(scene.frames[0]?.id).toBe('fr-own');
        expect(scene.elements[0]?.id).toBe('el-own');
        expect(scene.elements).toHaveLength(5);
        const home = await getHome(ctx.alice.user.id);
        const { doc } = await home.drive.getCollabDocument(mountId, deck.id);
        expect(doc.getMap('meta').toJSON()).toEqual({ own: 'kept' });
        expect(await mediaNames(deck.id)).toHaveLength(1);
    }, 60_000);

    test("a 4:3 file is letterboxed into a 16:9 deck's frame, the deck's meta left alone", async () => {
        const deck = await seededDeck('import-standard');
        await assertJson<ImportResult>(await importRequest(deck.id, STANDARD_PPTX));
        const scene = await readDeck(deck.id);
        expect(scene.meta.slideSize).toBe('16:9');
        expect(scene.elements.find((el) => el.frameId === scene.frames[1]?.id)).toMatchObject({
            x: 240,
            y: 0,
            width: 1440,
            height: 1080,
        });
        const home = await getHome(ctx.alice.user.id);
        const { doc } = await home.drive.getCollabDocument(mountId, deck.id);
        expect(doc.getMap('meta').toJSON()).toEqual({ own: 'kept' });
    }, 60_000);

    test("a 16:9 file is letterboxed into a 4:3 deck's frame, the deck staying 4:3", async () => {
        const deck = await seededDeck('import-into-standard', { slideSize: '4:3' });
        await assertJson<ImportResult>(await importRequest(deck.id, WIDE_PPTX));
        const scene = await readDeck(deck.id);
        expect(scene.meta.slideSize).toBe('4:3');
        expect(scene.elements.find((el) => el.frameId === scene.frames[1]?.id)).toMatchObject({
            x: 0,
            y: 180,
            width: 1920,
            height: 1080,
        });
    }, 60_000);

    test('a second import of the same file appends again, its pictures under names of their own', async () => {
        const deck = await seededDeck('import-twice');
        await assertJson<ImportResult>(await importRequest(deck.id, PPTX));
        await assertJson<ImportResult>(await importRequest(deck.id, PPTX));
        expect((await readDeck(deck.id)).frames).toHaveLength(5);
        expect(new Set(await mediaNames(deck.id)).size).toBe(2);
    }, 60_000);

    test('a .pptx with no slides says so and leaves the deck untouched', async () => {
        const deck = await seededDeck('import-empty');
        const before = await readDeck(deck.id);
        const result = await assertJson<ImportResult>(await importRequest(deck.id, EMPTY_PPTX));
        expect(result).toEqual({ success: true, summary: 'This presentation has no slides' });
        expect(await readDeck(deck.id)).toEqual(before);
    }, 60_000);

    test('a body that is no zip is a 400 and leaves the deck untouched', async () => {
        const deck = await seededDeck('import-garbage');
        const before = await readDeck(deck.id);
        const res = await importRequest(deck.id, toTransferableBuffer(new TextEncoder().encode('not a presentation')));
        expect(res.status).toBe(400);
        expect(await res.text()).toBe('Not a valid pptx file');
        expect(await readDeck(deck.id)).toEqual(before);
    }, 60_000);

    test('a deck closed while the file is transformed still gets its slides, saved', async () => {
        const deck = await seededDeck('import-closed-meanwhile');
        const alice = await getUserById(ctx.alice.user.id);
        if (!alice) throw new Error('alice missing');
        const drive = await getSharedDrive(ctx.alice.user.id, alice);
        const { path } = await drive.resolveFile(mountId, deck.id);
        const home = await getHome(ctx.alice.user.id);

        // The last tab leaving during a long queue and transform: the linger closes the deck before the commit.
        const realRun = documentTransformRunner.run.bind(documentTransformRunner);
        const runSpy = spyOn(documentTransformRunner, 'run').mockImplementation(async (request, opts) => {
            const response = await realRun(request, opts);
            if (request.kind === 'import') await home.drive.closeCollabDocument(mountId, deck.id);
            return response;
        });
        try {
            expect(await importIntoDocument(drive, path, Buffer.from(PPTX), alice)).toBe('1 table was not imported.');
        } finally {
            runSpy.mockRestore();
        }
        await home.drive.closeCollabDocument(mountId, deck.id);
        expect((await readDeck(deck.id)).frames.map((frame) => frame.name)).toEqual(['Own slide', 'Welcome', '']);
    }, 60_000);

    test('write revoked while the pictures are saved blocks the slides', async () => {
        const deck = await seededDeck('import-acl-race-media');
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${deck.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: true }],
        });
        const bob = await getUserById(ctx.bob.user.id);
        if (!bob) throw new Error('bob missing');
        const bobDrive = await getSharedDrive(ctx.alice.user.id, bob);
        const { path } = await bobDrive.resolveFile(mountId, deck.id);

        const realCreate = bobDrive.createFileFromData.bind(bobDrive);
        const createSpy = spyOn(bobDrive, 'createFileFromData').mockImplementation(async (...args) => {
            const created = await realCreate(...args);
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${deck.id}/acl`, {
                add: [{ id: ctx.bob.user.email, read: true, write: false }],
            });
            return created;
        });

        const before = await readDeck(deck.id);
        try {
            await expect(importIntoDocument(bobDrive, path, Buffer.from(PPTX), bob)).rejects.toEqual(
                new ApiError(403, 'No write permission'),
            );
        } finally {
            createSpy.mockRestore();
        }
        expect(await readDeck(deck.id)).toEqual(before);
    }, 60_000);

    test('write revoked during the collab-document lookup blocks the commit', async () => {
        const deck = await seededDeck('import-acl-race');
        await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${deck.id}/acl`, {
            add: [{ id: ctx.bob.user.email, read: true, write: true }],
        });
        const bob = await getUserById(ctx.bob.user.id);
        if (!bob) throw new Error('bob missing');
        const bobDrive = await getSharedDrive(ctx.alice.user.id, bob);
        const { path } = await bobDrive.resolveFile(mountId, deck.id);

        const realGet = bobDrive.getCollabDocument.bind(bobDrive);
        const getSpy = spyOn(bobDrive, 'getCollabDocument').mockImplementation(async (id, pathId) => {
            await drivePut(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${deck.id}/acl`, {
                add: [{ id: ctx.bob.user.email, read: true, write: false }],
            });
            return realGet(id, pathId);
        });

        const before = await readDeck(deck.id);
        try {
            await expect(importIntoDocument(bobDrive, path, Buffer.from(TEXT_PPTX), bob)).rejects.toEqual(
                new ApiError(403, 'No write permission'),
            );
        } finally {
            getSpy.mockRestore();
        }
        expect(await readDeck(deck.id)).toEqual(before);
    }, 60_000);
});
