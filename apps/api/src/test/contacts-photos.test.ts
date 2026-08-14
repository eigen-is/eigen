import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Contact } from '@workspace/lib/types/contact';
import type { SSEvent } from '@workspace/lib/types/sse';
import type { ParsedCardPhoto } from '../lib/carddav/vcard-parse';
import { parseVCard } from '../lib/carddav/vcard-parse';
import { computeCardEtag } from '../lib/contacts/card-store';
import { Contacts } from '../lib/contacts/contacts';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../lib/core';
import type { Home } from '../lib/home';

const TEST_DIR = join(import.meta.dir, `../../../../data-test/test-contacts-photos-${Date.now()}`);
let counter = 0;

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => {
    try {
        rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
});

// Isolated Contacts instance over a temp home dir — the card-store.test.ts pattern: a stub Home supplies
// only the members Contacts touches (a memoized getLocalDatabase, the current user, a broadcast sink).
async function makeContacts() {
    const dir = join(TEST_DIR, `home-${counter++}`);
    const broadcasts: SSEvent[] = [];
    const user = { id: randomUUID(), email: `me-${counter}@test.local`, name: 'Ada Lovelace' };
    const dbCache = new Map<string, Promise<ManagedDatabase<SchemaType>>>();
    const getLocalDatabase = ((config: DatabaseConfig<SchemaType>, relativePath: string) => {
        let entry = dbCache.get(relativePath);
        if (!entry) {
            entry = (async () => {
                const mdb = new ManagedDatabase(config, join(dir, relativePath));
                await mdb.open(0);
                return mdb;
            })();
            dbCache.set(relativePath, entry);
        }
        return entry;
    }) as Home['getLocalDatabase'];
    const home = {
        homeDir: dir,
        user,
        getLocalDatabase,
        broadcast: (e: SSEvent) => broadcasts.push(e),
    } as unknown as Home;
    const contacts = new Contacts(home);
    await contacts.init();
    return { contacts, broadcasts, user, dir };
}

const validContact = (over: Partial<Omit<Contact, 'id'>>): Omit<Contact, 'id'> => ({
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: ['ada@example.com'],
    phone: [],
    ...over,
});

// A real image through the staging endpoint, exactly as the REST avatar upload does: uploadAvatar
// transcodes it to a webp and returns the `contacts/{userId}/avatar/{uuid}.webp` staged URL.
async function stageAvatar(contacts: Contacts): Promise<string> {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 120, b: 200 } } })
        .png()
        .toBuffer();
    return contacts.uploadAvatar(new File([png], 'avatar.png', { type: 'image/png' }));
}

const cardPathOf = (dir: string, id: string) => join(dir, 'eigen.contacts', 'cards', `${id}.vcf`);
const avatarsDirOf = (dir: string) => join(dir, 'eigen.contacts', 'avatars');
// The folded PHOTO logical line's exact source bytes: the property line plus every space-prefixed continuation.
const photoBlock = (raw: string) => raw.match(/PHOTO[^\r\n]*(?:\r\n[ \t][^\r\n]*)*/)?.[0] ?? '';

describe('Contacts inline PHOTO / derived avatar cache', () => {
    test('addContact embeds a JPEG PHOTO and derives a hash-named webp cache', async () => {
        const { contacts, user, dir } = await makeContacts();
        const staged = await stageAvatar(contacts);

        const id = await contacts.addContact(validContact({ firstName: 'Pic', lastName: 'Haver', avatar: staged }));

        // The card file carries an inline PHOTO whose decoded bytes are a real JPEG (FF D8) — Apple Contacts
        // cannot decode webp, so the canonical embed is JPEG.
        const raw = readFileSync(cardPathOf(dir, id), 'utf8');
        expect(raw).toContain('PHOTO;ENCODING=b;TYPE=JPEG');
        const photo = parseVCard(raw).photo;
        expect(photo?.kind).toBe('inline');
        const bytes = (photo as Extract<ParsedCardPhoto, { kind: 'inline' }>).bytes;
        expect(bytes[0]).toBe(0xff);
        expect(bytes[1]).toBe(0xd8);

        // The derived cache is <id>-<hash8>.webp, hash8 = first 8 hex of the sha256 of the embedded JPEG bytes.
        const cacheName = `${id}-${computeCardEtag(bytes).slice(0, 8)}.webp`;
        expect(existsSync(join(avatarsDirOf(dir), cacheName))).toBe(true);

        // The projection avatar URL points at that hashed cache file.
        const stored = await contacts.getContactById(id);
        expect(stored?.avatar).toBe(`contacts/${user.id}/avatar/${cacheName}`);
    });

    test('updating without changing the avatar leaves the PHOTO bytes byte-identical', async () => {
        const { contacts, dir } = await makeContacts();
        const staged = await stageAvatar(contacts);
        const id = await contacts.addContact(validContact({ firstName: 'Keep', lastName: 'Same', avatar: staged }));

        const before = photoBlock(readFileSync(cardPathOf(dir, id), 'utf8'));
        expect(before).not.toBe('');

        // The app echoes back the stored cache URL when the photo is untouched; only the name changes here.
        const stored = await contacts.getContactById(id);
        await contacts.updateContact(
            id,
            validContact({ firstName: 'Keep', lastName: 'Renamed', avatar: stored?.avatar }),
        );

        expect(photoBlock(readFileSync(cardPathOf(dir, id), 'utf8'))).toBe(before);
    });

    test('a changed avatar whose staged file is gone fails the save and keeps the existing photo', async () => {
        const { contacts, user, dir } = await makeContacts();
        const staged = await stageAvatar(contacts);
        const id = await contacts.addContact(validContact({ firstName: 'Hold', lastName: 'Photo', avatar: staged }));

        const photoBefore = photoBlock(readFileSync(cardPathOf(dir, id), 'utf8'));
        const avatarBefore = (await contacts.getContactById(id))?.avatar;
        expect(photoBefore).not.toBe('');
        expect(avatarBefore).not.toBe('');

        // A non-empty avatar URL that differs from the stored cache URL but points at no staged file — the
        // shape cleanupAvatarImages leaves when it sweeps a freshly-staged-but-unsaved file. Silently clearing
        // the existing photo would lose it, so the save must hard-fail.
        await expect(
            contacts.updateContact(
                id,
                validContact({ firstName: 'Hold', lastName: 'Photo', avatar: `contacts/${user.id}/avatar/gone.webp` }),
            ),
        ).rejects.toThrow('Avatar upload could not be found');

        // The throw is before the file write: the PHOTO line and the projection URL are untouched.
        expect(photoBlock(readFileSync(cardPathOf(dir, id), 'utf8'))).toBe(photoBefore);
        expect((await contacts.getContactById(id))?.avatar).toBe(avatarBefore);
    });

    test('clearing the avatar removes the PHOTO line and empties the projection URL', async () => {
        const { contacts, dir } = await makeContacts();
        const staged = await stageAvatar(contacts);
        const id = await contacts.addContact(validContact({ firstName: 'Drop', lastName: 'Pic', avatar: staged }));
        expect(readFileSync(cardPathOf(dir, id), 'utf8')).toContain('PHOTO');

        await contacts.updateContact(id, validContact({ firstName: 'Drop', lastName: 'Pic', avatar: '' }));

        expect(readFileSync(cardPathOf(dir, id), 'utf8')).not.toContain('PHOTO');
        expect((await contacts.getContactById(id))?.avatar).toBe('');
    });

    test('cacheCardPhoto with a uri-kind photo returns empty and writes nothing', async () => {
        const { contacts, dir } = await makeContacts();
        const priv = contacts as unknown as {
            cacheCardPhoto(contactId: string, photo: ParsedCardPhoto | null): Promise<string>;
        };
        const before = readdirSync(avatarsDirOf(dir)).length;

        const url = await priv.cacheCardPhoto(randomUUID(), { kind: 'uri', uri: 'https://example.com/remote.jpg' });

        expect(url).toBe('');
        expect(readdirSync(avatarsDirOf(dir)).length).toBe(before);
    });
});
