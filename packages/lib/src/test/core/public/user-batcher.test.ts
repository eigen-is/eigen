import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { MAX_PUBLIC_USERS_PER_BATCH } from '@workspace/lib/constants/public';
import { fetchPublicUser } from '../../../core/public/user-batcher';

afterEach(() => mock.restore());

// Emulates the /p/users contract: 422 on batches over the cap, otherwise a user per requested id
// that has an account, and nothing for one that has none. Any other request is a 404.
function mockUsersEndpoint(accountless: string[] = []): number[] {
    const batchSizes: number[] = [];
    // Object.assign carries the real fetch's `preconnect` over, which Bun's `typeof fetch` requires.
    const impl = Object.assign(
        async (_input: URL | RequestInfo, init?: RequestInit) => {
            if (init?.method !== 'POST') return new Response('User not found', { status: 404 });
            const { ids } = JSON.parse(String(init.body)) as { ids: string[] };
            batchSizes.push(ids.length);
            if (ids.length > MAX_PUBLIC_USERS_PER_BATCH) return new Response('Validation failed', { status: 422 });
            const known = ids.filter((id) => !accountless.includes(id));
            return Response.json(Object.fromEntries(known.map((id) => [id, { email: id, name: `User ${id}` }])));
        },
        { preconnect: fetch.preconnect },
    );
    spyOn(globalThis, 'fetch').mockImplementation(impl);
    return batchSizes;
}

test('resolves batches larger than the server cap by chunking requests', async () => {
    const batchSizes = mockUsersEndpoint();
    const ids = Array.from({ length: 250 }, (_, i) => `user-${i}@example.com`);

    const users = await Promise.all(ids.map((id) => fetchPublicUser(id)));

    expect(batchSizes.every((size) => size <= MAX_PUBLIC_USERS_PER_BATCH)).toBe(true);
    expect(users.filter(Boolean).length).toBe(250);
    expect(users[249]?.email).toBe('user-249@example.com');
});

test('sends a single request when the batch fits the cap', async () => {
    const batchSizes = mockUsersEndpoint();
    const ids = Array.from({ length: MAX_PUBLIC_USERS_PER_BATCH }, (_, i) => `user-${i}@example.com`);

    const users = await Promise.all(ids.map((id) => fetchPublicUser(id)));

    expect(batchSizes).toEqual([MAX_PUBLIC_USERS_PER_BATCH]);
    expect(users.filter(Boolean).length).toBe(MAX_PUBLIC_USERS_PER_BATCH);
});

test('resolves a lone lookup through the batch POST, null for an address without an account', async () => {
    const batchSizes = mockUsersEndpoint(['guest@example.com']);

    const user = await fetchPublicUser('member@example.com');
    const guest = await fetchPublicUser('guest@example.com');

    expect(batchSizes).toEqual([1, 1]);
    expect(user?.email).toBe('member@example.com');
    expect(guest).toBeNull();
});
