import { beforeAll, describe, expect, test } from 'bun:test';
import type { DatabaseConfig, SchemaType } from '../../lib/core';
import { ApiError } from '../../lib/core';
import { SharedDrive } from '../../lib/drive/shared-drive';
import { getHome } from '../../lib/home';
import type { User } from '../../lib/user';
import { getUserById } from '../../lib/user';
import { driveGet, drivePost, driveUpload, getTestContext } from '../setup';

type TestCtx = Awaited<ReturnType<typeof getTestContext>>;

// Every SharedDrive prototype member must appear in the classification map below. The
// exhaustiveness test fails when a method ships unclassified, forcing every new Drive/
// SharedDrive method to make an explicit ACL decision here before it lands.
type Gate =
    | 'denies' // stranger gets ApiError 403 — the default for anything path/ACL-scoped
    | 'denies-null' // ACL-checked inside, denies by returning null instead of throwing
    | 'denies-empty' // self-filtering: stranger gets an empty array, never a leak
    | 'returns-false' // permission predicate — the honest answer for a stranger IS false
    | 'ungated-by-design' // documented as safe without a gate; must not throw for a stranger
    | 'private-helper'; // TS-private (runtime-visible on the prototype), unreachable from routes

type Entry = { gate: Gate; reason: string; call?: (sd: SharedDrive) => Promise<unknown> };

describe('SharedDrive gating enumeration', () => {
    let ctx: TestCtx;
    let sd: SharedDrive; // alice's drive wrapped for charlie — a stranger with no ACL anywhere
    let charlie: User;
    let mountId: string;
    let folderId: string;
    let fileId: string;
    let docId: string;

    const probeDbConfig: DatabaseConfig<SchemaType> = {
        name: 'gating-probe',
        currentVersion: 0,
        schema: {},
        migrations: [],
    };

    beforeAll(async () => {
        ctx = await getTestContext();
        const { data: mounts } = await ctx.alice.api.drive({ ownerId: ctx.alice.user.id }).mounts.get();
        mountId = mounts![0].id;
        const token = ctx.alice.user.sessionToken;
        const aliceId = ctx.alice.user.id;
        const root = await driveGet(token, aliceId, mountId, 'root');
        const folder = await drivePost(token, aliceId, mountId, `folder/${root.id}`, { folderName: 'Gating Probe' });
        folderId = folder.id;
        const file = await driveUpload(
            token,
            aliceId,
            mountId,
            folderId,
            new File(['secret'], 'secret.txt', { type: 'text/plain' }),
        );
        fileId = file.id;
        const doc = await drivePost(token, aliceId, mountId, `folder/${folderId}/create/doc`, {
            fileName: 'Gating Doc',
        });
        docId = doc.id;

        const charlieUser = await getUserById(ctx.charlie.user.id);
        if (!charlieUser) throw new Error('charlie user not found');
        charlie = charlieUser;
        sd = new SharedDrive(await getHome(aliceId), charlie);
    });

    const classification: Record<string, Entry> = {
        // TS-private helpers — on the prototype at runtime, not callable from routes.
        requireRead: { gate: 'private-helper', reason: 'the read gate itself' },
        requireWrite: { gate: 'private-helper', reason: 'the write gate itself' },
        requireDriveOwner: { gate: 'private-helper', reason: 'the drive-wide listing and trash gate' },
        requireMove: { gate: 'private-helper', reason: 'the write gates of a move, on source and target' },
        isEffectiveOwner: { gate: 'private-helper', reason: 'team co-owner check feeding the gates' },
        sharingRestrictedFor: { gate: 'private-helper', reason: 'the sharingRestricted gate for ACL changes' },

        // Drive-wide listings — gated on team membership of the owner; alice is a user, so 403.
        listMounts: { gate: 'denies', reason: 'team-membership gated', call: (sd) => sd.listMounts() },
        getMimeTypeContents: {
            gate: 'denies',
            reason: 'team-membership gated',
            call: (sd) => sd.getMimeTypeContents('application/eigendoc'),
        },
        getMountMimeTypeContents: {
            gate: 'denies',
            reason: 'team-membership gated',
            call: (sd) => sd.getMountMimeTypeContents(mountId, 'application/eigendoc'),
        },

        // Permission predicates — asking IS the point; the stranger's answer is false.
        canRead: {
            gate: 'returns-false',
            reason: 'permission predicate',
            call: (sd) => sd.canRead(mountId, fileId, charlie),
        },
        canWrite: {
            gate: 'returns-false',
            reason: 'permission predicate',
            call: (sd) => sd.canWrite(mountId, fileId, charlie),
        },

        // Deny-by-shape rather than throw — routes treat the result as absent/filtered.
        getRootFolder: {
            gate: 'denies-null',
            reason: 'ACL-checked, denies by returning null',
            call: (sd) => sd.getRootFolder(mountId),
        },
        breadCrumb: {
            gate: 'denies-empty',
            reason: 'returns only the readable suffix of the chain — [] for a stranger',
            call: (sd) => sd.breadCrumb(mountId, fileId),
        },

        // Ungated by design — must keep working after a share is revoked / are self-filtering.
        lockManager: {
            gate: 'ungated-by-design',
            reason: 'lock state is per-user; path ACL already checked in the WebDAV route',
            call: async (sd) => expect(sd.lockManager).toBeDefined(),
        },
        holdHome: {
            gate: 'ungated-by-design',
            reason: 'lifecycle only, no data; getSharedDrive has already opened that Home',
            call: async (sd) => sd.holdHome()(),
        },
        withHomeHeld: {
            gate: 'ungated-by-design',
            reason: 'lifecycle only, no data; getSharedDrive has already opened that Home',
            call: (sd) => sd.withHomeHeld(async () => {}),
        },
        unwatchPath: {
            gate: 'ungated-by-design',
            reason: "removing one's own watch must work after a share is revoked",
            call: (sd) => sd.unwatchPath(mountId, fileId),
        },
        getWatchStatus: {
            gate: 'ungated-by-design',
            reason: "reads only the caller's own watch rows",
            call: async (sd) => expect((await sd.getWatchStatus(mountId, fileId)).direct).toBe(false),
        },
        getWatches: {
            gate: 'ungated-by-design',
            // Pins no-throw + empty-for-a-stranger only; the read-revoke filtering itself is
            // pinned by file-watch.test.ts (a stranger has no rows either way).
            reason: 'per-caller listing; safe to call with no permissions',
            call: async (sd) => {
                const paths = await sd.getWatches();
                expect(paths.map((p) => p.id)).not.toContain(fileId);
            },
        },
        getSharedWith: {
            gate: 'ungated-by-design',
            // Same scope note as getWatches: stranger-safety pin, not a filtering pin.
            reason: 'per-caller listing; safe to call with no permissions',
            call: async (sd) => {
                const paths = await sd.getSharedWith(charlie);
                expect(paths.map((p) => p.id)).not.toContain(fileId);
            },
        },

        // Read-gated.
        getFolderContents: {
            gate: 'denies',
            reason: 'read-gated',
            call: (sd) => sd.getFolderContents(mountId, folderId),
        },
        getPath: { gate: 'denies', reason: 'read-gated', call: (sd) => sd.getPath(mountId, fileId) },
        resolvePath: {
            gate: 'denies-null',
            reason: 'an unreadable path resolves like a missing one, so no name leaks',
            call: (sd) => sd.resolvePath(mountId, 'Gating Probe/secret.txt'),
        },
        downloadFile: { gate: 'denies', reason: 'read-gated', call: (sd) => sd.downloadFile(mountId, fileId) },
        flushContainerDb: { gate: 'denies', reason: 'read-gated', call: (sd) => sd.flushContainerDb(mountId, docId) },
        readRange: { gate: 'denies', reason: 'read-gated', call: (sd) => sd.readRange(mountId, fileId, 0, 1) },
        resolveFile: { gate: 'denies', reason: 'read-gated', call: (sd) => sd.resolveFile(mountId, fileId) },
        getCollabDocument: { gate: 'denies', reason: 'read-gated', call: (sd) => sd.getCollabDocument(mountId, docId) },
        getChat: { gate: 'denies', reason: 'read-gated', call: (sd) => sd.getChat(mountId, docId) },
        getChildByName: {
            gate: 'denies',
            reason: 'read-gated on the parent',
            call: (sd) => sd.getChildByName(mountId, folderId, 'secret.txt'),
        },
        getEffectiveMembers: {
            gate: 'denies',
            reason: 'read-gated',
            call: (sd) => sd.getEffectiveMembers(mountId, fileId),
        },
        checkAccessForEmails: {
            gate: 'denies',
            reason: 'read-gated (403 unless the caller can read the path)',
            call: (sd) => sd.checkAccessForEmails(mountId, fileId, ['probe@example.com']),
        },
        withDatabase: {
            gate: 'denies',
            reason: 'read-gated (opening a container db reads it)',
            call: (sd) => sd.withDatabase(mountId, probeDbConfig, docId, async () => {}),
        },
        listVersions: { gate: 'denies', reason: 'read-gated', call: (sd) => sd.listVersions(mountId, docId) },
        getFileHistory: { gate: 'denies', reason: 'read-gated', call: (sd) => sd.getFileHistory(mountId, fileId) },
        watchPath: { gate: 'denies', reason: 'read-gated', call: (sd) => sd.watchPath(mountId, fileId) },

        // Write-gated.
        copyPath: {
            gate: 'denies',
            reason: 'read-gated on source, write-gated on target',
            call: (sd) => sd.copyPath(mountId, fileId, { drive: sd, mountId, parentId: folderId }, 'copy.txt', charlie),
        },
        copyPathOver: {
            gate: 'denies',
            reason: 'read-gated on source, write-gated on target',
            call: (sd) => sd.copyPathOver(mountId, fileId, folderId, 'copy.txt', charlie),
        },
        writeFileContent: {
            gate: 'denies',
            reason: 'write-gated',
            call: (sd) => sd.writeFileContent(mountId, fileId, Buffer.from('x'), { user: charlie }),
        },
        createFolder: {
            gate: 'denies',
            reason: 'write-gated on the parent',
            call: (sd) => sd.createFolder(mountId, folderId, 'intruder', charlie),
        },
        uploadFiles: {
            gate: 'denies',
            reason: 'write-gated on the parent, before the body is parsed',
            call: (sd) =>
                sd.uploadFiles(
                    mountId,
                    folderId,
                    new Request('http://localhost/x', { method: 'POST', body: 'x' }),
                    1024,
                ),
        },
        createFileFromData: {
            gate: 'denies',
            reason: 'write-gated on the parent',
            call: (sd) => sd.createFileFromData(mountId, folderId, 'intruder.txt', 'text/plain', Buffer.from('x')),
        },
        create: {
            gate: 'denies',
            reason: 'write-gated on the parent',
            call: (sd) => sd.create(mountId, folderId, 'intruder', 'doc'),
        },
        receiveCopy: {
            gate: 'denies',
            reason: 'write-gated on the destination folder',
            call: async (sd) => {
                const { drive } = await getHome(ctx.alice.user.id);
                const { mount, path } = await drive.resolveFile(mountId, fileId);
                return sd.receiveCopy(mountId, folderId, mount, path, 'intruder.txt', charlie);
            },
        },
        emailCollaborators: {
            gate: 'denies',
            reason: 'write-gated',
            call: (sd) => sd.emailCollaborators(mountId, fileId, null, 'hi', false),
        },
        inviteToChat: {
            gate: 'denies',
            reason: 'write-gated',
            call: (sd) => sd.inviteToChat(mountId, docId, charlie.email),
        },
        updateACLDelta: {
            gate: 'denies',
            reason: 'write-gated (blocks self-escalation)',
            call: (sd) => sd.updateACLDelta(mountId, fileId, { add: [{ id: charlie.email, read: true, write: true }] }),
        },
        deletePath: { gate: 'denies', reason: 'write-gated', call: (sd) => sd.deletePath(mountId, fileId) },
        releaseLocksUnder: {
            gate: 'denies',
            reason: 'write-gated: it drops the locks of other users',
            call: (sd) => sd.releaseLocksUnder(mountId, fileId),
        },
        ancestorIds: {
            gate: 'denies',
            reason: 'read-gated on the path: it gives the ids of every folder above it',
            call: (sd) => sd.ancestorIds(mountId, fileId),
        },
        descendantIds: {
            gate: 'denies',
            reason: 'read-gated: it names every path under a folder',
            call: (sd) => sd.descendantIds(mountId, folderId),
        },
        renamePath: {
            gate: 'denies',
            reason: 'write-gated on the parent',
            call: (sd) => sd.renamePath(mountId, fileId, 'renamed.txt'),
        },
        movePath: {
            gate: 'denies',
            reason: 'write-gated on source and target',
            call: (sd) => sd.movePath(mountId, fileId, folderId),
        },
        movePathOver: {
            gate: 'denies',
            reason: 'write-gated on source and target',
            call: (sd) => sd.movePathOver(mountId, fileId, folderId, 'moved.txt', charlie),
        },
        saveVersion: { gate: 'denies', reason: 'write-gated', call: (sd) => sd.saveVersion(mountId, docId) },
        restoreContainer: {
            gate: 'denies',
            reason: 'write-gated',
            call: (sd) => sd.restoreContainer(mountId, docId, '2026-01-01T00:00:00.000Z.db'),
        },
        recordClientFileEvent: {
            gate: 'denies',
            reason: 'write-gated',
            call: (sd) =>
                sd.recordClientFileEvent(mountId, docId, charlie, {
                    eventType: 'sticky-added',
                    details: { card: 'x', toColumn: 'y', cardId: 'c' },
                }),
        },
        assignComment: {
            gate: 'denies',
            reason: 'write-gated',
            call: (sd) => sd.assignComment(mountId, docId, 'x.eigenchat', charlie.email, charlie),
        },
        setCommentStatus: {
            gate: 'denies',
            reason: 'write-gated',
            call: (sd) => sd.setCommentStatus(mountId, docId, 'x.eigenchat', 'resolved', charlie),
        },
        updatePathDetails: {
            gate: 'denies',
            reason: 'write-gated',
            call: (sd) => sd.updatePathDetails(mountId, fileId, { originalName: 'x' }),
        },

        // Owner-only (trash surface).
        restorePath: { gate: 'denies', reason: 'owner-only', call: (sd) => sd.restorePath(mountId, fileId) },
        listTrash: { gate: 'denies', reason: 'owner-only', call: (sd) => sd.listTrash(mountId) },
        permanentlyDelete: {
            gate: 'denies',
            reason: 'owner-only',
            call: (sd) => sd.permanentlyDelete(mountId, fileId),
        },
        emptyTrash: { gate: 'denies', reason: 'owner-only', call: (sd) => sd.emptyTrash(mountId) },
        deleteVersions: { gate: 'denies', reason: 'owner-only', call: (sd) => sd.deleteVersions(mountId, docId) },
    };

    test('every SharedDrive prototype member is classified', () => {
        const members = Object.getOwnPropertyNames(SharedDrive.prototype).filter((n) => n !== 'constructor');
        expect(members.toSorted()).toEqual(Object.keys(classification).toSorted());
    });

    for (const [name, entry] of Object.entries(classification)) {
        if (entry.gate === 'private-helper') continue;
        test(`${name} — ${entry.gate}`, async () => {
            const call = entry.call;
            if (!call) throw new Error(`classification for ${name} needs a call`);
            switch (entry.gate) {
                case 'denies': {
                    const err = await call(sd).then(
                        () => null,
                        (e: unknown) => e,
                    );
                    expect(err).toBeInstanceOf(ApiError);
                    expect((err as ApiError).status).toBe(403);
                    break;
                }
                case 'denies-null':
                    expect(await call(sd)).toBeNull();
                    break;
                case 'denies-empty':
                    expect(await call(sd)).toEqual([]);
                    break;
                case 'returns-false':
                    expect(await call(sd)).toBe(false);
                    break;
                case 'ungated-by-design':
                    await call(sd); // must not throw for a stranger
                    break;
            }
        });
    }

    const refusal = (call: Promise<unknown>): Promise<unknown> =>
        call.then(
            () => null,
            (e: unknown) => (e instanceof ApiError ? `${e.status} ${e.message}` : e),
        );

    test('a copy into a folder the caller may only read is a 403 and writes nothing', async () => {
        const home = await getHome(ctx.alice.user.id);
        const bob = await getUserById(ctx.bob.user.id);
        if (!bob) throw new Error('bob user not found');
        const folder = await home.drive.createFolder(mountId, folderId, 'Read Only Probe', home.user);
        const file = await home.drive.createFileFromData(
            mountId,
            folder.id,
            'readable.txt',
            'text/plain',
            Buffer.from('x'),
            home.user,
        );
        const share = { add: [{ id: bob.email, read: true, write: false }] };
        await home.drive.updateACLDelta(mountId, folder.id, share, undefined, undefined, home.user);
        const reader = new SharedDrive(home, bob);
        expect((await reader.resolveFile(mountId, file.id)).path.id).toBe(file.id);

        const to = { drive: reader, mountId, parentId: folder.id };
        expect(await refusal(reader.copyPath(mountId, file.id, to, 'copy.txt', bob))).toBe(
            '403 No write permission on target folder',
        );
        expect(await refusal(reader.copyPathOver(mountId, file.id, folder.id, 'copy.txt', bob))).toBe(
            '403 No write permission on target folder',
        );
        expect((await home.drive.getFolderContents(mountId, folder.id)).map((path) => path.name)).toEqual([
            'readable.txt',
        ]);
    });

    test('a copy of a path the caller may not read into their own drive is a 403 and writes nothing', async () => {
        const { drive } = await getHome(charlie.id);
        const [mount] = drive.getMounts();
        const root = mount ? await mount.getRootFolder() : null;
        if (!mount || !root) throw new Error('charlie has no drive');

        const to = { drive, mountId: mount.id, parentId: root.id };
        expect(await refusal(sd.copyPath(mountId, fileId, to, 'stolen.txt', charlie))).toBe(
            '403 No read permission on source',
        );
        expect(await drive.getChildByName(mount.id, root.id, 'stolen.txt')).toBeNull();
    });
});
