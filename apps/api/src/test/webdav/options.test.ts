import { describe, expect, test } from 'bun:test';
import { app } from '../setup';

describe('WebDAV OPTIONS', () => {
    test('advertises DAV: 1, 2 capability', async () => {
        const res = await app.handle(new Request('http://localhost/webdav/', { method: 'OPTIONS' }));
        expect([200, 204]).toContain(res.status);
        const dav = res.headers.get('DAV') ?? '';
        expect(dav.split(',').map((s) => s.trim())).toEqual(expect.arrayContaining(['1', '2']));
        expect(res.headers.get('Allow')).toContain('PROPFIND');
        expect(res.headers.get('Allow')).toContain('LOCK');
    });
});
