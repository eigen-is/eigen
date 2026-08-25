import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { sql } from 'drizzle-orm';
import { getHome } from '../../lib/home';
import type { Mount } from '../../lib/mount/mount';
import { authedRequest, driveGet, driveUpload, getTestContext } from '../setup';

describe('Serve-file caching', () => {
    let token: string;
    let ownerId: string;
    const mountId = 'default';
    let rootId: string;

    beforeAll(async () => {
        const ctx = await getTestContext();
        token = ctx.alice.user.sessionToken;
        ownerId = ctx.alice.user.id;
        const root = await driveGet(token, ownerId, mountId, 'root');
        rootId = root.id;
    });

    function sha256(content: string): string {
        return new Bun.CryptoHasher('sha256').update(content).digest('hex');
    }

    async function uploadTextFile(name: string, content: string): Promise<DrivePath> {
        const file = new File([content], name, { type: 'text/plain' });
        return driveUpload(token, ownerId, mountId, rootId, file);
    }

    function downloadUrl(pathId: string): string {
        return `/drive/${ownerId}/${mountId}/file/${pathId}/download`;
    }

    test('download returns the stored hash as ETag with private no-cache and no Expires', async () => {
        const uploaded = await uploadTextFile('etag-basic.txt', 'etag basic body');
        const res = await authedRequest(token, downloadUrl(uploaded.id));
        expect(res.status).toBe(200);
        expect(res.headers.get('etag')).toBe(`"${sha256('etag basic body')}"`);
        expect(res.headers.get('cache-control')).toBe('private, no-cache');
        expect(res.headers.get('expires')).toBeNull();
    });

    test('If-None-Match with the current etag returns 304 with no body and validator headers', async () => {
        const uploaded = await uploadTextFile('etag-304.txt', 'etag 304 body');
        const etag = `"${sha256('etag 304 body')}"`;
        const res = await authedRequest(token, downloadUrl(uploaded.id), {
            headers: { 'If-None-Match': etag },
        });
        expect(res.status).toBe(304);
        expect(await res.text()).toBe('');
        expect(res.headers.get('etag')).toBe(etag);
        expect(res.headers.get('cache-control')).toBe('private, no-cache');
    });

    test('If-None-Match compares weakly, across comma lists and *; a non-matching etag serves 200', async () => {
        const uploaded = await uploadTextFile('etag-matcher.txt', 'etag matcher body');
        const etag = `"${sha256('etag matcher body')}"`;

        const weak = await authedRequest(token, downloadUrl(uploaded.id), {
            headers: { 'If-None-Match': `W/${etag}` },
        });
        expect(weak.status).toBe(304);

        const list = await authedRequest(token, downloadUrl(uploaded.id), {
            headers: { 'If-None-Match': `"deadbeef", ${etag}` },
        });
        expect(list.status).toBe(304);

        const star = await authedRequest(token, downloadUrl(uploaded.id), {
            headers: { 'If-None-Match': '*' },
        });
        expect(star.status).toBe(304);

        const miss = await authedRequest(token, downloadUrl(uploaded.id), {
            headers: { 'If-None-Match': '"deadbeef"' },
        });
        expect(miss.status).toBe(200);
        expect(miss.headers.get('etag')).toBe(etag);
    });

    test('overwriting the content invalidates the old etag and serves a new one', async () => {
        const uploaded = await uploadTextFile('etag-overwrite.txt', 'first body');
        const oldEtag = `"${sha256('first body')}"`;

        const contentRes = await authedRequest(token, `/editor/${ownerId}/${mountId}/${uploaded.id}/content`);
        const { updatedAt } = await contentRes.json();
        const save = await authedRequest(token, `/editor/${ownerId}/${mountId}/${uploaded.id}/content`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'second body', expectedUpdatedAt: updatedAt }),
        });
        expect(save.status).toBe(200);

        const res = await authedRequest(token, downloadUrl(uploaded.id), {
            headers: { 'If-None-Match': oldEtag },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('etag')).toBe(`"${sha256('second body')}"`);
    });

    test('a row without a hash falls back to the id-mtime-size etag', async () => {
        const uploaded = await uploadTextFile('etag-nullhash.txt', 'null hash body');
        const home = await getHome(ownerId);
        const mount = (home.drive as unknown as { getMount(id: string): Mount }).getMount(mountId);
        mount.db.run(sql`UPDATE paths SET hash = NULL WHERE id = ${uploaded.id}`);

        const res = await authedRequest(token, downloadUrl(uploaded.id));
        expect(res.status).toBe(200);
        const mtime = new Date(uploaded.updatedAt).getTime();
        expect(res.headers.get('etag')).toBe(`"${uploaded.id}-${mtime}-${uploaded.size}"`);
    });

    test('a range request returns 206 with the ETag', async () => {
        const uploaded = await uploadTextFile('etag-range.txt', 'range body content');
        const res = await authedRequest(token, downloadUrl(uploaded.id), {
            headers: { Range: 'bytes=0-3' },
        });
        expect(res.status).toBe(206);
        expect(res.headers.get('etag')).toBe(`"${sha256('range body content')}"`);
        expect(await res.text()).toBe('rang');
    });

    // The thumbnail route's private max-age is pinned by drive.test.ts's existing thumbnail test.
    test('preview responses are private with a max-age', async () => {
        // 24x24 PNG (from drive.test.ts) — large enough for thumbnail generation.
        const base64 =
            'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAApgAAAKYB3X3/OAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAANCSURBVEiJtZZPbBtFFMZ/M7ubXdtdb1xSFyeilBapySVU8h8OoFaooFSqiihIVIpQBKci6KEg9Q6H9kovIHoCIVQJJCKE1ENFjnAgcaSGC6rEnxBwA04Tx43t2FnvDAfjkNibxgHxnWb2e/u992bee7tCa00YFsffekFY+nUzFtjW0LrvjRXrCDIAaPLlW0nHL0SsZtVoaF98mLrx3pdhOqLtYPHChahZcYYO7KvPFxvRl5XPp1sN3adWiD1ZAqD6XYK1b/dvE5IWryTt2udLFedwc1+9kLp+vbbpoDh+6TklxBeAi9TL0taeWpdmZzQDry0AcO+jQ12RyohqqoYoo8RDwJrU+qXkjWtfi8Xxt58BdQuwQs9qC/afLwCw8tnQbqYAPsgxE1S6F3EAIXux2oQFKm0ihMsOF71dHYx+f3NND68ghCu1YIoePPQN1pGRABkJ6Bus96CutRZMydTl+TvuiRW1m3n0eDl0vRPcEysqdXn+jsQPsrHMquGeXEaY4Yk4wxWcY5V/9scqOMOVUFthatyTy8QyqwZ+kDURKoMWxNKr2EeqVKcTNOajqKoBgOE28U4tdQl5p5bwCw7BWquaZSzAPlwjlithJtp3pTImSqQRrb2Z8PHGigD4RZuNX6JYj6wj7O4TFLbCO/Mn/m8R+h6rYSUb3ekokRY6f/YukArN979jcW+V/S8g0eT/N3VN3kTqWbQ428m9/8k0P/1aIhF36PccEl6EhOcAUCrXKZXXWS3XKd2vc/TRBG9O5ELC17MmWubD2nKhUKZa26Ba2+D3P+4/MNCFwg59oWVeYhkzgN/JDR8deKBoD7Y+ljEjGZ0sosXVTvbc6RHirr2reNy1OXd6pJsQ+gqjk8VWFYmHrwBzW/n+uMPFiRwHB2I7ih8ciHFxIkd/3Omk5tCDV1t+2nNu5sxxpDFNx+huNhVT3/zMDz8usXC3ddaHBj1GHj/As08fwTS7Kt1HBTmyN29vdwAw+/wbwLVOJ3uAD1wi/dUH7Qei66PfyuRj4Ik9is+hglfbkbfR3cnZm7chlUWLdwmprtCohX4HUtlOcQjLYCu+fzGJH2QRKvP3UNz8bWk1qMxjGTOMThZ3kvgLI5AzFfo379UAAAAASUVORK5CYII=';
        const pngBytes = Buffer.from(base64, 'base64');
        const file = new File([pngBytes], 'cache-headers.png', { type: 'image/png' });
        const uploaded = await driveUpload(token, ownerId, mountId, rootId, file);

        const preview = await authedRequest(token, `/drive/${ownerId}/${mountId}/file/${uploaded.id}/preview`);
        expect(preview.status).toBe(200);
        expect(preview.headers.get('cache-control')).toStartWith('private, max-age=');
    });
});
