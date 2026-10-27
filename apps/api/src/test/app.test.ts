import { describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { EXPORT_SUMMARY_HEADER } from '@workspace/lib/types/drive';
import { authedRequest, driveGet, driveUpload, getTestContext } from './setup';

describe('CORS', () => {
    test('a cross-origin download exposes its Content-Disposition and an export summary, so the dev client reads both', async () => {
        const ctx = await getTestContext();
        const { user } = ctx.alice;
        const root = await driveGet<DrivePath>(user.sessionToken, user.id, 'default', 'root');
        const file = await driveUpload<DrivePath>(
            user.sessionToken,
            user.id,
            'default',
            root.id,
            new File(['hello'], 'cors-download.txt', { type: 'text/plain' }),
        );
        const res = await authedRequest(user.sessionToken, `/drive/${user.id}/default/file/${file.id}/download`, {
            headers: { Origin: 'http://localhost:3001' },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Disposition')).toContain('cors-download.txt');
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3001');
        const exposed = (res.headers.get('Access-Control-Expose-Headers') ?? '').toLowerCase().split(/\s*,\s*/);
        expect(exposed).toContain('content-disposition');
        expect(exposed).toContain(EXPORT_SUMMARY_HEADER.toLowerCase());
    });
});
