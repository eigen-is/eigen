import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { CARD_MAX_BYTES, computeCardEtag, uriKeyOf } from '../lib/contacts/card-store';
import type { Contacts } from '../lib/contacts/contacts';
import * as contactsSchema from '../lib/contacts/schema';
import { CONTACTS_TEST_ROOT, cardsDirOf, makeContacts } from './contacts-test-helpers';

afterAll(() => {
    try {
        rmSync(CONTACTS_TEST_ROOT, { recursive: true, force: true });
    } catch {}
});

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

const rowByUri = (db: Awaited<ReturnType<typeof makeContacts>>['db'], uri: string) =>
    db
        .select()
        .from(contactsSchema.contacts)
        .where(eq(contactsSchema.contacts.uriKey, uriKeyOf(uri)))
        .get();

const put = (
    contacts: Contacts,
    uri: string,
    body: string,
    pre?: { ifMatch?: string | null; ifNoneMatch?: string | null },
) => contacts.putCard(uri, body, { ifMatch: pre?.ifMatch ?? null, ifNoneMatch: pre?.ifNoneMatch ?? null });

describe('putCard — create and read', () => {
    test('a create returns created:true and an etag hashing the stored bytes', async () => {
        const { contacts } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        const body = card({ uid, email: ['stranger@example.org'] });

        const res = await put(contacts, uri, body);

        expect(res).toEqual({ ok: true, etag: computeCardEtag(new TextEncoder().encode(body)), created: true });
    });

    test('getCard returns a 3.0 body byte-identically, folded X-props and all', async () => {
        const { contacts } = await makeContacts();
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
        const { contacts } = await makeContacts();
        expect(await contacts.getCard(`${randomUUID()}.vcf`)).toBeNull();
    });

    test('getCard whose file vanished returns null and marks the uri for the next drain', async () => {
        const { contacts, dir } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await put(contacts, uri, card({ uid, email: ['gone@example.org'] }));
        rmSync(`${dir}/eigen.contacts/cards/${uri}`);

        expect(await contacts.getCard(uri)).toBeNull();
        // The vanished file is drained on the next read: the row is tombstoned and drops out of the list.
        expect((await contacts.listCards()).some((c) => c.uri === uri)).toBe(false);
    });
});

describe('putCard — path safety', () => {
    test('a traversal uri never becomes a filesystem path and is refused as invalid', async () => {
        const { contacts } = await makeContacts();
        const res = await put(contacts, '../contacts.db', card({ uid: randomUUID() }));

        expect(res).toEqual({ ok: false, error: 'invalid' });
        // Nothing was written or indexed under the traversal name — the index db is untouched.
        expect((await contacts.listCards()).some((c) => c.uri === '../contacts.db')).toBe(false);
        expect(await contacts.getCard('../contacts.db')).toBeNull();
    });

    test('a dot-prefixed uri is refused as invalid', async () => {
        const { contacts } = await makeContacts();
        expect(await put(contacts, '.hidden.vcf', card({ uid: randomUUID() }))).toEqual({
            ok: false,
            error: 'invalid',
        });
    });
});

describe('putCard — case-variant uri (incumbent spelling wins)', () => {
    test('a case-variant update rewrites the incumbent file in place and reconcile leaves it', async () => {
        const { contacts, db, dir } = await makeContacts();
        const uid = randomUUID();

        // Create under a mixed-case spelling, then PUT the same card (same UID) under a different case.
        expect((await put(contacts, 'Abc.vcf', card({ uid, email: ['first@example.org'] }))).ok).toBe(true);
        expect((await put(contacts, 'abc.vcf', card({ uid, email: ['second@example.org'] }))).ok).toBe(true);

        // Exactly one file backs this card, still under the incumbent spelling — no stale sibling stranded on
        // a case-sensitive fs (the seeded self-card is filtered out by folding to the same key).
        const cardFiles = readdirSync(cardsDirOf(dir)).filter((n) => uriKeyOf(n) === uriKeyOf('abc.vcf'));
        expect(cardFiles).toEqual(['Abc.vcf']);

        // The index keeps the incumbent spelling (uri AND uriKey), so a case-sensitive reconcile that sorts
        // 'Abc.vcf' first cannot warn-skip the accepted write and re-index the row from the stale bytes.
        const row = rowByUri(db, 'ABC.vcf')!;
        expect(row.uri).toBe('Abc.vcf');
        expect(row.uriKey).toBe(uriKeyOf('Abc.vcf'));

        // getCard (any case) returns the second PUT's bytes.
        const got = await contacts.getCard('ABC.vcf');
        const stored = new TextDecoder().decode(got!.bytes);
        expect(stored).toContain('second@example.org');
        expect(stored).not.toContain('first@example.org');

        // A stat-only reconcile changes nothing: no re-parse, stable etag.
        const parsesBefore = contacts.cardParseCount;
        await contacts.reconcileIndex();
        expect(contacts.cardParseCount).toBe(parsesBefore);
        expect((await contacts.getCard('ABC.vcf'))!.etag).toBe(got!.etag);
    });
});

describe('putCard — 4.0 transcode', () => {
    test('a 4.0 PUT is stored as 3.0 with the photo in ENCODING=b form', async () => {
        const { contacts } = await makeContacts();
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
        // The etag hashes the stored 3.0 bytes, not the 4.0 input, so an honest client re-converges on GET.
        expect((res as { etag: string }).etag).toBe(computeCardEtag((await contacts.getCard(uri))!.bytes));
    });
});

describe('putCard — preconditions', () => {
    test('If-None-Match:* against an existing card is a precondition failure', async () => {
        const { contacts } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await put(contacts, uri, card({ uid }));

        expect(await put(contacts, uri, card({ uid, fn: 'Nope' }), { ifNoneMatch: '*' })).toEqual({
            ok: false,
            error: 'precondition',
        });
    });

    test('a stale If-Match is a precondition failure', async () => {
        const { contacts } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await put(contacts, uri, card({ uid }));

        expect(await put(contacts, uri, card({ uid, fn: 'Nope' }), { ifMatch: '"deadbeef"' })).toEqual({
            ok: false,
            error: 'precondition',
        });
    });

    test('two racing PUTs with the same stale If-Match yield exactly one precondition failure', async () => {
        const { contacts } = await makeContacts();
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
        const { contacts } = await makeContacts();
        const { uid, uri } = await seed(contacts);
        const res = await put(contacts, uri, card({ uid, fn: 'Updated' }), { ifMatch: '*' });
        expect(res.ok).toBe(true);
        expect((res as { created: boolean }).created).toBe(false);
    });

    test('If-Match:* against a missing card is a precondition failure', async () => {
        const { contacts } = await makeContacts();
        const uid = randomUUID();
        expect(await put(contacts, `${uid}.vcf`, card({ uid }), { ifMatch: '*' })).toEqual({
            ok: false,
            error: 'precondition',
        });
    });

    test('If-Match with a multi-etag list matches any member', async () => {
        const { contacts } = await makeContacts();
        const { uid, uri, etag } = await seed(contacts);
        const res = await put(contacts, uri, card({ uid, fn: 'Updated' }), { ifMatch: `"deadbeef", "${etag}"` });
        expect(res.ok).toBe(true);
    });

    test('a specific If-None-Match matching the current etag is a precondition failure', async () => {
        const { contacts } = await makeContacts();
        const { uid, uri, etag } = await seed(contacts);
        expect(await put(contacts, uri, card({ uid, fn: 'Updated' }), { ifNoneMatch: `"${etag}"` })).toEqual({
            ok: false,
            error: 'precondition',
        });
    });

    test('a specific If-None-Match not matching the current etag succeeds', async () => {
        const { contacts } = await makeContacts();
        const { uid, uri } = await seed(contacts);
        expect((await put(contacts, uri, card({ uid, fn: 'Updated' }), { ifNoneMatch: '"deadbeef"' })).ok).toBe(true);
    });

    test('deleteCard honors If-Match:* as an existence check', async () => {
        const { contacts } = await makeContacts();
        const { uri } = await seed(contacts);
        expect(await contacts.deleteCard(uri, { ifMatch: '*' })).toEqual({ ok: true });
    });
});

describe('putCard — UID rules', () => {
    test('a body with no UID is invalid', async () => {
        const { contacts } = await makeContacts();
        const res = await put(contacts, `${randomUUID()}.vcf`, card({}));
        expect(res).toEqual({ ok: false, error: 'invalid', message: 'UID is required' });
    });

    test('changing the UID of an existing card is a uid-conflict', async () => {
        const { contacts } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await put(contacts, uri, card({ uid }));

        expect(await put(contacts, uri, card({ uid: randomUUID() }))).toEqual({ ok: false, error: 'uid-conflict' });
    });

    test('a second uri claiming an owned UID is a uid-conflict', async () => {
        const { contacts } = await makeContacts();
        const uid = randomUUID();
        await put(contacts, `${uid}.vcf`, card({ uid }));

        expect(await put(contacts, `${randomUUID()}.vcf`, card({ uid }))).toEqual({ ok: false, error: 'uid-conflict' });
    });
});

describe('putCard — size ceiling', () => {
    test('a 5 MiB card is accepted and one byte more is too-large', async () => {
        const { contacts } = await makeContacts();
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
        const { contacts, db } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await put(
            contacts,
            uri,
            card({ uid, n: 'Design Team;;;;', fn: 'Design Team', extra: ['X-ADDRESSBOOKSERVER-KIND:group'] }),
        );

        expect((await contacts.listCards()).some((c) => c.uri === uri && c.isGroup)).toBe(true);
        const row = rowByUri(db, uri)!;
        expect(row.isGroup).toBe(true);
        expect((await contacts.getContacts()).some((c) => c.id === row.id)).toBe(false);
    });

    test('an inline photo never leaks base64 into the row data JSON', async () => {
        const { contacts, db } = await makeContacts();
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
        const { contacts } = await makeContacts();
        const before = (await contacts.getBook()).ctag;
        const uid = randomUUID();
        const uri = `${uid}.vcf`;
        await put(contacts, uri, card({ uid }));

        const changed = await contacts.getChangedCardsSince(before);
        expect(changed.map((c) => c.uri)).toEqual([uri]);
    });
});

describe('deleteCard', () => {
    test('a delete tombstones the uri and a later create at that uri clears it (single href)', async () => {
        const { contacts } = await makeContacts();
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
        const { contacts } = await makeContacts();
        expect(await contacts.deleteCard(`${randomUUID()}.vcf`, { ifMatch: null })).toEqual({
            ok: false,
            error: 'not-found',
        });
    });

    test('deleting your own card is refused as self-delete', async () => {
        const { contacts, db, user } = await makeContacts();
        const self = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.eigenId, user.id))
            .get()!;
        expect(await contacts.deleteCard(self.uri, { ifMatch: null })).toEqual({ ok: false, error: 'self-delete' });
    });
});

describe('putCard — self-link', () => {
    test('a self-card PUT that strips X-EIGEN-ID keeps the indexed link and restores the property', async () => {
        const { contacts, db, user } = await makeContacts();
        const self = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.eigenId, user.id))
            .get()!;

        // A client round-trips the self card but drops the unknown X-EIGEN-ID property.
        const body = card({ uid: self.uid, email: [user.email] });
        expect(body).not.toContain('X-EIGEN-ID');

        // A self-card PUT renames the user org-wide; stub the relay so the unit test stays hermetic.
        const relay = await import('../lib/home/home-relay');
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
        expect((res as { etag: string }).etag).toBe(computeCardEtag(new TextEncoder().encode(stored)));
        expect((await contacts.getMe())?.id).toBe(self.id);
    });

    test('a create forging X-EIGEN-ID indexes as a plain contact and leaves getMe pinned', async () => {
        const { contacts, db, user } = await makeContacts();
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

describe('putCard — fail-closed', () => {
    test('a commit failure marks the card dirty and the next read heals it', async () => {
        const { contacts } = await makeContacts();
        const uid = randomUUID();
        const uri = `${uid}.vcf`;

        const priv = contacts as unknown as { commitCard: (o: unknown) => void };
        const origCommit = priv.commitCard;
        let thrown = false;
        priv.commitCard = function (this: Contacts, o: unknown) {
            if (!thrown) {
                thrown = true;
                throw new Error('commit boom');
            }
            return origCommit.call(this, o);
        };
        await expect(put(contacts, uri, card({ uid, email: ['heal@example.org'] }))).rejects.toThrow('commit boom');
        priv.commitCard = origCommit;

        // The file wrote but the index commit threw; the next read drains the dirty set and indexes it.
        expect((await contacts.listCards()).some((c) => c.uri === uri)).toBe(true);
    });
});
