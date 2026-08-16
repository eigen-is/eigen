import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { ParsedCardPhoto } from '../lib/carddav/vcard-parse';
import { parseVCard } from '../lib/carddav/vcard-parse';
import { computeCardEtag } from '../lib/contacts/card-store';
import type { Contacts } from '../lib/contacts/contacts';
import * as contactsSchema from '../lib/contacts/schema';
import { CONTACTS_TEST_ROOT, makeContacts, stageAvatar, validContact } from './contacts-test-helpers';

afterAll(() => {
    try {
        rmSync(CONTACTS_TEST_ROOT, { recursive: true, force: true });
    } catch {}
});

const cardPathOf = (dir: string, id: string) => join(dir, 'eigen.contacts', 'cards', `${id}.vcf`);
const avatarsDirOf = (dir: string) => join(dir, 'eigen.contacts', 'avatars');
// What the book actually occupies on disk — the truth size() must keep answering from its running totals.
const diskBytesOf = (dir: string) =>
    [join(dir, 'eigen.contacts', 'cards'), avatarsDirOf(dir)]
        .filter((d) => existsSync(d))
        .flatMap((d) => readdirSync(d).map((name) => statSync(join(d, name)).size))
        .reduce((sum, size) => sum + size, 0);
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

    test('an animated avatar embeds its first frame, not a stacked filmstrip', async () => {
        const { contacts, dir } = await makeContacts();
        const sharp = (await import('sharp')).default;
        const frames = await Promise.all(
            [
                { r: 220, g: 20, b: 20 },
                { r: 20, g: 220, b: 20 },
                { r: 20, g: 20, b: 220 },
            ].map((background) =>
                sharp({ create: { width: 64, height: 64, channels: 3, background } })
                    .png()
                    .toBuffer(),
            ),
        );
        const gif = await sharp(frames, { join: { animated: true } })
            .gif()
            .toBuffer();
        const staged = await contacts.uploadAvatar(
            new File([new Uint8Array(gif)], 'avatar.gif', { type: 'image/gif' }),
        );

        const id = await contacts.addContact(validContact({ firstName: 'Anim', lastName: 'Gif', avatar: staged }));

        // JPEG cannot hold animation: reading the staged webp's three pages at once would stack them into one
        // 512x1536 strip, which Apple Contacts renders as a filmstrip.
        const photo = parseVCard(readFileSync(cardPathOf(dir, id), 'utf8')).photo;
        const bytes = (photo as Extract<ParsedCardPhoto, { kind: 'inline' }>).bytes;
        const meta = await sharp(bytes).metadata();
        expect(meta.width).toBe(512);
        expect(meta.height).toBe(512);
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

    test('deleting a contact removes only its derived avatar and keeps size accounting exact', async () => {
        const { contacts, db, dir, user } = await makeContacts();
        const labelId = await contacts.addLabel({ name: 'Delete Photo', color: '#123456' });
        const deletedId = await contacts.addContact(
            validContact({ firstName: 'Delete', avatar: await stageAvatar(contacts), labels: [labelId] }),
        );
        const keptId = await contacts.addContact(
            validContact({ firstName: 'Keep', avatar: await stageAvatar(contacts) }),
        );
        const deletedRow = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.id, deletedId))
            .get()!;
        const selfRow = db
            .select()
            .from(contactsSchema.contacts)
            .where(eq(contactsSchema.contacts.eigenId, user.id))
            .get()!;
        const deletedAvatar = (await contacts.getContactById(deletedId))!.avatar!.split('/').pop()!;
        const keptAvatar = (await contacts.getContactById(keptId))!.avatar!.split('/').pop()!;
        const deletedAvatarPath = join(avatarsDirOf(dir), deletedAvatar);
        const keptAvatarPath = join(avatarsDirOf(dir), keptAvatar);
        const sizeBefore = await contacts.size();
        const deletedAvatarBytes = statSync(deletedAvatarPath).size;

        expect(
            db
                .select()
                .from(contactsSchema.contactsToLabels)
                .where(eq(contactsSchema.contactsToLabels.contactId, deletedId))
                .all(),
        ).toHaveLength(1);
        expect(existsSync(keptAvatarPath)).toBe(true);

        await contacts.deleteContact(deletedId);

        expect(existsSync(cardPathOf(dir, deletedId))).toBe(false);
        expect(existsSync(deletedAvatarPath)).toBe(false);
        expect(existsSync(keptAvatarPath)).toBe(true);
        expect(existsSync(join(dir, 'eigen.contacts', 'cards', selfRow.uri))).toBe(true);
        expect(
            db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, deletedId)).get(),
        ).toBeUndefined();
        expect(
            db
                .select()
                .from(contactsSchema.contactsToLabels)
                .where(eq(contactsSchema.contactsToLabels.contactId, deletedId))
                .all(),
        ).toEqual([]);
        expect(await contacts.size()).toBe(sizeBefore - deletedRow.size - deletedAvatarBytes);
    });

    test('deleting one of two legacy rows sharing a staged avatar leaves the file and survivor', async () => {
        const { contacts, db, dir } = await makeContacts();
        const sharedAvatar = await stageAvatar(contacts);
        const deletedId = await contacts.addContact(validContact({ firstName: 'Delete Shared' }));
        const keptId = await contacts.addContact(validContact({ firstName: 'Keep Shared' }));

        for (const id of [deletedId, keptId]) {
            const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;
            db.update(contactsSchema.contacts)
                .set({ data: { ...row.data!, avatar: sharedAvatar } })
                .where(eq(contactsSchema.contacts.id, id))
                .run();
        }

        const sharedName = sharedAvatar.split('/').pop()!;
        const sharedPath = join(avatarsDirOf(dir), sharedName);
        expect(existsSync(sharedPath)).toBe(true);

        await contacts.deleteContact(deletedId);

        expect(existsSync(sharedPath)).toBe(true);
        expect((await contacts.getContactById(keptId))?.avatar).toBe(sharedAvatar);
        expect(await contacts.downloadAvatar(sharedName)).not.toBeNull();
    });

    test('a derived-avatar cleanup failure does not fail a committed contact deletion', async () => {
        const { contacts, db, dir } = await makeContacts();
        const id = await contacts.addContact(
            validContact({ firstName: 'Cache Failure', avatar: await stageAvatar(contacts) }),
        );
        const row = db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get()!;
        const avatar = (await contacts.getContactById(id))!.avatar!.split('/').pop()!;
        const avatarPath = join(avatarsDirOf(dir), avatar);
        const sizeBefore = await contacts.size();
        const storage = (contacts as unknown as { storage: { unlink: (filePath: string) => Promise<void> } }).storage;
        const originalUnlink = storage.unlink;
        const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
        storage.unlink = async (filePath) => {
            if (filePath.startsWith('avatars/')) throw new Error('avatar unlink boom');
            return originalUnlink.call(storage, filePath);
        };

        try {
            await contacts.deleteContact(id);
            expect(errorSpy).toHaveBeenCalledWith(
                `contacts: failed to delete derived avatar ${avatar}:`,
                expect.any(Error),
            );
        } finally {
            storage.unlink = originalUnlink;
            errorSpy.mockRestore();
        }

        expect(existsSync(cardPathOf(dir, id))).toBe(false);
        expect(existsSync(avatarPath)).toBe(true);
        expect(
            db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get(),
        ).toBeUndefined();
        expect(await contacts.size()).toBe(sizeBefore - row.size);
    });

    test('re-deriving the same photo replaces its cache file instead of double-counting it', async () => {
        const { contacts, dir } = await makeContacts();
        const priv = contacts as unknown as {
            cacheCardPhoto(contactId: string, photo: ParsedCardPhoto | null): Promise<string>;
            cleanupAvatarImages(): Promise<void>;
        };
        // Settle init's detached sweep so the running total starts out equal to what is on disk.
        await priv.cleanupAvatarImages();
        const sharp = (await import('sharp')).default;
        const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 9, g: 9, b: 9 } } })
            .jpeg()
            .toBuffer();
        const photo = { kind: 'inline', bytes: new Uint8Array(jpeg), mediaType: 'image/jpeg' } as const;
        const contactId = randomUUID();

        const first = await priv.cacheCardPhoto(contactId, photo);
        const second = await priv.cacheCardPhoto(contactId, photo);

        // Same bytes, same hash, same file — the second write replaced the first one's bytes.
        expect(second).toBe(first);
        expect(readdirSync(avatarsDirOf(dir)).filter((n) => n.startsWith(contactId))).toHaveLength(1);
        expect(await contacts.size()).toBe(diskBytesOf(dir));
    });

    test('the avatar sweep holds the write lock, so a card write cannot interleave its recount', async () => {
        const { contacts, dir } = await makeContacts();
        const id = await contacts.addContact(validContact({ firstName: 'Swept', avatar: await stageAvatar(contacts) }));
        const priv = contacts as unknown as {
            cleanupAvatarImages(): Promise<void>;
            storage: { dirSize(dirPath: string): Promise<number> };
        };
        await priv.cleanupAvatarImages();

        // Park the sweep on its closing recount; while it waits there it must still own the write lock.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const originalDirSize = priv.storage.dirSize;
        let gated = true;
        priv.storage.dirSize = async (dirPath: string) => {
            if (gated) {
                gated = false;
                await gate;
            }
            return originalDirSize.call(priv.storage, dirPath);
        };

        try {
            const sweep = priv.cleanupAvatarImages();
            let deleted = false;
            const deletion = contacts.deleteContact(id).then(() => {
                deleted = true;
            });
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Unserialized, the delete's byte credit lands inside the scan and the recount overwrites it.
            expect(deleted).toBe(false);

            release();
            await Promise.all([sweep, deletion]);
        } finally {
            release();
            priv.storage.dirSize = originalDirSize;
        }

        expect(await contacts.size()).toBe(diskBytesOf(dir));
    });

    test('downloadAvatar serves only the staged and derived cache-name shapes', async () => {
        const { contacts, dir } = await makeContacts();
        const staged = (await stageAvatar(contacts)).split('/').pop()!;
        const derived = `${randomUUID()}-0123abcd.webp`;
        // Names outside those two shapes are refused even when the file is really there — a control
        // character or an arbitrary name never reaches the filesystem read.
        const rogue = ['evil\n.webp', 'plain.webp', `${randomUUID()}.png`, `${randomUUID()}-XY.webp`];
        for (const name of [derived, ...rogue]) writeFileSync(join(avatarsDirOf(dir), name), 'x');

        expect(await contacts.downloadAvatar(staged)).not.toBeNull();
        expect(await contacts.downloadAvatar(derived)).not.toBeNull();
        for (const name of rogue) expect(await contacts.downloadAvatar(name)).toBeNull();
        expect(await contacts.downloadAvatar('../contacts.db')).toBeNull();
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
