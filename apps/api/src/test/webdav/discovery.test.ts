import { describe, expect, test } from 'bun:test';
import { getTestContext } from '../setup';
import { webdavRequest } from './setup';

// /webdav/ and /webdav/<ownerId>/ list nothing: a listing would make Mountain Duck show the real mount as a fake
// subfolder and let Cyberduck, navigating up, surface unrelated team drives. The mount URL is
// /webdav/<ownerId>/<mountId>/, listed in the Space services UI.

describe('WebDAV discovery is locked down', () => {
    test('PROPFIND /webdav/ → 404', async () => {
        const ctx = await getTestContext();
        const res = await webdavRequest(ctx.alice.user.email, 'PROPFIND', '/webdav/');
        expect(res.status).toBe(404);
    });

    test('PROPFIND /webdav/<userId>/ → 404 (no per-owner discovery)', async () => {
        const ctx = await getTestContext();
        const res = await webdavRequest(ctx.alice.user.email, 'PROPFIND', `/webdav/${ctx.alice.user.id}/`);
        expect(res.status).toBe(404);
    });

    test('PROPFIND /webdav/<teamOwnerId>/ → 404 even when the user is a member', async () => {
        const ctx = await getTestContext();
        const res = await webdavRequest(ctx.alice.user.email, 'PROPFIND', '/webdav/team_anything/');
        expect(res.status).toBe(404);
    });
});
