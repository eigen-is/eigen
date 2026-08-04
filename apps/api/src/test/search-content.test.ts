import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { SearchResponse } from '@workspace/lib/types/search';
import { sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { ApiError } from '../lib/core/errors';
import { documentTransformRunner } from '../lib/document/transform/runner';
import {
    assertJson,
    authedRequest,
    chatPost,
    driveDelete,
    driveGet,
    drivePost,
    driveUpload,
    getTestContext,
} from './setup';

describe('Drive content-index', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    let rootId: string;
    let home: Awaited<ReturnType<typeof import('../lib/home').getHome>>;

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        mountId = mounts![0].id;
        const root = await driveGet(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;
        const { getHome } = await import('../lib/home');
        home = await getHome(ctx.alice.user.id);
    });

    // Hits the real /search endpoint with ?sources=file so results come through
    // the same FTS + path_content pipeline that production uses.
    async function searchFile(term: string): Promise<SearchResponse> {
        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/search/${ctx.alice.user.id}?sources=file&q=${term}`,
        );
        return assertJson<SearchResponse>(res);
    }

    test('a sheet body becomes searchable after a reindex sweep, and honours the 2-min cap', async () => {
        const sheetsPath = await home.drive.create(mountId, rootId, 'reindex-sheet', 'sheets');
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);
        const sheets = [
            {
                id: 'sheet-1',
                name: 'Sheet1',
                order: 0,
                config: {},
                celldata: [{ r: 0, c: 0, v: { m: 'zarquon', v: 'zarquon' } }],
            },
        ];
        collab.doc.transact(() => {
            collab.doc.getMap('state').set('snapshot', JSON.stringify(sheets));
        });

        // Fire onSync → marks the container contentDirty.
        await home.drive.flushContainerDb(mountId, sheetsPath.id);
        // Drain the dirty bit off the request path.
        await home.drive.flushContentReindex();

        expect(home.drive.search({ q: 'zarquon', limit: 20 }).some((h) => h.id === sheetsPath.id)).toBe(true);

        // Second immediate reindex is a no-op (within the 2-min cap) — content stays indexed.
        await home.drive.flushContentReindex();
        expect(home.drive.search({ q: 'zarquon', limit: 20 }).some((h) => h.id === sheetsPath.id)).toBe(true);
    });

    test('DOC body is searchable', async () => {
        const docPath = await home.drive.create(mountId, rootId, 'rt-doc', 'doc');
        const collab = await home.drive.getCollabDocument(mountId, docPath.id);
        const p = new Y.XmlElement('paragraph');
        p.insert(0, [new Y.XmlText('flibberdoc content here')]);
        collab.doc.getXmlFragment('default').insert(0, [p]);
        await home.drive.flushContainerDb(mountId, docPath.id);
        await home.drive.flushContentReindex();
        expect((await searchFile('flibberdoc')).file.some((h) => h.id === docPath.id)).toBe(true);
    });

    // copyPath byte-copies the container's data.db (no onSync fires for the new container),
    // so the copy must be marked contentDirty by copyPath itself or its body never indexes.
    test('a COPIED doc body is searchable (copy marks the new container dirty)', async () => {
        const src = await home.drive.create(mountId, rootId, 'rt-copysrc', 'doc');
        const collab = await home.drive.getCollabDocument(mountId, src.id);
        const p = new Y.XmlElement('paragraph');
        p.insert(0, [new Y.XmlText('flibbercopy content here')]);
        collab.doc.getXmlFragment('default').insert(0, [p]);
        await home.drive.flushContainerDb(mountId, src.id);
        await home.drive.flushContentReindex();

        // The search term lives only in the body (neither name contains it), so a hit on the
        // copy proves the copied container's body was indexed.
        const copied = await home.drive.copyPath(mountId, src.id, rootId, 'rt-copydst');
        await home.drive.flushContentReindex();
        expect((await searchFile('flibbercopy')).file.some((h) => h.id === copied.id)).toBe(true);
    });

    test('SLIDES body is searchable', async () => {
        const slidesPath = await home.drive.create(mountId, rootId, 'rt-slides', 'slides');
        const collab = await home.drive.getCollabDocument(mountId, slidesPath.id);
        collab.doc.transact(() => {
            const objects = collab.doc.getMap('objects');
            const slides = collab.doc.getMap('slides');
            const order = collab.doc.getArray('slideOrder');
            const o = new Y.Map();
            o.set('id', 'o1');
            o.set('slideId', 's1');
            o.set('type', 'text');
            o.set('text', 'flibberslide deck');
            objects.set('o1', o);
            const s = new Y.Map();
            s.set('id', 's1');
            const ids = new Y.Array();
            ids.push(['o1']);
            s.set('objectIds', ids);
            slides.set('s1', s);
            order.push(['s1']);
        });
        await home.drive.flushContainerDb(mountId, slidesPath.id);
        await home.drive.flushContentReindex();
        expect((await searchFile('flibberslide')).file.some((h) => h.id === slidesPath.id)).toBe(true);
    });

    test('STICKIES card title + description are searchable', async () => {
        const stk = await home.drive.create(mountId, rootId, 'rt-stickies', 'stickies');
        const collab = await home.drive.getCollabDocument(mountId, stk.id);
        collab.doc.transact(() => {
            const tasks = collab.doc.getMap('tasks');
            const card = new Y.Map();
            card.set('id', 't1');
            card.set('title', 'flibbercard');
            card.set('description', 'with flibberdesc inside');
            tasks.set('t1', card);
            const columns = collab.doc.getMap('columns');
            const col = new Y.Map();
            col.set('id', 'c1');
            col.set('title', 'Backlog');
            columns.set('c1', col);
        });
        await home.drive.flushContainerDb(mountId, stk.id);
        await home.drive.flushContentReindex();
        expect((await searchFile('flibbercard')).file.some((h) => h.id === stk.id)).toBe(true);
        expect((await searchFile('flibberdesc')).file.some((h) => h.id === stk.id)).toBe(true);
    });

    // Chat flush decision: chatPost writes to the chat's data.db via ChatRoom.init() →
    // drive.openDatabase(), which caches the ManagedDatabase in mount.documentDbs. A
    // subsequent flushContainerDb finds the cached db and flushes it, triggering onSync →
    // markContainerContentDirty. This is reliable because the same Home/Mount singleton
    // is shared between the test process and the in-process API route handlers.
    test('CHAT recent messages are searchable', async () => {
        const chat = await drivePost(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/chat`,
            { fileName: 'rt-chat' },
        );
        await chatPost(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `${chat.id}/messages`, {
            content: 'flibberchat message body',
        });
        // flush triggers onSync → markContainerContentDirty on the chat container.
        await home.drive.flushContainerDb(mountId, chat.id);
        await home.drive.flushContentReindex();
        expect((await searchFile('flibberchat')).file.some((h) => h.id === chat.id)).toBe(true);
    });

    // Plaintext files get contentDirty = 1 at upload time (write-path mark), so no
    // flushContainerDb is needed — flushContentReindex() alone drains the dirty bit.
    test('PLAINTEXT file body is searchable (no flush — write-path mark)', async () => {
        const file = new File([new TextEncoder().encode('flibbertext inside a plaintext file')], 'notes.txt', {
            type: 'text/plain',
        });
        const uploaded = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, rootId, file);
        await home.drive.flushContentReindex();
        expect((await searchFile('flibbertext')).file.some((h) => h.id === uploaded.id)).toBe(true);
    });

    test('a NAME match outranks a body-only match (end to end)', async () => {
        // File A: unique term only in body; File B: unique term in name only (content is 1 opaque byte).
        const a = new File([new TextEncoder().encode('contains zonktoken in body')], 'plain-a.txt', {
            type: 'text/plain',
        });
        const upA = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, rootId, a);
        const b = new File([new Uint8Array([1])], 'zonktoken-named.txt', { type: 'text/plain' });
        const upB = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, rootId, b);
        await home.drive.flushContentReindex();
        const ids = (await searchFile('zonktoken')).file.map((h) => h.id);
        expect(ids).toContain(upA.id);
        expect(ids).toContain(upB.id);
        // name hits are merged before body-only hits, so upB (name match) must precede upA (body match).
        expect(ids.indexOf(upB.id)).toBeLessThan(ids.indexOf(upA.id));
    });

    test('deleting a file removes its body from search', async () => {
        const file = new File([new TextEncoder().encode('ephemeral zappotoken text')], 'gone.txt', {
            type: 'text/plain',
        });
        const up = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, rootId, file);
        await home.drive.flushContentReindex();
        expect((await searchFile('zappotoken')).file.some((h) => h.id === up.id)).toBe(true);
        // driveDelete trashes the path; search filters on trashedAt IS NULL so it disappears.
        await driveDelete(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, `path/${up.id}`);
        expect((await searchFile('zappotoken')).file.some((h) => h.id === up.id)).toBe(false);
    });

    test('the ~100 KB cap drops content past the limit', async () => {
        const needle = 'caplimittoken';
        // needle is appended after 150 KB of padding — well past the 100 KB read cap.
        const big = `${'x'.repeat(150_000)} ${needle}`;
        const file = new File([new TextEncoder().encode(big)], 'big.txt', { type: 'text/plain' });
        const up = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, rootId, file);
        await home.drive.flushContentReindex();
        expect((await searchFile(needle)).file.some((h) => h.id === up.id)).toBe(false);
    });

    test('container internals never surface as body hits', async () => {
        // A doc whose body contains a term must surface the CONTAINER, never its data.db child.
        const docPath = await home.drive.create(mountId, rootId, 'rt-internal', 'doc');
        const collab = await home.drive.getCollabDocument(mountId, docPath.id);
        const p = new Y.XmlElement('paragraph');
        p.insert(0, [new Y.XmlText('internalcheck token')]);
        collab.doc.getXmlFragment('default').insert(0, [p]);
        await home.drive.flushContainerDb(mountId, docPath.id);
        await home.drive.flushContentReindex();
        const hits = (await searchFile('internalcheck')).file;
        // The container itself is found by its indexed body content.
        expect(hits.some((h) => h.id === docPath.id)).toBe(true);
        // No hit has the container as its parent — data.db / media / chat internals are excluded.
        expect(hits.every((h) => h.parentId !== docPath.id)).toBe(true);
    });

    // Collab bodies extract inside the transform Worker, so a refused job (503) must fail
    // that drain row: the dirty bit stays set and the previously indexed body survives
    // untouched. There is no main-thread fallback to quietly re-extract it.
    test('a refused Worker extract keeps the sheet dirty and its indexed body unchanged', async () => {
        const sheetsPath = await home.drive.create(mountId, rootId, 'reindex-refused', 'sheets');
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);
        const writeCell = (text: string) => {
            const sheets = [
                {
                    id: 'sheet-1',
                    name: 'Sheet1',
                    order: 0,
                    config: {},
                    celldata: [{ r: 0, c: 0, v: { m: text, v: text } }],
                },
            ];
            collab.doc.transact(() => {
                collab.doc.getMap('state').set('snapshot', JSON.stringify(sheets));
            });
        };

        writeCell('staleflibber');
        await home.drive.flushContainerDb(mountId, sheetsPath.id);
        await home.drive.flushContentReindex();
        expect((await searchFile('staleflibber')).file.some((h) => h.id === sheetsPath.id)).toBe(true);

        // New body, and the row aged back into the drain window — the 2-min cap would defer it.
        writeCell('freshflibber');
        await home.drive.flushContainerDb(mountId, sheetsPath.id);
        const { mount } = await home.drive.resolveFile(mountId, sheetsPath.id);
        mount.db.run(sql`UPDATE paths SET contentDirty = 1, contentIndexedAt = 0 WHERE id = ${sheetsPath.id}`);

        const runSpy = spyOn(documentTransformRunner, 'run').mockImplementation(() => {
            throw new ApiError(503, 'The server is busy, please try again in a moment');
        });
        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        try {
            await home.drive.flushContentReindex();
        } finally {
            errorSpy.mockRestore();
            runSpy.mockRestore();
        }

        const [row] = mount.db.all(sql`SELECT contentDirty FROM paths WHERE id = ${sheetsPath.id}`) as {
            contentDirty: number;
        }[];
        expect(row.contentDirty).toBe(1);
        expect((await searchFile('staleflibber')).file.some((h) => h.id === sheetsPath.id)).toBe(true);
        expect((await searchFile('freshflibber')).file.some((h) => h.id === sheetsPath.id)).toBe(false);
    });

    // The drain captures the document at job start, but queue wait plus the Worker can
    // take minutes. An edit that syncs inside that window must survive the older body's
    // success — clearing the bit there leaves the newer content unindexed until some
    // unrelated future write re-dirties the row.
    test('an edit during an extract keeps the container dirty until it is re-extracted', async () => {
        const sheetsPath = await home.drive.create(mountId, rootId, 'reindex-race', 'sheets');
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);
        const writeCell = (text: string) => {
            const sheets = [
                {
                    id: 'sheet-1',
                    name: 'Sheet1',
                    order: 0,
                    config: {},
                    celldata: [{ r: 0, c: 0, v: { m: text, v: text } }],
                },
            ];
            collab.doc.transact(() => {
                collab.doc.getMap('state').set('snapshot', JSON.stringify(sheets));
            });
        };

        writeCell('raceoldflibber');
        await home.drive.flushContainerDb(mountId, sheetsPath.id);
        await home.drive.flushContentReindex();

        const { mount } = await home.drive.resolveFile(mountId, sheetsPath.id);
        const dueNow = () => mount.db.run(sql`UPDATE paths SET contentIndexedAt = 0 WHERE id = ${sheetsPath.id}`);
        const contentDirty = () =>
            (
                mount.db.all(sql`SELECT contentDirty FROM paths WHERE id = ${sheetsPath.id}`) as {
                    contentDirty: number;
                }[]
            )[0].contentDirty;

        mount.db.run(sql`UPDATE paths SET contentDirty = 1, contentIndexedAt = 0 WHERE id = ${sheetsPath.id}`);

        // The runner is a process-wide singleton — scope the interception to the extract.
        const real = documentTransformRunner.run.bind(documentTransformRunner);
        const runSpy = spyOn(documentTransformRunner, 'run').mockImplementation(async (request, opts) => {
            if (request.kind !== 'extract-text') return real(request, opts);
            // A newer edit lands and syncs while this extract is in flight.
            writeCell('racenewflibber');
            await home.drive.flushContainerDb(mountId, sheetsPath.id);
            return { ok: true, result: { text: 'racemidflibber' }, warnings: [] };
        });
        try {
            await home.drive.flushContentReindex();
        } finally {
            runSpy.mockRestore();
        }

        // The extracted body landed, but the newer edit's dirty bit is still standing.
        expect((await searchFile('racemidflibber')).file.some((h) => h.id === sheetsPath.id)).toBe(true);
        expect(contentDirty()).toBe(1);

        // The cap window deferred the retry; once due, the newer body indexes and clears.
        dueNow();
        await home.drive.flushContentReindex();
        expect((await searchFile('racenewflibber')).file.some((h) => h.id === sheetsPath.id)).toBe(true);
        expect(contentDirty()).toBe(0);
    });

    // The write path sets the bit, awaits ancestor invalidation, then reaches the
    // queue. The generation must already be bumped when the bit lands: an extract
    // completing inside that await would otherwise compare equal generations and
    // clear the bit the newer write just set.
    test('a file write landing while its extract completes keeps the row dirty', async () => {
        const file = new File([new TextEncoder().encode('genracestale body')], 'gen-race.txt', {
            type: 'text/plain',
        });
        const uploaded = await driveUpload(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, rootId, file);
        await home.drive.flushContentReindex();

        const { mount } = await home.drive.resolveFile(mountId, uploaded.id);
        mount.db.run(sql`UPDATE paths SET contentDirty = 1, contentIndexedAt = 0 WHERE id = ${uploaded.id}`);

        // Hold this path's extract open at its storage read.
        const realRead = mount.readRange.bind(mount);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const readSpy = spyOn(mount, 'readRange').mockImplementation(async (pathId, start, end) => {
            if (pathId !== uploaded.id) return realRead(pathId, start, end);
            readSpy.mockRestore();
            await gate;
            return realRead(pathId, start, end);
        });
        const drainP = mount.reindexQueue!.drain();

        // The write lands mid-extract, and the extract completes INSIDE the write's
        // ancestor-invalidation await — after the bit was set, before the write returns.
        const realInvalidate = mount.invalidateAncestorsOf.bind(mount);
        const invalidateSpy = spyOn(mount, 'invalidateAncestorsOf').mockImplementation(async (pathId) => {
            invalidateSpy.mockRestore();
            await realInvalidate(pathId);
            release();
            await drainP;
        });
        try {
            await mount.writeFile(uploaded.id, Buffer.from('genracefresh body'));
        } finally {
            invalidateSpy.mockRestore();
            readSpy.mockRestore();
        }

        const [row] = mount.db.all(sql`SELECT contentDirty FROM paths WHERE id = ${uploaded.id}`) as {
            contentDirty: number;
        }[];
        expect(row.contentDirty).toBe(1);
    });
});
