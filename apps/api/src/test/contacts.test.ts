import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { getServerSettings, updateServerSettings } from '../lib/config/server-settings';
import { getHome } from '../lib/home';
import { assertJson, authedRequest, findOrFail, getTestContext } from './setup';

describe('Contacts', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let contactId: string;
    let labelId: string;
    let initialContactCount: number;

    beforeAll(async () => {
        ctx = await getTestContext();

        const res = await authedRequest(ctx.alice.user.sessionToken, `/contacts/${ctx.alice.user.id}/contacts`);
        const data = await assertJson<Contact[]>(res);
        initialContactCount = data.length;
    });

    describe('Contact CRUD', () => {
        test('create contact', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/contacts/${ctx.alice.user.id}/contacts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    firstName: '  Charlie  ',
                    lastName: '  Test  ',
                    email: ['charlie@test.eigen.is'],
                    phone: ['+1234567890'],
                    company: 'Eigen',
                    jobTitle: 'Tester',
                }),
            });
            expect(res.status).toBe(200);

            const listRes = await authedRequest(ctx.alice.user.sessionToken, `/contacts/${ctx.alice.user.id}/contacts`);
            const all = await assertJson<Contact[]>(listRes);
            const charlie = findOrFail(all, (c) => c.firstName === 'Charlie');
            expect(charlie.firstName).toBe('Charlie');
            expect(charlie.lastName).toBe('Test');
            contactId = charlie.id;
        });

        test('list contacts includes new contact', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/contacts/${ctx.alice.user.id}/contacts`);
            const data = await assertJson<Contact[]>(res);
            expect(Array.isArray(data)).toBe(true);
            expect(data.length).toBe(initialContactCount + 1);
            const contact = findOrFail(data, (c) => c.firstName === 'Charlie');
            expect(contact.lastName).toBe('Test');
        });

        test('get contact by id', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts/${contactId}`,
            );
            const data = await assertJson<Contact>(res);
            expect(data.firstName).toBe('Charlie');
        });

        test('update contact', async () => {
            const beforeRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts/${contactId}`,
            );
            const before = await assertJson<Contact>(beforeRes);

            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts/${contactId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        firstName: 'Charlie',
                        lastName: 'Updated',
                        email: ['charlie@test.eigen.is'],
                        phone: [],
                        etag: before.etag,
                    }),
                },
            );
            expect(res.status).toBe(200);

            const getRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts/${contactId}`,
            );
            const updated = await assertJson<Contact>(getRes);
            expect(updated.lastName).toBe('Updated');
        });

        test('delete contact', async () => {
            const beforeRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts/${contactId}`,
            );
            const before = await assertJson<Contact>(beforeRes);

            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts/${contactId}?etag=${encodeURIComponent(before.etag)}`,
                { method: 'DELETE' },
            );
            expect(res.status).toBe(200);

            const listRes = await authedRequest(ctx.alice.user.sessionToken, `/contacts/${ctx.alice.user.id}/contacts`);
            const contacts = await assertJson<Contact[]>(listRes);
            expect(contacts.find((c) => c.id === contactId)).toBeUndefined();
        });

        test('delete contact is idempotent for non-existing contact', async () => {
            // The row is already gone, so the etag is never evaluated — any value still yields a 200 no-op.
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts/${contactId}?etag=x`,
                { method: 'DELETE' },
            );
            expect(res.status).toBe(200);
        });
    });

    describe('Conditional writes (etag preconditions)', () => {
        // A stale etag means the card was rewritten (a device sync, another tab) since the form loaded; the
        // second write must be refused with 412 rather than clobbering the newer state (spec § 3).
        test('updating with a stale etag is rejected with 412', async () => {
            const token = ctx.alice.user.sessionToken;
            const createRes = await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    firstName: 'Stale',
                    lastName: 'Etag',
                    email: ['stale-etag@test.eigen.is'],
                    phone: [],
                }),
            });
            const id = (await createRes.text()).replace(/^"|"$/g, '');

            const beforeRes = await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts/${id}`);
            const staleEtag = (await assertJson<Contact>(beforeRes)).etag;

            const first = await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    firstName: 'Stale',
                    lastName: 'Fresh',
                    email: ['stale-etag@test.eigen.is'],
                    phone: [],
                    etag: staleEtag,
                }),
            });
            expect(first.status).toBe(200);

            const second = await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    firstName: 'Stale',
                    lastName: 'Loser',
                    email: ['stale-etag@test.eigen.is'],
                    phone: [],
                    etag: staleEtag,
                }),
            });
            expect(second.status).toBe(412);
        });

        // Two tabs saving the same loaded card at once: both carry the etag they read, both are in flight
        // before either answers. The writeLock orders them and evaluates each precondition against the state
        // it is about to overwrite, so the second one loses instead of clobbering the first.
        test('two concurrent writes from one etag leave exactly one winner and one 412', async () => {
            const token = ctx.alice.user.sessionToken;
            const url = `/contacts/${ctx.alice.user.id}/contacts`;
            const createRes = await authedRequest(token, url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    firstName: 'Race',
                    lastName: 'Start',
                    email: ['race@test.eigen.is'],
                    phone: [],
                }),
            });
            const id = (await createRes.text()).replace(/^"|"$/g, '');
            const loaded = await assertJson<Contact>(await authedRequest(token, `${url}/${id}`));

            const save = (lastName: string) =>
                authedRequest(token, `${url}/${id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        firstName: 'Race',
                        lastName,
                        email: ['race@test.eigen.is'],
                        phone: [],
                        etag: loaded.etag,
                    }),
                });
            const [first, second] = await Promise.all([save('First'), save('Second')]);

            expect([first.status, second.status].sort()).toEqual([200, 412]);
            const stored = await assertJson<Contact>(await authedRequest(token, `${url}/${id}`));
            expect(stored.lastName).toBe(first.status === 200 ? 'First' : 'Second');
            expect(stored.etag).not.toBe(loaded.etag);
        });

        test('deleting an existing contact with a wrong etag is rejected with 412', async () => {
            const token = ctx.alice.user.sessionToken;
            const createRes = await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    firstName: 'Wrong',
                    lastName: 'Etag',
                    email: ['wrong-etag@test.eigen.is'],
                    phone: [],
                }),
            });
            const id = (await createRes.text()).replace(/^"|"$/g, '');

            const del = await authedRequest(
                token,
                `/contacts/${ctx.alice.user.id}/contacts/${id}?etag=not-the-real-etag`,
                { method: 'DELETE' },
            );
            expect(del.status).toBe(412);

            // A precondition failure must leave the contact intact.
            const stillThere = await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts/${id}`);
            expect((await assertJson<Contact>(stillThere)).id).toBe(id);
        });
    });

    describe('Labels', () => {
        let initialLabelCount: number;

        beforeAll(async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/contacts/${ctx.alice.user.id}/labels`);
            const data = await assertJson<Label[]>(res);
            initialLabelCount = data.length;
        });

        test('create label', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/contacts/${ctx.alice.user.id}/labels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'VIP', color: '#ff0000' }),
            });
            expect(res.status).toBe(200);
            const raw = await res.text();
            labelId = raw.replace(/^"|"$/g, '');
            expect(labelId.length).toBeGreaterThan(0);
        });

        test('list labels includes new label and serves the Label DTO only', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/contacts/${ctx.alice.user.id}/labels`);
            const data = await assertJson<Label[]>(res);
            expect(Array.isArray(data)).toBe(true);
            expect(data.length).toBe(initialLabelCount + 1);
            const vip = findOrFail(data, (l) => l.name === 'VIP');
            // Index bookkeeping (nameKey, timestamps) is not part of the contract.
            expect(Object.keys(vip).sort()).toEqual(['color', 'id', 'name']);
        });

        test('update label', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/labels/${labelId}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'VIP Updated', color: '#00ff00' }),
                },
            );
            expect(res.status).toBe(200);
            const data = await assertJson<Label>(res);
            expect(data).toEqual({ id: labelId, name: 'VIP Updated', color: '#00ff00' });
        });

        test('updating a label that does not exist is rejected with 404', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/labels/${randomUUID()}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: 'Ghost', color: '#000000' }),
                },
            );
            expect(res.status).toBe(404);
        });

        test('list labels reflects updated label', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/contacts/${ctx.alice.user.id}/labels`);
            const data = await assertJson<Label[]>(res);
            const label = findOrFail(data, (l) => l.id === labelId);
            expect(label.name).toBe('VIP Updated');
            expect(label.color).toBe('#00ff00');
        });

        test('delete label', async () => {
            const res = await authedRequest(
                ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/labels/${labelId}`,
                { method: 'DELETE' },
            );
            expect(res.status).toBe(200);
        });

        test('deleted label is removed from labels list', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/contacts/${ctx.alice.user.id}/labels`);
            const data = await assertJson<Label[]>(res);
            expect(data.find((l) => l.id === labelId)).toBeUndefined();
        });
    });

    describe('Label uniqueness', () => {
        // A v2 UNIQUE index on nameKey guards duplicate names; the raw SQLite violation must surface as a
        // 409, not a generic 500. 'Work' and 'Family' are seeded default labels, so they always collide.
        test('creating a whitespace/case variant of an existing label name is rejected with 409', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/contacts/${ctx.alice.user.id}/labels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: ' Work ', color: '#ff0000' }),
            });
            expect(res.status).toBe(409);
            expect(await res.text()).toContain('already exists');
        });

        test('renaming a label to a case-variant of another label name is rejected with 409', async () => {
            const token = ctx.alice.user.sessionToken;
            const createRes = await authedRequest(token, `/contacts/${ctx.alice.user.id}/labels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Colleagues', color: '#123456' }),
            });
            const colleaguesId = (await createRes.text()).replace(/^"|"$/g, '');

            const rename = await authedRequest(token, `/contacts/${ctx.alice.user.id}/labels/${colleaguesId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'FAMILY', color: '#123456' }),
            });
            expect(rename.status).toBe(409);
            expect(await rename.text()).toContain('already exists');
        });
    });

    describe('Label name validation', () => {
        // A whitespace-only name normalizes to the empty key, which the CATEGORIES sync skips: the label row
        // would exist while every membership silently dropped. Both write seams refuse it up front.
        test('creating a whitespace-only label is rejected with 400 and creates nothing', async () => {
            const token = ctx.alice.user.sessionToken;
            const before = await assertJson<Label[]>(
                await authedRequest(token, `/contacts/${ctx.alice.user.id}/labels`),
            );

            const res = await authedRequest(token, `/contacts/${ctx.alice.user.id}/labels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: '   ', color: '#ff0000' }),
            });

            expect(res.status).toBe(400);
            const after = await assertJson<Label[]>(
                await authedRequest(token, `/contacts/${ctx.alice.user.id}/labels`),
            );
            expect(after.length).toBe(before.length);
        });

        test('renaming a label to whitespace is rejected with 400 and touches no member card', async () => {
            const token = ctx.alice.user.sessionToken;
            const createRes = await authedRequest(token, `/contacts/${ctx.alice.user.id}/labels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Blankable', color: '#222222' }),
            });
            const blankableId = (await createRes.text()).replace(/^"|"$/g, '');
            await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    firstName: 'Blank',
                    lastName: 'Member',
                    email: ['blank@test.eigen.is'],
                    phone: [],
                    labels: [blankableId],
                }),
            });
            const listBefore = await assertJson<Contact[]>(
                await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts`),
            );
            const memberBefore = findOrFail(listBefore, (c) => c.firstName === 'Blank');

            const rename = await authedRequest(token, `/contacts/${ctx.alice.user.id}/labels/${blankableId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: ' \t ', color: '#222222' }),
            });

            expect(rename.status).toBe(400);
            const labels = await assertJson<Label[]>(
                await authedRequest(token, `/contacts/${ctx.alice.user.id}/labels`),
            );
            expect(findOrFail(labels, (l) => l.id === blankableId).name).toBe('Blankable');
            const listAfter = await assertJson<Contact[]>(
                await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts`),
            );
            const memberAfter = findOrFail(listAfter, (c) => c.firstName === 'Blank');
            // No card was rewritten: the etag (a hash of the card bytes) and the membership are untouched.
            expect(memberAfter.etag).toBe(memberBefore.etag);
            expect(memberAfter.labels).toEqual([blankableId]);
        });
    });

    describe('Label ↔ contact membership', () => {
        // The rename/delete fan-outs rewrite each member card's CATEGORIES; the observable REST contract is
        // that membership survives a rename and drops on a delete, end to end through the route + writeLock.
        test('renaming a label keeps it assigned to its contacts and surfaces the new name', async () => {
            const token = ctx.alice.user.sessionToken;
            const labelRes = await authedRequest(token, `/contacts/${ctx.alice.user.id}/labels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Renamable', color: '#654321' }),
            });
            const renamableId = (await labelRes.text()).replace(/^"|"$/g, '');

            const createRes = await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    firstName: 'Renamed',
                    lastName: 'Member',
                    email: ['renamed-member@test.eigen.is'],
                    phone: [],
                    labels: [renamableId],
                }),
            });
            const memberId = (await createRes.text()).replace(/^"|"$/g, '');

            const rename = await authedRequest(token, `/contacts/${ctx.alice.user.id}/labels/${renamableId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Renamed Label', color: '#654321' }),
            });
            expect(rename.status).toBe(200);

            const byIdRes = await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts/${memberId}`);
            expect((await assertJson<Contact>(byIdRes)).labels).toEqual([renamableId]);

            const labelsRes = await authedRequest(token, `/contacts/${ctx.alice.user.id}/labels`);
            const labels = await assertJson<Label[]>(labelsRes);
            expect(findOrFail(labels, (l) => l.id === renamableId).name).toBe('Renamed Label');
        });

        test('deleting a label removes it from its contacts', async () => {
            const token = ctx.alice.user.sessionToken;
            const labelRes = await authedRequest(token, `/contacts/${ctx.alice.user.id}/labels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Deletable', color: '#0000ff' }),
            });
            const deletableId = (await labelRes.text()).replace(/^"|"$/g, '');

            const createRes = await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    firstName: 'Delete',
                    lastName: 'Member',
                    email: ['delete-member@test.eigen.is'],
                    phone: [],
                    labels: [deletableId],
                }),
            });
            const memberId = (await createRes.text()).replace(/^"|"$/g, '');

            const del = await authedRequest(token, `/contacts/${ctx.alice.user.id}/labels/${deletableId}`, {
                method: 'DELETE',
            });
            expect(del.status).toBe(200);

            const byIdRes = await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts/${memberId}`);
            expect((await assertJson<Contact>(byIdRes)).labels).toEqual([]);
        });
    });

    describe('Contact labels round-trip', () => {
        // Exercises the batched label grouping in getContacts: a contact with labels must come back
        // with them both from the list (one grouped query) and by id (per-contact query).
        test('list and by-id return an assigned label', async () => {
            const token = ctx.alice.user.sessionToken;
            const labelRes = await authedRequest(token, `/contacts/${ctx.alice.user.id}/labels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Round Trip', color: '#123456' }),
            });
            const roundTripLabelId = (await labelRes.text()).replace(/^"|"$/g, '');

            const createRes = await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    firstName: 'Labeled',
                    lastName: 'Person',
                    email: ['labeled@test.eigen.is'],
                    phone: [],
                    labels: [roundTripLabelId],
                }),
            });
            const roundTripContactId = (await createRes.text()).replace(/^"|"$/g, '');

            const listRes = await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts`);
            const all = await assertJson<Contact[]>(listRes);
            expect(findOrFail(all, (c) => c.id === roundTripContactId).labels).toEqual([roundTripLabelId]);

            const byIdRes = await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts/${roundTripContactId}`);
            expect((await assertJson<Contact>(byIdRes)).labels).toEqual([roundTripLabelId]);
        });
    });

    describe('Cross-user isolation', () => {
        test('Bob contacts are separate from Alice', async () => {
            const aliceRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts`,
            );
            const aliceContacts = await assertJson<Contact[]>(aliceRes);

            const bobRes = await authedRequest(ctx.bob.user.sessionToken, `/contacts/${ctx.bob.user.id}/contacts`);
            const bobContacts = await assertJson<Contact[]>(bobRes);

            const aliceIds = new Set(aliceContacts.map((c) => c.id));
            const bobIds = new Set(bobContacts.map((c) => c.id));
            const overlap = [...aliceIds].filter((id) => bobIds.has(id));
            expect(overlap.length).toBe(0);
        });

        test('ownerId spoofing is rejected with 403', async () => {
            const spoofRes = await authedRequest(ctx.bob.user.sessionToken, `/contacts/${ctx.alice.user.id}/contacts`);
            expect(spoofRes.status).toBe(403);
        });
    });

    // The card write seam is the only metered contacts ingest: it projects the mail+contacts usage the write
    // would leave behind, crediting the bytes of the card it replaces, and refuses the overflow with 507.
    describe('Storage quota (mail + contacts)', () => {
        const MB = 1024 * 1024;
        const body = (over: Partial<Contact>) => ({
            firstName: 'Quota',
            lastName: 'Subject',
            email: ['quota@test.eigen.is'],
            phone: [],
            ...over,
        });

        test('a create overflows at 507, a growing update too, and a shrinking rewrite still fits', async () => {
            const token = ctx.alice.user.sessionToken;
            const url = `/contacts/${ctx.alice.user.id}/contacts`;
            const originalMaxMB = getServerSettings().quotas.mailAndContactsMaxMB;

            // A fat card first (under the default quota), so the book's total is dominated by bytes this test
            // owns and can later shrink away, whatever the fixtures seeded.
            const createRes = await authedRequest(token, url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body({ notes: 'n'.repeat(2 * MB) })),
            });
            expect(createRes.status).toBe(200);
            const fatId = (await createRes.text()).replace(/^"|"$/g, '');

            try {
                const home = await getHome(ctx.alice.user.id);
                const used = (await home.mail.size()) + (await home.contacts.size());
                // Floor to whole MB (the setting's unit): the ceiling now sits at or just under what the book
                // already uses, so anything that adds bytes overflows and only a shrinking rewrite fits.
                await updateServerSettings({ quotas: { mailAndContactsMaxMB: Math.floor(used / MB) } });

                const create = await authedRequest(token, url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body({ firstName: 'Refused' })),
                });
                expect(create.status).toBe(507);

                const fat = await assertJson<Contact>(await authedRequest(token, `${url}/${fatId}`));
                const grow = await authedRequest(token, `${url}/${fatId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body({ notes: 'n'.repeat(3 * MB), etag: fat.etag })),
                });
                expect(grow.status).toBe(507);

                const shrink = await authedRequest(token, `${url}/${fatId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body({ notes: '', etag: fat.etag })),
                });
                expect(shrink.status).toBe(200);
            } finally {
                await updateServerSettings({ quotas: { mailAndContactsMaxMB: originalMaxMB } });
                const left = await assertJson<Contact>(await authedRequest(token, `${url}/${fatId}`));
                await authedRequest(token, `${url}/${fatId}?etag=${encodeURIComponent(left.etag)}`, {
                    method: 'DELETE',
                });
            }
        });
    });

    describe('Me endpoint', () => {
        test('Alice can get her own profile', async () => {
            const res = await authedRequest(ctx.alice.user.sessionToken, `/contacts/${ctx.alice.user.id}/me`);
            const data = await assertJson<Contact>(res);
            expect(data.eigenId).toBe(ctx.alice.user.id);
        });

        test('ownerId spoofing on me endpoint is rejected with 403', async () => {
            const res = await authedRequest(ctx.bob.user.sessionToken, `/contacts/${ctx.alice.user.id}/me`);
            expect(res.status).toBe(403);
        });

        // The org-wide profile push runs after the card committed, so its failure cannot be the answer the
        // client gets: a 5xx here would leave the user holding a stale etag that 412s on every retry.
        test('a self-card update that fails to propagate is still saved and reported as saved', async () => {
            const token = ctx.alice.user.sessionToken;
            const me = await assertJson<Contact>(await authedRequest(token, `/contacts/${ctx.alice.user.id}/me`));

            const relay = await import('../lib/home/home-relay');
            let pushed = false;
            const push = spyOn(relay, 'pushUserProfile').mockImplementation(async () => {
                pushed = true;
                throw new Error('push boom');
            });
            const errorLog = spyOn(console, 'error').mockImplementation(() => {});

            try {
                const res = await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts/${me.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...me, notes: 'propagation failed' }),
                });
                expect(res.status).toBe(200);
            } finally {
                push.mockRestore();
                errorLog.mockRestore();
            }
            expect(pushed).toBe(true);

            const after = await assertJson<Contact>(await authedRequest(token, `/contacts/${ctx.alice.user.id}/me`));
            expect(after.notes).toBe('propagation failed');
            expect(after.etag).not.toBe(me.etag);

            // One data dir is shared by every test file in the run, so put Alice's self card back as found.
            const restored = await authedRequest(token, `/contacts/${ctx.alice.user.id}/contacts/${me.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...after, notes: me.notes }),
            });
            expect(restored.status).toBe(200);
        });

        test('cannot delete own profile contact', async () => {
            const meRes = await authedRequest(ctx.alice.user.sessionToken, `/contacts/${ctx.alice.user.id}/me`);
            const me = await assertJson<Contact>(meRes);

            const deleteRes = await authedRequest(
                ctx.alice.user.sessionToken,
                `/contacts/${ctx.alice.user.id}/contacts/${me.id}?etag=${encodeURIComponent(me.etag)}`,
                { method: 'DELETE' },
            );

            expect(deleteRes.status).toBe(400);
            expect(await deleteRes.text()).toContain('You cannot delete yourself');
        });
    });
});
