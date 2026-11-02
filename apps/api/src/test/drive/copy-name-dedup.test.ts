import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { authedRequest, driveGet, drivePost, driveUpload, getTestContext } from '../setup';

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

    // Both copies read the target folder before either one creates, so both pick the same free name.
    // The loser has to pick again instead of answering 409.
    test('two same-named files copied into one folder at once both land, with distinct names', async () => {
        const token = ctx.alice.user.sessionToken;
        const ownerId = ctx.alice.user.id;
        const sources: DrivePath[] = [];
        for (const folderName of ['race-a', 'race-b']) {
            const folder = await drivePost<DrivePath>(token, ownerId, MOUNT, `folder/${folderId}`, { folderName });
            sources.push(await driveUpload(token, ownerId, MOUNT, folder.id, new File([folderName], 'same.txt')));
        }
        const target = await drivePost<DrivePath>(token, ownerId, MOUNT, `folder/${folderId}`, {
            folderName: 'race-target',
        });

        for (let round = 0; round < 3; round++) {
            const responses = await Promise.all(
                sources.map((source) =>
                    authedRequest(token, `/drive/${ownerId}/${MOUNT}/path/${source.id}/copy`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            targetOwnerId: ownerId,
                            targetMountId: MOUNT,
                            targetParentId: target.id,
                        }),
                    }),
                ),
            );
            expect(responses.map((res) => res.status)).toEqual([200, 200]);
        }
        const names = (await driveGet<DrivePath[]>(token, ownerId, MOUNT, `folder/${target.id}`)).map((p) => p.name);
        expect(names).toHaveLength(6);
        expect(new Set(names).size).toBe(6);
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
