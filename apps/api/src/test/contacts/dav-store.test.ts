import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { SSEventType } from '@workspace/lib/types/sse';
import { eq } from 'drizzle-orm';
import { CARD_MAX_BYTES } from '../../lib/contacts/card-store';
import type { Contacts } from '../../lib/contacts/contacts';
import * as contactsSchema from '../../lib/contacts/schema';
import { computeResourceEtag, normalizeResourceUri } from '../../lib/core';
import { CONTACTS_TEST_ROOT, makeContacts } from '../contacts-test-helpers';

// Minimal well-formed vCard 3.0 body — the bytes a DAV client PUTs, kept as CRLF text so the store writes
// them verbatim.
function card(
    opts: { uid?: string; n?: string; fn?: string; email?: string[]; eigenId?: string; extra?: string[] } = {},
): string {
    const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
    if (opts.uid !== undefined) lines.push(`UID:${opts.uid}`);
    lines.push(`N:${opts.n ?? 'Doe;John;;;'}`);
    lines.push(`FN:${opts.fn ?? 'John Doe'}`);
    for (const e of opts.email ?? []) lines.push(`EMAIL:${e}`);
    if (opts.eigenId) lines.push(`X-EIGEN-ID:${opts.eigenId}`);
    for (const x of opts.extra ?? []) lines.push(x);
    lines.push('END:VCARD');
    return `${lines.join('\r\n')}\r\n`;
}

const rowByUri = (db: Contacts['db'], uri: string) =>
    db
        .select()
        .from(contactsSchema.contacts)
        .where(eq(contactsSchema.contacts.uri, normalizeResourceUri(uri)))
        .get();

const put = (
    contacts: Contacts,
    uri: string,
    body: string,
    pre?: { ifMatch?: string | null; ifNoneMatch?: string | null },
) => contacts.putCard(uri, body, { ifMatch: pre?.ifMatch ?? null, ifNoneMatch: pre?.ifNoneMatch ?? null });

describe('putCard — create and read', () => {
    beforeAll(() => {
        rmSync(CONTACTS_TEST_ROOT, { recursive: true, force: true });
    });

    test('a create returns created:true and an etag hashing the stored bytes', async () => {
        const { instance: contacts } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        const body = card({ uid, email: ['stranger@example.org'] });

        const res = await put(contacts, uri, body);

        expect(res).toEqual({
            ok: true,
            id: rowByUri(contacts.db, uri)!.id,
            etag: computeResourceEtag(new TextEncoder().encode(body)),
            created: true,
        });
    });

    test('getCard returns a 3.0 body byte-identically, folded X-props and all', async () => {
        const { instance: contacts } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        const body =
            `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nN:Lovelace;Ada;;;\r\nFN:Ada Lovelace\r\n` +
            `item1.EMAIL;TYPE=INTERNET:stranger@example.org\r\nitem1.X-ABLabel:_$!<Work>!$_\r\n` +
            `X-SOCIALPROFILE;type=twitter:https://twitter.com/example\r\n` +
            `NOTE:a folded note that runs on for more than seventy five octets to force a co\r\n ntinuation line\r\nEND:VCARD\r\n`;

        const res = await put(contacts, uri, body);
        expect(res.ok).toBe(true);

        const got = await contacts.getCard(uri);
        expect(got).not.toBeNull();
        expect(new TextDecoder().decode(got!.bytes)).toBe(body);
        expect(got!.etag).toBe((res as { etag: string }).etag);
    });

    test('getCard is null for an unknown uri', async () => {
        const { instance: contacts } = await makeContacts();
        expect(await contacts.getCard(`${randomUUID()}.vcf`)).toBeNull();
    });
});

describe('putCard — path safety', () => {
    test('a traversal uri is refused as invalid by the resource-name rule', async () => {
        const { instance: contacts } = await makeContacts();
        const res = await put(contacts, '../contacts.db', card({ uid: randomUUID() }));

        expect(res).toEqual({ ok: false, error: 'invalid' });
        // The name rule stands even though a uri is no longer a path: nothing is stored under it.
        expect((await contacts.listCards()).some((c) => c.uri === '../contacts.db')).toBe(false);
        expect(await contacts.getCard('../contacts.db')).toBeNull();
    });

    test('a dot-prefixed uri is refused as invalid', async () => {
        const { instance: contacts } = await makeContacts();
        expect(await put(contacts, '.hidden.vcf', card({ uid: randomUUID() }))).toEqual({
            ok: false,
            error: 'invalid',
        });
    });
});

describe('putCard — 4.0 transcode', () => {
    test('a 4.0 PUT is stored as 3.0 with the photo in ENCODING=b form', async () => {
        const { instance: contacts } = await makeContacts();
        const sharp = (await import('sharp')).default;
        const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 9, g: 40, b: 90 } } })
            .jpeg()
            .toBuffer();
        const b64 = jpeg.toString('base64');
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        const body = `BEGIN:VCARD\r\nVERSION:4.0\r\nUID:${uid}\r\nN:Tesla;Nikola;;;\r\nFN:Nikola Tesla\r\nPHOTO:data:image/jpeg;base64,${b64}\r\nEND:VCARD\r\n`;

        const res = await put(contacts, uri, body);
        expect(res.ok).toBe(true);

        const stored = new TextDecoder().decode((await contacts.getCard(uri))!.bytes);
        expect(stored).not.toBe(body);
        expect(stored).toContain('VERSION:3.0');
        expect(stored).toContain('PHOTO;ENCODING=b');
        // The bytes stored are not the bytes sent, so the write carries no validator and the client re-reads.
        expect((res as { etag: string | null }).etag).toBeNull();
    });

    test('a 3.0 PUT stored verbatim still answers with the etag of its own bytes', async () => {
        const { instance: contacts } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        const body = card({ uid, email: ['verbatim@example.org'] });

        const res = await put(contacts, uri, body);

        expect((res as { etag: string }).etag).toBe(computeResourceEtag(new TextEncoder().encode(body)));
    });
});

describe('putCard — preconditions', () => {
    test('If-None-Match:* against an existing card is a precondition failure', async () => {
        const { instance: contacts } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await put(contacts, uri, card({ uid }));

        expect(await put(contacts, uri, card({ uid, fn: 'Nope' }), { ifNoneMatch: '*' })).toEqual({
            ok: false,
            error: 'precondition',
        });
    });

    test('a stale If-Match is a precondition failure', async () => {
        const { instance: contacts } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await put(contacts, uri, card({ uid }));

        expect(await put(contacts, uri, card({ uid, fn: 'Nope' }), { ifMatch: '"deadbeef"' })).toEqual({
            ok: false,
            error: 'precondition',
        });
    });

    test('two racing PUTs with the same stale If-Match yield exactly one precondition failure', async () => {
        const { instance: contacts } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        const created = await put(contacts, uri, card({ uid, fn: 'V1' }));
        const stale = `"${(created as { etag: string }).etag}"`;

        const [a, b] = await Promise.all([
            put(contacts, uri, card({ uid, fn: 'V2' }), { ifMatch: stale }),
            put(contacts, uri, card({ uid, fn: 'V3' }), { ifMatch: stale }),
        ]);

        const results = [a, b];
        expect(results.filter((r) => r.ok).length).toBe(1);
        expect(results.filter((r) => !r.ok && r.error === 'precondition').length).toBe(1);
    });
});

describe('putCard — precondition shapes (RFC 7232)', () => {
    const seed = async (contacts: Contacts) => {
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        const res = await put(contacts, uri, card({ uid }));
        return { uid, uri, etag: (res as { etag: string }).etag };
    };

    test('If-Match:* succeeds against an existing card (means "exists", not a literal etag)', async () => {
        const { instance: contacts } = await makeContacts();
        const { uid, uri } = await seed(contacts);
        const res = await put(contacts, uri, card({ uid, fn: 'Updated' }), { ifMatch: '*' });
        expect(res.ok).toBe(true);
        expect((res as { created: boolean }).created).toBe(false);
    });

    test('If-Match:* against a missing card is a precondition failure', async () => {
        const { instance: contacts } = await makeContacts();
        const uid = randomUUID();
        expect(await put(contacts, `${uid}.vcf`, card({ uid }), { ifMatch: '*' })).toEqual({
            ok: false,
            error: 'precondition',
        });
    });

    test('If-Match with a multi-etag list matches any member', async () => {
        const { instance: contacts } = await makeContacts();
        const { uid, uri, etag } = await seed(contacts);
        const res = await put(contacts, uri, card({ uid, fn: 'Updated' }), { ifMatch: `"deadbeef", "${etag}"` });
        expect(res.ok).toBe(true);
    });

    test('a specific If-None-Match matching the current etag is a precondition failure', async () => {
        const { instance: contacts } = await makeContacts();
        const { uid, uri, etag } = await seed(contacts);
        expect(await put(contacts, uri, card({ uid, fn: 'Updated' }), { ifNoneMatch: `"${etag}"` })).toEqual({
            ok: false,
            error: 'precondition',
        });
    });

    test('a specific If-None-Match not matching the current etag succeeds', async () => {
        const { instance: contacts } = await makeContacts();
        const { uid, uri } = await seed(contacts);
        expect((await put(contacts, uri, card({ uid, fn: 'Updated' }), { ifNoneMatch: '"deadbeef"' })).ok).toBe(true);
    });

    test('deleteCard honors If-Match:* as an existence check', async () => {
        const { instance: contacts } = await makeContacts();
        const { uri } = await seed(contacts);
        expect(await contacts.deleteCard(uri, { ifMatch: '*' })).toEqual({ ok: true });
    });
});

describe('putCard — UID rules', () => {
    test('a body with no UID is invalid', async () => {
        const { instance: contacts } = await makeContacts();
        const res = await put(contacts, `${randomUUID()}.vcf`, card({}));
        expect(res).toEqual({ ok: false, error: 'invalid', message: 'UID is required' });
    });

    test('changing the UID of an existing card is a uid-conflict', async () => {
        const { instance: contacts } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await put(contacts, uri, card({ uid }));

        expect(await put(contacts, uri, card({ uid: randomUUID() }))).toEqual({ ok: false, error: 'uid-conflict' });
    });

    test('a second uri claiming an owned UID is a uid-conflict naming the holder', async () => {
        const { instance: contacts } = await makeContacts();
        const uid = randomUUID();
        const holder = `${uid}.vcf`;
        await put(contacts, holder, card({ uid }));

        expect(await put(contacts, `${randomUUID()}.vcf`, card({ uid }))).toEqual({
            ok: false,
            error: 'uid-conflict',
            conflictUri: holder,
        });
    });
});

describe('putCard — size ceiling', () => {
    test('a 5 MiB card is accepted and one byte more is too-large', async () => {
        const { instance: contacts } = await makeContacts();
        const uid = randomUUID();
        const prefix = `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:Big\r\nNOTE:`;
        const suffix = `\r\nEND:VCARD\r\n`;
        const pad = CARD_MAX_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
        const exact = prefix + 'a'.repeat(pad) + suffix;
        expect(Buffer.byteLength(exact)).toBe(CARD_MAX_BYTES);

        expect((await put(contacts, `${uid}.vcf`, exact)).ok).toBe(true);

        const over = prefix + 'a'.repeat(pad + 1) + suffix;
        expect(await put(contacts, `${randomUUID()}.vcf`, over)).toEqual({ ok: false, error: 'too-large' });
    });
});

describe('putCard — index projection', () => {
    test('a group card is indexed and served to DAV but hidden from the app list', async () => {
        const { instance: contacts } = await makeContacts();
        const db = contacts.db;
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await put(
            contacts,
            uri,
            card({ uid, n: 'Design Team;;;;', fn: 'Design Team', extra: ['X-ADDRESSBOOKSERVER-KIND:group'] }),
        );

        // Served to DAV: the group's uri is in the book listing and single-resource meta. Hidden from the
        // app: the row projects isGroup and getContacts drops it.
        expect((await contacts.listCards()).some((c) => c.uri === uri)).toBe(true);
        expect((await contacts.getCardMeta(uri))?.uri).toBe(uri);
        const row = rowByUri(db, uri)!;
        expect(row.isGroup).toBe(true);
        expect((await contacts.getContacts()).some((c) => c.id === row.id)).toBe(false);
    });

    test('an inline photo never leaks base64 into the row data JSON', async () => {
        const { instance: contacts } = await makeContacts();
        const db = contacts.db;
        const sharp = (await import('sharp')).default;
        const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 5, g: 5, b: 5 } } })
            .jpeg()
            .toBuffer();
        const b64 = jpeg.toString('base64');
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await put(contacts, uri, card({ uid, extra: [`PHOTO;ENCODING=b;TYPE=JPEG:${b64}`] }));

        const row = rowByUri(db, uri)!;
        expect(JSON.stringify(row.data)).not.toContain(b64.slice(0, 40));
        expect(row.data?.avatar).toContain('/avatar/');
    });

    test('a changed card is exactly what getChangedCardsSince reports past the prior ctag', async () => {
        const { instance: contacts } = await makeContacts();
        const before = (await contacts.getBook()).ctag;
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await put(contacts, uri, card({ uid }));

        const changed = await contacts.getChangedCardsSince(before);
        expect(changed.map((c) => c.uri)).toEqual([uri]);
    });
});

describe('putCard — announcements', () => {
    test('the event names the row the write landed on', async () => {
        const { instance: contacts, broadcasts } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        broadcasts.length = 0;

        await put(contacts, uri, card({ uid }));

        expect(broadcasts).toEqual([{ type: SSEventType.CONTACT_CREATED, contactId: rowByUri(contacts.db, uri)!.id }]);
    });

    test('a create whose delete is already queued behind it still announces both', async () => {
        const { instance: contacts, broadcasts } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        broadcasts.length = 0;

        // The delete takes the write lock the moment the create lets go of it, so an announcement that read
        // the row back after the lock would find nothing to name.
        const [created, deleted] = await Promise.all([
            put(contacts, uri, card({ uid })),
            contacts.deleteCard(uri, { ifMatch: null }),
        ]);

        expect(created.ok).toBe(true);
        expect(deleted.ok).toBe(true);
        // Sorted: what matters is that neither event is lost, not which lock got to announce first.
        expect(broadcasts.map((e) => e.type).sort()).toEqual([
            SSEventType.CONTACT_CREATED,
            SSEventType.CONTACT_DELETED,
        ]);
    });
});

describe('deleteCard', () => {
    test('a delete tombstones the uri and a later create at that uri clears it (single href)', async () => {
        const { instance: contacts } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await put(contacts, uri, card({ uid }));

        expect(await contacts.deleteCard(uri, { ifMatch: null })).toEqual({ ok: true });
        expect((await contacts.getDeletedCardsSince(0)).some((d) => d.uri === uri)).toBe(true);

        const afterDelete = (await contacts.getBook()).ctag;
        await put(contacts, uri, card({ uid: randomUUID() }));
        // The re-created uri is a change, never also a deletion, in the same window.
        expect((await contacts.getDeletedCardsSince(0)).some((d) => d.uri === uri)).toBe(false);
        expect((await contacts.getChangedCardsSince(afterDelete)).some((c) => c.uri === uri)).toBe(true);
    });

    test('deleting an unknown uri is not-found (DAV DELETE is not idempotent)', async () => {
        const { instance: contacts } = await makeContacts();
        expect(await contacts.deleteCard(`${randomUUID()}.vcf`, { ifMatch: null })).toEqual({
            ok: false,
            error: 'not-found',
        });
    });

    test('deleting your own card is refused as self-delete', async () => {
        const { instance: contacts, user } = await makeContacts();
        const db = contacts.db;
        const self = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.eigenId, user.id))
            .get()!;
        expect(await contacts.deleteCard(self.uri, { ifMatch: null })).toEqual({ ok: false, error: 'self-delete' });
    });

    test('a refused self-delete touches the self card so an ignoring client re-converges', async () => {
        const { instance: contacts, user } = await makeContacts();
        const db = contacts.db;
        const self = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.eigenId, user.id))
            .get()!;
        const preCtag = (await contacts.getBook()).ctag;

        expect(await contacts.deleteCard(self.uri, { ifMatch: null })).toEqual({ ok: false, error: 'self-delete' });

        // The refusal surfaces the self card in the next delta as a 200 change (bytes untouched — same etag),
        // never a tombstone, so a client that locally dropped it on the ignored 403 re-downloads it.
        const changed = await contacts.getChangedCardsSince(preCtag);
        const changedSelf = changed.find((c) => c.uri === self.uri);
        expect(changedSelf?.etag).toBe(self.etag);
        expect((await contacts.getDeletedCardsSince(preCtag)).some((d) => d.uri === self.uri)).toBe(false);
    });
});

describe('putCard — self-link', () => {
    test('a self-card PUT that strips X-EIGEN-ID keeps the indexed link and restores the property', async () => {
        const { instance: contacts, user } = await makeContacts();
        const db = contacts.db;
        const self = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.eigenId, user.id))
            .get()!;

        // A client round-trips the self card but drops the unknown X-EIGEN-ID property.
        const body = card({ uid: self.uid, email: [user.email] });
        expect(body).not.toContain('X-EIGEN-ID');

        // A self-card PUT renames the user org-wide; stub the relay so the unit test stays hermetic.
        const relay = await import('../../lib/home/home-relay');
        let pushed = false;
        const push = spyOn(relay, 'pushUserProfile').mockImplementation(async () => {
            pushed = true;
        });

        let res: Awaited<ReturnType<typeof put>>;
        try {
            res = await put(contacts, self.uri, body);
        } finally {
            push.mockRestore();
        }
        expect(res.ok).toBe(true);
        expect(pushed).toBe(true);

        // The server-owned self-link survives, and the stored bytes regain X-EIGEN-ID so file and index agree.
        const after = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.eigenId, user.id))
            .get()!;
        expect(after.id).toBe(self.id);
        const stored = new TextDecoder().decode((await contacts.getCard(self.uri))!.bytes);
        expect(stored).toContain(`X-EIGEN-ID:${user.id}`);
        // The restored property makes the stored bytes the server's, not the client's: no validator.
        expect((res as { etag: string | null }).etag).toBeNull();
        expect((await contacts.getMe())?.id).toBe(self.id);
    });

    test('a create forging X-EIGEN-ID indexes as a plain contact and leaves getMe pinned', async () => {
        const { instance: contacts, user } = await makeContacts();
        const db = contacts.db;
        const self = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.eigenId, user.id))
            .get()!;

        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await put(contacts, uri, card({ uid, eigenId: user.id, email: ['forger@example.org'] }));

        // The forged claim loses to the incumbent self row: it indexes with no link, and the file keeps the
        // verbatim (but inert) X-EIGEN-ID.
        expect(rowByUri(db, uri)!.eigenId).toBe('');
        expect(new TextDecoder().decode((await contacts.getCard(uri))!.bytes)).toContain(`X-EIGEN-ID:${user.id}`);
        expect((await contacts.getMe())?.id).toBe(self.id);
    });
});
