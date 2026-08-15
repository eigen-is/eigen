import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ParsedCardPhoto } from '../lib/carddav/vcard-parse';
import { parseVCard } from '../lib/carddav/vcard-parse';
import { computeCardEtag } from '../lib/contacts/card-store';
import type { Contacts } from '../lib/contacts/contacts';
import { CONTACTS_TEST_ROOT, makeContacts, stageAvatar, validContact } from './contacts-test-helpers';

afterAll(() => {
    try {
        rmSync(CONTACTS_TEST_ROOT, { recursive: true, force: true });
    } catch {}
});

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

    test('a create whose staged avatar is gone fails before writing any card', async () => {
        const { contacts, user, dir } = await makeContacts();
        const cardsDir = join(dir, 'eigen.contacts', 'cards');
        const before = existsSync(cardsDir) ? readdirSync(cardsDir).length : 0;

        await expect(
            contacts.addContact(validContact({ firstName: 'NoPic', avatar: `contacts/${user.id}/avatar/gone.webp` })),
        ).rejects.toThrow('Avatar upload could not be found');

        // The guard fires before writeCardFile — no new card landed on disk, and nothing was indexed.
        const after = existsSync(cardsDir) ? readdirSync(cardsDir).length : 0;
        expect(after).toBe(before);
        expect((await contacts.getContacts()).some((c) => c.firstName === 'NoPic')).toBe(false);
    });

    test('a failed create with an inline photo heals on drain with its avatar cache', async () => {
        const { contacts, dir } = await makeContacts();
        const staged = await stageAvatar(contacts);

        // Make the first commit throw after the card file and its photo cache are already written.
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
        await expect(
            contacts.addContact(validContact({ firstName: 'Healed', lastName: 'Photo', avatar: staged })),
        ).rejects.toThrow('commit boom');
        priv.commitCard = origCommit;

        // The next read drains the orphan through the shared prepare path: the healed row carries the derived
        // avatar URL and its hash-named cache file exists on disk.
        const healed = (await contacts.getContacts()).find((c) => c.firstName === 'Healed')!;
        expect(healed).toBeTruthy();
        expect(healed.avatar).toContain(`/avatar/${healed.id}-`);
        const cacheName = healed.avatar!.split('/').pop()!;
        expect(existsSync(join(avatarsDirOf(dir), cacheName))).toBe(true);
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
