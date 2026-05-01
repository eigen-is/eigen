import { describe, expect, test } from 'bun:test';
import { getTestContext } from '../setup';
import { webdavRequest } from './setup';

// /webdav/ and /webdav/<ownerId>/ used to return a discovery listing of every
// drive the user could reach. That conflated "what can I access?" with "where
// do my files live?" — Mountain Duck mounted /webdav/<userId>/ and showed the
// real mount as a fake `default/` subfolder, and Cyberduck navigating up
// surfaced unrelated team drives. Both layers are now removed; the canonical
// mount URL is /webdav/<ownerId>/<mountId>/, listed in the Space services UI.

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
