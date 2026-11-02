import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { authedRequest, driveGet, drivePost, drivePut, driveUpload, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
const MOUNT = 'default';

describe('copy route name dedup', () => {
    let ctx: TestCtx;
    let folderId: string;
    let fileId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const rootId = (await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, MOUNT, 'root')).id;
        const folder = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            MOUNT,
            `folder/${rootId}`,
            { folderName: `copy-dedup-${crypto.randomUUID()}` },
        );
        folderId = folder.id;
        const src = await driveUpload(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            MOUNT,
            folderId,
            new File(['x'], 'src.txt'),
        );
        fileId = src.id;
    });

    async function copy(name: string): Promise<Response> {
        return authedRequest(ctx.alice.user.sessionToken, `/drive/${ctx.alice.user.id}/${MOUNT}/path/${fileId}/copy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                targetOwnerId: ctx.alice.user.id,
                targetMountId: MOUNT,
                targetParentId: folderId,
                name,
            }),
        });
    }

    // The store keeps names NFC (validateName); the dedup compare has to see the requested name in the
    // same form, or a decomposed spelling of an existing sibling 409s instead of getting its " (2)".
    test('a decomposed (NFD) spelling of an existing NFC sibling dedups instead of 409ing', async () => {
        expect((await copy('café.txt')).status).toBe(200);
        const res = await copy('café.txt'.normalize('NFD'));
        expect(res.status).toBe(200);
        expect(((await res.json()) as DrivePath).name).toBe('café (2).txt');
    });

    // Eight same-named sources, each in a folder of its own.
    async function sameNamedSources(): Promise<DrivePath[]> {
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;
        return Promise.all(
            Array.from({ length: 8 }, async (_, n) => {
                const folder = await drivePost<DrivePath>(token, ownerId, MOUNT, `folder/${folderId}`, {
                    folderName: `race-${crypto.randomUUID()}`,
                });
                return driveUpload(token, ownerId, MOUNT, folder.id, new File([`${n}`], 'same.txt'));
            }),
        );
    }

    function copyInto(source: DrivePath, targetOwnerId: string, targetParentId: string): Promise<Response> {
        return authedRequest(ctx.alice.user.sessionToken, `/drive/${source.ownerId}/${MOUNT}/path/${source.id}/copy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetOwnerId, targetMountId: MOUNT, targetParentId }),
        });
    }

    // The names a burst of eight same-named copies lands under, after `start - 1` of them already exist.
    function landedNames(start: number): string[] {
        return Array.from({ length: 8 }, (_, i) => (start + i === 1 ? 'same.txt' : `same (${start + i}).txt`));
    }

    // Every copy reads the target folder before any one of them creates, so each must still get its own name.
    // The second burst lands beside the first one's copies, so it reads the folder too.
    test('eight same-named files copied into one folder at once all land, with distinct names', async () => {
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;
        const sources = await sameNamedSources();
        const target = await drivePost<DrivePath>(token, ownerId, MOUNT, `folder/${folderId}`, {
            folderName: 'race-target',
        });

        for (let round = 0; round < 2; round++) {
            const responses = await Promise.all(sources.map((source) => copyInto(source, ownerId, target.id)));
            expect(responses.map((res) => res.status)).toEqual(Array(8).fill(200));
        }
        const names = (await driveGet<DrivePath[]>(token, ownerId, MOUNT, `folder/${target.id}`)).map((p) => p.name);
        expect(names.toSorted()).toEqual([...landedNames(1), ...landedNames(9)].toSorted());
    });

    // A file copied to another drive is uploaded there, and the upload picks its free name.
    test('eight same-named files copied into a folder on another drive at once all land, with distinct names', async () => {
        const bob = ctx.bob.user;
        const bobRoot = await driveGet<DrivePath>(bob.sessionToken, bob.id, MOUNT, 'root');
        const target = await drivePost<DrivePath>(bob.sessionToken, bob.id, MOUNT, `folder/${bobRoot.id}`, {
            folderName: `race-shared-${crypto.randomUUID()}`,
        });
        await drivePut(bob.sessionToken, bob.id, MOUNT, `path/${target.id}/acl`, {
            add: [{ id: ctx.alice.user.email, read: true, write: true }],
        });
        const sources = await sameNamedSources();

        const responses = await Promise.all(sources.map((source) => copyInto(source, bob.id, target.id)));
        expect(responses.map((res) => res.status)).toEqual(Array(8).fill(200));
        const names = (await driveGet<DrivePath[]>(bob.sessionToken, bob.id, MOUNT, `folder/${target.id}`)).map(
            (p) => p.name,
        );
        expect(names.toSorted()).toEqual(landedNames(1).toSorted());
    });

    // A copy needs read on the folder it lands in, wherever its source lives, the same as before copies
    // picked their names in flight.
    test('a folder shared write-only refuses a copy from the same drive and from another one', async () => {
        const bob = ctx.bob.user;
        const bobRoot = await driveGet<DrivePath>(bob.sessionToken, bob.id, MOUNT, 'root');
        const shareFolder = async (read: boolean, write: boolean): Promise<DrivePath> => {
            const folder = await drivePost<DrivePath>(bob.sessionToken, bob.id, MOUNT, `folder/${bobRoot.id}`, {
                folderName: `acl-${crypto.randomUUID()}`,
            });
            await drivePut(bob.sessionToken, bob.id, MOUNT, `path/${folder.id}/acl`, {
                add: [{ id: ctx.alice.user.email, read, write }],
            });
            return folder;
        };
        const target = await shareFolder(false, true);
        const readable = await shareFolder(true, false);
        const bobFile = await driveUpload(bob.sessionToken, bob.id, MOUNT, readable.id, new File(['b'], 'bob.txt'));
        const aliceFile = await driveUpload(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            MOUNT,
            folderId,
            new File(['a'], 'alice.txt'),
        );

        const sameDrive = await copyInto(bobFile, bob.id, target.id);
        const otherDrive = await copyInto(aliceFile, bob.id, target.id);
        expect([sameDrive.status, otherDrive.status]).toEqual([403, 403]);
    });

    // A name already at the 255-byte limit still gets a copy: the dedup suffix trims the stem to fit.
    test('a max-length name copied next to itself gets a suffix that still fits 255 bytes', async () => {
        const long = `${'y'.repeat(251)}.txt`;
        expect((await copy(long)).status).toBe(200);
        const res = await copy(long);
        expect(res.status).toBe(200);
        const name = ((await res.json()) as DrivePath).name;
        expect(name.endsWith(' (2).txt')).toBe(true);
        expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(255);
    });
});
