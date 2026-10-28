import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { getHome } from '../../lib/home/get-home';
import { authedRequest, createTestUserOnStorage, driveGet, drivePost, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;
const MOUNT = 'default';

// Drive.create appends the type's extension before the mount validates the name, so the stem needs its
// own gate: an empty stem would otherwise land as a bare `.eigendoc` dotfile that renders nameless and
// that the rename route refuses to produce. Same rule the chat rooms route already enforces by hand.
describe('Drive.create stem validation', () => {
    let ctx: TestCtx;
    let folderId: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        const rootId = (await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, MOUNT, 'root')).id;
        const folder = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            MOUNT,
            `folder/${rootId}`,
            { folderName: `create-name-${crypto.randomUUID()}` },
        );
        folderId = folder.id;
    });

    async function create(fileName: string): Promise<Response> {
        return authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${MOUNT}/folder/${folderId}/create/doc`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileName }),
            },
        );
    }

    test('rejects the stems the rename route rejects, before any row is written', async () => {
        for (const stem of ['', '.', '..', 'a/b', `x${String.fromCharCode(0)}y`, '.Trash']) {
            const res = await create(stem);
            expect(res.status).toBe(400);
        }
        const children = await driveGet<DrivePath[]>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            MOUNT,
            `folder/${folderId}`,
        );
        expect(children).toEqual([]);
    });

    test('stores the stem NFC-normalized, matching the rename route', async () => {
        const res = await create('café'.normalize('NFD'));
        expect(res.status).toBe(200);
        const created = (await res.json()) as DrivePath;
        expect(created.name).toBe('café.eigendoc');
    });
});

// On `local` the disk folds more than lower case does, such as ß onto ss. An upload's unique name must
// skip a suffix whose fold is taken, or the mount refuses the name it picked.
describe('an upload beside a name the disk folds alike', () => {
    test('gets the next free suffix instead of a 409', async () => {
        const user = await createTestUserOnStorage('local-fullnames', 'Fold Upload');
        const home = await getHome(user.id);
        const [mount] = home.drive.getMounts();
        const root = await home.drive.getRootFolder(mount.id);
        if (!root) throw new Error('no root');
        const upload = (name: string) =>
            home.drive.createFileFromData(mount.id, root.id, name, 'text/plain', Buffer.from(name));
        await upload('Straße.txt');
        await upload('STRASSE (2).txt');

        expect((await upload('Straße.txt')).name).toBe('Straße (3).txt');
    });
});
