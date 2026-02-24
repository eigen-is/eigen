import {describe, expect, test, beforeAll} from 'bun:test';
import {getTestContext, authedRequest} from './setup';

describe('Home', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('get home size returns valid structure', async () => {
        const {data, error} = await ctx.alice.api
            .home({ownerId: ctx.alice.user.id}).size.get();

        expect(error).toBeNull();
        expect(data).toBeDefined();
        expect(typeof data!.mail).toBe('number');
        expect(typeof data!.contacts).toBe('number');
        expect(typeof data!.drive).toBe('number');
        expect(typeof data!.used).toBe('number');
        expect(typeof data!.max).toBe('number');
        expect(data!.max).toBeGreaterThan(0);
    });

    test('used = mail + contacts + drive', async () => {
        const {data} = await ctx.alice.api
            .home({ownerId: ctx.alice.user.id}).size.get();

        expect(data!.used).toBe(data!.mail + data!.contacts + data!.drive);
    });

    test('Bob has his own separate home', async () => {
        const {data, error} = await ctx.bob.api
            .home({ownerId: ctx.bob.user.id}).size.get();

        expect(error).toBeNull();
        expect(data).toBeDefined();
        expect(typeof data!.used).toBe('number');
    });

    test('ownerId spoofing on size endpoint still resolves authenticated user home', async () => {
        const spoofed = await authedRequest(ctx.bob.user.sessionToken,
            `/home/${ctx.alice.user.id}/size`);
        const spoofedData = await spoofed.json() as any;

        const expected = await authedRequest(ctx.bob.user.sessionToken,
            `/home/${ctx.bob.user.id}/size`);
        const expectedData = await expected.json() as any;

        expect(spoofed.status).toBe(200);
        expect(expected.status).toBe(200);
        expect(spoofedData).toEqual(expectedData);
    });

    test('zip endpoint returns 500 when home zip is not implemented', async () => {
        const res = await authedRequest(ctx.alice.user.sessionToken,
            `/home/${ctx.alice.user.id}/zip`);

        expect(res.status).toBe(500);
    });
});
