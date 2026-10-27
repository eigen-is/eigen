import { beforeAll, describe, expect, test } from 'bun:test';
import type { UserSettings } from '@workspace/lib/types/settings';
import { assertJson, authedRequest, getTestContext } from '../setup';

describe('Space settings', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    function putSettings(body: UserSettings): Promise<Response> {
        return authedRequest(ctx.charlie.user.sessionToken, `/space/${ctx.charlie.user.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    test('celebrations round-trips, and a save of another field keeps it', async () => {
        expect((await putSettings({ celebrations: false })).status).toBe(200);
        expect((await putSettings({ theme: 'dark' })).status).toBe(200);
        const settings = await assertJson<UserSettings>(
            await authedRequest(ctx.charlie.user.sessionToken, `/space/${ctx.charlie.user.id}/settings`),
        );
        expect(settings.celebrations).toBe(false);
        expect(settings.theme).toBe('dark');
    });

    test('a docs text width round-trips beside the other settings, and an unknown one is refused', async () => {
        expect((await putSettings({ docsView: { textWidth: 'wide' } })).status).toBe(200);
        expect((await putSettings({ celebrations: true })).status).toBe(200);
        const settings = await assertJson<UserSettings>(
            await authedRequest(ctx.charlie.user.sessionToken, `/space/${ctx.charlie.user.id}/settings`),
        );
        expect(settings.docsView).toEqual({ textWidth: 'wide' });

        const forged = await authedRequest(ctx.charlie.user.sessionToken, `/space/${ctx.charlie.user.id}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ docsView: { textWidth: 'huge' } }),
        });
        expect(forged.status).toBe(422);
    });
});
