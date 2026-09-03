import { beforeAll, describe, expect, test } from 'bun:test';
import { ApiError, type DatabaseConfig, type SchemaType } from '../../lib/core';
import SharedDrive from '../../lib/drive/sharedDrive';
import { getHome } from '../../lib/home';
import { getUserById, type User } from '../../lib/user';
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
        getUserMemberships: { gate: 'private-helper', reason: 'membership lookup feeding the gates' },
        withReadPermission: { gate: 'private-helper', reason: 'the read gate itself' },
        withWritePermission: { gate: 'private-helper', reason: 'the write gate itself' },
        withParentWritePermission: { gate: 'private-helper', reason: 'the rename gate (write on parent)' },
        requireTeamMembership: { gate: 'private-helper', reason: 'the drive-wide listing gate' },
        isEffectiveOwnerSync: { gate: 'private-helper', reason: 'team co-owner check feeding the gates' },

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
        unwatchPath: {
            gate: 'ungated-by-design',
            reason: "removing one's own watch must work after a share is revoked",
            call: (sd) => sd.unwatchPath(mountId, fileId, charlie),
        },
        getWatchStatus: {
            gate: 'ungated-by-design',
            reason: "reads only the caller's own watch rows",
            call: async (sd) => expect((await sd.getWatchStatus(mountId, fileId, charlie)).direct).toBe(false),
        },
        getWatches: {
            gate: 'ungated-by-design',
            // Pins no-throw + empty-for-a-stranger only; the read-revoke filtering itself is
            // pinned by file-watch.test.ts (a stranger has no rows either way).
            reason: 'per-caller listing; safe to call with no permissions',
            call: async (sd) => {
                const paths = await sd.getWatches(charlie);
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
            gate: 'denies',
            reason: 'read-gated once the path string resolves',
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
        openDatabase: {
            gate: 'denies',
            reason: 'read-gated (opening a container db reads it)',
            call: (sd) => sd.openDatabase(mountId, probeDbConfig, docId),
        },
        listVersions: { gate: 'denies', reason: 'read-gated', call: (sd) => sd.listVersions(mountId, docId) },
        getFileHistory: { gate: 'denies', reason: 'read-gated', call: (sd) => sd.getFileHistory(mountId, fileId) },
        watchPath: { gate: 'denies', reason: 'read-gated', call: (sd) => sd.watchPath(mountId, fileId, charlie) },

        // Write-gated.
        copyPath: {
            gate: 'denies',
            reason: 'read-gated on source, write-gated on target',
            call: (sd) => sd.copyPath(mountId, fileId, folderId, 'copy.txt'),
        },
        writeFileContent: {
            gate: 'denies',
            reason: 'write-gated',
            call: (sd) => sd.writeFileContent(mountId, fileId, Buffer.from('x')),
        },
        createFolder: {
            gate: 'denies',
            reason: 'write-gated on the parent',
            call: (sd) => sd.createFolder(mountId, folderId, 'intruder'),
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
        emailCollaborators: {
            gate: 'denies',
            reason: 'write-gated',
            call: (sd) =>
                sd.emailCollaborators(mountId, fileId, null, 'hi', false, { name: 'C', email: charlie.email }),
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
                    details: { card: 'x', toColumn: 'y' },
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
});
