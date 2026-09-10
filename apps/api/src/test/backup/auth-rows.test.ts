import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BackupManifest } from '@workspace/lib/types/backup';
import { eq } from 'drizzle-orm';
import {
    apikey as apikeyScheme,
    member as memberScheme,
    twoFactor as twoFactorScheme,
    user as userScheme,
} from '../../../auth-schema';
import { auth, getAuthDrizzleDb } from '../../lib/auth/auth';
import { packFolder } from '../../lib/backup/archive';
import { buildArtifactName, buildHomeFolderName, getBackupsDir } from '../../lib/backup/paths';
import { restoreHome } from '../../lib/backup/restore';
import { snapshotHome } from '../../lib/backup/snapshot-home';
import { getServerConfig } from '../../lib/config/server-config';
import { getHome } from '../../lib/home/get-home';
import { authedRequest, getTestContext, TEST_DATA_DIR } from '../setup';

// `auth.json` is the one part of an archive that writes to users3.db, and an archive is a file an
// admin uploaded. Every row used to go in as it stood: a planted `member` row with the public org id
// and role `owner` made its user an instance admin, and a planted `user` row gave them an account to
// sign in with. A restore puts one home's identity back and nothing else.

const PASSWORD = 'testpassword123';
const PLANTED_ID = 'plantedattackerrowAAAAAAAAAAAAAA';

type TestUser = { id: string; email: string; sessionToken: string };

async function createUser(email: string, name: string): Promise<TestUser> {
    const signUp = await auth.api.signUpEmail({ body: { email, password: PASSWORD, name } });
    const signIn = await auth.api.signInEmail({ returnHeaders: true, body: { email, password: PASSWORD } });
    const match = (signIn.headers.get('set-cookie') || '').match(/better-auth\.session_token=([^;]+)/);
    if (!match) throw new Error(`no session cookie for ${email}`);
    return { id: signUp.user.id, email, sessionToken: match[1] };
}

// One artifact of the home as it stands, with `auth.json` doctored the way an uploaded archive can
// be. Its manifest entry is restated so the transport stage passes and the rows themselves are what
// the restore has to judge.
async function backupWithAuthRows(
    userId: string,
    at: Date,
    patch?: (rows: Record<string, Record<string, unknown>[]>) => void,
): Promise<string> {
    const staging = mkdtempSync(join(TEST_DATA_DIR, 'auth-rows-'));
    const manifest: BackupManifest = await snapshotHome(await getHome(userId), staging);
    const folder = join(staging, buildHomeFolderName(userId));
    if (patch) {
        const authPath = join(folder, 'auth.json');
        const rows = JSON.parse(readFileSync(authPath, 'utf8'));
        patch(rows);
        writeFileSync(authPath, JSON.stringify(rows, null, 2));
        const entry = manifest.entries.find((candidate) => candidate.path === 'auth.json');
        if (!entry) throw new Error('auth.json is not in the manifest');
        const hasher = new Bun.CryptoHasher('sha256');
        hasher.update(new Uint8Array(await Bun.file(authPath).arrayBuffer()));
        entry.bytes = Bun.file(authPath).size;
        entry.sha256 = hasher.digest('hex');
        writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }
    const name = buildArtifactName(userId, at);
    await packFolder(folder, join(getBackupsDir(), name));
    rmSync(staging, { recursive: true, force: true });
    return name;
}

describe('Backup restore of the identity an archive carries', () => {
    let admin: string;
    let owner: TestUser;
    let apiKeyId: string;
    let twoFactorId: string;
    let orgId: string;

    async function deleteOwner(): Promise<void> {
        const res = await authedRequest(admin, `/settings/user/${owner.id}`, { method: 'DELETE' });
        expect(res.status).toBe(200);
        expect(getAuthDrizzleDb().select().from(userScheme).where(eq(userScheme.id, owner.id)).all()).toEqual([]);
    }

    beforeAll(async () => {
        const ctx = await getTestContext();
        admin = ctx.alice.user.sessionToken;
        orgId = getServerConfig()!.orgId;
        owner = await createUser('backup-authrows@test.eigen.is', 'Backup Auth Rows');
        await authedRequest(owner.sessionToken, `/drive/${owner.id}/mounts`);
        apiKeyId = (await auth.api.createApiKey({
            body: { name: 'auth-rows-app-password' },
            headers: { cookie: `better-auth.session_token=${owner.sessionToken}` },
        }))!.id;
        twoFactorId = `auth-rows-2fa-${Date.now()}`;
        getAuthDrizzleDb()
            .insert(twoFactorScheme)
            .values({ id: twoFactorId, secret: 'seeded', backupCodes: 'seeded', userId: owner.id })
            .run();
    });

    test('a planted user, account and owner membership are dropped, the owner comes back', async () => {
        const artifact = await backupWithAuthRows(owner.id, new Date(), (rows) => {
            const [ownerRow] = rows['user'];
            // A user row of somebody else entirely, with an account to sign in with.
            rows['user'].push({ ...ownerRow, id: PLANTED_ID, email: 'planted@test.eigen.is' });
            rows['account'].push({ ...rows['account'][0], id: `${PLANTED_ID}-account`, userId: PLANTED_ID });
            // The escalation: the public org, role owner — what requireAdmin reads.
            rows['member'].push({
                id: `${PLANTED_ID}-member`,
                organizationId: orgId,
                userId: PLANTED_ID,
                role: 'owner',
                createdAt: new Date().toISOString(),
            });
            // And the same for the archive's own user, from both directions.
            ownerRow['role'] = 'admin';
            for (const row of rows['member']) if (row['userId'] === owner.id) row['role'] = 'owner';
        });

        await deleteOwner();
        await restoreHome(artifact, owner.id, `auth-rows-planted-${Date.now()}`);
        rmSync(join(getBackupsDir(), artifact), { force: true });

        const db = getAuthDrizzleDb();
        expect(db.select().from(userScheme).where(eq(userScheme.id, PLANTED_ID)).all()).toEqual([]);
        expect(db.select().from(memberScheme).where(eq(memberScheme.userId, PLANTED_ID)).all()).toEqual([]);

        // The owner is back, as a plain member of this server's own organization.
        const restored = db.select().from(userScheme).where(eq(userScheme.id, owner.id)).all();
        expect(restored.length).toBe(1);
        expect(restored[0].role).toBe('user');
        const memberships = db.select().from(memberScheme).where(eq(memberScheme.userId, owner.id)).all();
        expect(memberships.length).toBe(1);
        expect(memberships[0].organizationId).toBe(orgId);
        expect(memberships[0].role).toBe('member');
    });

    test('the owner keeps their sign-in, app password and second factor', async () => {
        const db = getAuthDrizzleDb();
        expect(db.select().from(apikeyScheme).where(eq(apikeyScheme.id, apiKeyId)).all().length).toBe(1);
        expect(db.select().from(twoFactorScheme).where(eq(twoFactorScheme.id, twoFactorId)).all().length).toBe(1);

        const signIn = await auth.api.signInEmail({
            returnHeaders: true,
            body: { email: owner.email, password: PASSWORD },
        });
        expect(signIn.headers.get('set-cookie')).toContain('better-auth.session_token=');
    });

    test('an archive whose user row is not this owner is refused and inserts nothing', async () => {
        const stranger = await createUser('backup-authrows-stranger@test.eigen.is', 'Auth Rows Stranger');
        await authedRequest(stranger.sessionToken, `/drive/${stranger.id}/mounts`);
        const artifact = await backupWithAuthRows(stranger.id, new Date(), (rows) => {
            rows['user'] = [{ ...rows['user'][0], id: PLANTED_ID, email: 'planted-only@test.eigen.is' }];
        });

        const res = await authedRequest(admin, `/settings/user/${stranger.id}`, { method: 'DELETE' });
        expect(res.status).toBe(200);
        await expect(restoreHome(artifact, stranger.id, `auth-rows-stranger-${Date.now()}`)).rejects.toThrow();
        rmSync(join(getBackupsDir(), artifact), { force: true });

        const db = getAuthDrizzleDb();
        expect(db.select().from(userScheme).where(eq(userScheme.id, PLANTED_ID)).all()).toEqual([]);
        expect(db.select().from(userScheme).where(eq(userScheme.id, stranger.id)).all()).toEqual([]);
    });
});
