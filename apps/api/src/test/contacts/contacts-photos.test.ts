import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomFillSync, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { deriveCardPhotoCache } from '../../lib/contacts/avatars';
import type { Contacts } from '../../lib/contacts/contacts';
import * as contactsSchema from '../../lib/contacts/schema';
import { computeResourceEtag } from '../../lib/core';
import { createVCard, parseVCard } from '../../lib/vcard';
import type { ParsedCardPhoto } from '../../lib/vcard/types';
import {
    avatarsDirOf,
    CONTACTS_TEST_ROOT,
    cardTextOf,
    makeContacts,
    stageAvatar,
    validContact,
} from '../contacts-test-helpers';

// What the avatar cache actually occupies on disk — the half of size() that is still files.
const avatarBytesOf = (dir: string) =>
    (existsSync(avatarsDirOf(dir)) ? readdirSync(avatarsDirOf(dir)) : [])
        .map((name) => statSync(join(avatarsDirOf(dir), name)).size)
        .reduce((sum, size) => sum + size, 0);
// The stored bytes of every card, the other half.
const cardBytesOf = (db: Contacts['db']) =>
    db
        .select()
        .from(contactsSchema.contacts)
        .all()
        .reduce((sum, row) => sum + row.vcard.byteLength, 0);
// The folded PHOTO logical line's exact source bytes: the property line plus every space-prefixed continuation.
const photoBlock = (raw: string) => raw.match(/PHOTO[^\r\n]*(?:\r\n[ \t][^\r\n]*)*/)?.[0] ?? '';

describe('Contacts inline PHOTO / derived avatar cache', () => {
    beforeAll(() => {
        rmSync(CONTACTS_TEST_ROOT, { recursive: true, force: true });
    });

    test('addContact embeds a JPEG PHOTO and derives a hash-named webp cache', async () => {
        const { instance: contacts, user, dir } = await makeContacts();
        const staged = await stageAvatar(contacts);

        const id = await contacts.addContact(validContact({ firstName: 'Pic', lastName: 'Haver', avatar: staged }));

        // The stored card carries an inline PHOTO whose decoded bytes are a real JPEG (FF D8) — Apple Contacts
        // cannot decode webp, so the canonical embed is JPEG.
        const raw = await cardTextOf(contacts, `${id}.vcf`);
        expect(raw).toContain('PHOTO;ENCODING=b;TYPE=JPEG');
        const photo = parseVCard(raw).photo;
        expect(photo?.kind).toBe('inline');
        const bytes = (photo as Extract<ParsedCardPhoto, { kind: 'inline' }>).bytes;
        expect(bytes[0]).toBe(0xff);
        expect(bytes[1]).toBe(0xd8);

        // The derived cache is <id>-<hash8>.webp, hash8 = first 8 hex of the sha256 of the embedded JPEG bytes.
        const cacheName = `${id}-${computeResourceEtag(bytes).slice(0, 8)}.webp`;
        expect(existsSync(join(avatarsDirOf(dir), cacheName))).toBe(true);

        // The projection avatar URL points at that hashed cache file.
        const stored = await contacts.getContactById(id);
        expect(stored?.avatar).toBe(`contacts/${user.id}/avatar/${cacheName}`);
    });

    test('a PNG-with-alpha upload embeds a PNG PHOTO and serves a webp cache that keeps its alpha', async () => {
        const { instance: contacts } = await makeContacts();
        const sharp = (await import('sharp')).default;
        const pngAlpha = await sharp({
            create: { width: 40, height: 40, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0.5 } },
        })
            .png()
            .toBuffer();
        const staged = await contacts.uploadAvatar(
            new File([new Uint8Array(pngAlpha)], 'alpha.png', { type: 'image/png' }),
        );

        const id = await contacts.addContact(validContact({ firstName: 'Alpha', lastName: 'Png', avatar: staged }));

        // Transparency can't survive a JPEG embed, so an alpha source embeds as PNG (\x89PNG magic, TYPE=PNG),
        // and the decoded embed still carries an alpha channel.
        const raw = await cardTextOf(contacts, `${id}.vcf`);
        expect(raw).toContain('PHOTO;ENCODING=b;TYPE=PNG');
        const bytes = (parseVCard(raw).photo as Extract<ParsedCardPhoto, { kind: 'inline' }>).bytes;
        expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
        expect((await sharp(bytes).metadata()).hasAlpha).toBe(true);

        // The served cache is a webp that preserved the transparency (the promoted first-generation sibling),
        // never flattened onto a matte.
        const cacheName = (await contacts.getContactById(id))!.avatar!.split('/').pop()!;
        expect(cacheName.endsWith('.webp')).toBe(true);
        const cacheBytes = await contacts.downloadAvatar(cacheName);
        expect(cacheBytes).not.toBeNull();
        expect((await sharp(Buffer.from(cacheBytes!)).metadata()).hasAlpha).toBe(true);
    });

    test('an animated GIF upload embeds an animated GIF PHOTO', async () => {
        const { instance: contacts } = await makeContacts();
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

        // Animation survives into the embed now: PHOTO is a GIF (TYPE=GIF, "GIF" magic) carrying all three frames,
        // each a full 512px square — not a first-frame still and not a stacked filmstrip.
        const raw = await cardTextOf(contacts, `${id}.vcf`);
        expect(raw).toContain('PHOTO;ENCODING=b;TYPE=GIF');
        const bytes = (parseVCard(raw).photo as Extract<ParsedCardPhoto, { kind: 'inline' }>).bytes;
        expect([bytes[0], bytes[1], bytes[2]]).toEqual([0x47, 0x49, 0x46]);
        const meta = await sharp(bytes, { animated: true }).metadata();
        expect(meta.pages).toBe(3);
        expect(meta.width).toBe(512);
        expect(meta.pageHeight).toBe(512);
    });

    test('an animated GIF whose embed would exceed the size cap falls back to a first-frame JPEG', async () => {
        const { instance: contacts } = await makeContacts();
        const sharp = (await import('sharp')).default;
        // Seven full-resolution high-entropy frames: the 512px GIF re-encode clears the ~2 MiB embed cap, so
        // the save must fall back to a single-frame JPEG rather than embedding a multi-MiB GIF in every sync
        // of the card. This shape is the measured optimum — the source must be a GIF (the pipeline's GIF
        // re-encode reuses its palette; a truecolor or lossy source makes quantization ~10× slower) and the
        // noise must stay hard 512px noise. Still inherently heavy (~2.5s locally: >2 MiB of GIF encoded
        // twice plus an animated webp, across three one-shot sharp workers), hence the raised timeout.
        const frames: Buffer[] = [];
        for (let f = 0; f < 7; f++) {
            const raw = Buffer.allocUnsafe(512 * 512 * 3);
            randomFillSync(raw);
            frames.push(
                await sharp(raw, { raw: { width: 512, height: 512, channels: 3 } })
                    .png({ compressionLevel: 0 })
                    .toBuffer(),
            );
        }
        const gif = await sharp(frames, { join: { animated: true } })
            .gif({ dither: 0, effort: 1 })
            .toBuffer();
        const staged = await contacts.uploadAvatar(new File([new Uint8Array(gif)], 'big.gif', { type: 'image/gif' }));

        const id = await contacts.addContact(validContact({ firstName: 'Big', lastName: 'Gif', avatar: staged }));

        // A JPEG holds one frame — the fallback is the first frame at full 512px, not a stacked filmstrip.
        const raw = await cardTextOf(contacts, `${id}.vcf`);
        expect(raw).toContain('PHOTO;ENCODING=b;TYPE=JPEG');
        const bytes = (parseVCard(raw).photo as Extract<ParsedCardPhoto, { kind: 'inline' }>).bytes;
        expect(bytes[0]).toBe(0xff);
        expect(bytes[1]).toBe(0xd8);
        const meta = await sharp(bytes).metadata();
        expect(meta.width).toBe(512);
        expect(meta.height).toBe(512);
    }, 15_000);

    test('an external PUT with a different inline photo re-keys the cache and the old file is swept', async () => {
        const { instance: contacts, dir } = await makeContacts();
        const staged = await stageAvatar(contacts);
        const id = await contacts.addContact(validContact({ firstName: 'Ext', lastName: 'Put', avatar: staged }));

        const firstCache = (await contacts.getContactById(id))!.avatar!.split('/').pop()!;
        expect(existsSync(join(avatarsDirOf(dir), firstCache))).toBe(true);

        // A CardDAV client re-PUTs the same resource (its UID is the contact id) with a different embedded JPEG.
        const sharp = (await import('sharp')).default;
        const jpeg = await sharp({
            create: { width: 48, height: 48, channels: 3, background: { r: 250, g: 250, b: 10 } },
        })
            .jpeg()
            .toBuffer();
        const body = createVCard(
            {
                firstName: 'Ext',
                lastName: 'Put',
                email: ['ada@example.com'],
                phone: [],
                photo: { bytes: new Uint8Array(jpeg), mediaType: 'image/jpeg' },
            },
            id,
        );
        const res = await contacts.putCard(`${id}.vcf`, body, { ifMatch: null, ifNoneMatch: null });
        expect(res.ok).toBe(true);

        // The embed changed, so the embed-derived cache name changed: the old name is gone from the projection,
        // the new hash-name is present on disk.
        const secondCache = (await contacts.getContactById(id))!.avatar!.split('/').pop()!;
        expect(secondCache).not.toBe(firstCache);
        expect(existsSync(join(avatarsDirOf(dir), secondCache))).toBe(true);

        // The superseded cache is now unreferenced; once past the stage-grace window the sweep reclaims it while
        // leaving the live one alone.
        const stalePath = join(avatarsDirOf(dir), firstCache);
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
        utimesSync(stalePath, old, old);
        await (contacts as unknown as { cleanupAvatarImages(): Promise<void> }).cleanupAvatarImages();
        expect(existsSync(stalePath)).toBe(false);
        expect(existsSync(join(avatarsDirOf(dir), secondCache))).toBe(true);
    });

    test('an unchanged-photo re-PUT keeps the promoted first-generation cache byte-for-byte', async () => {
        const { instance: contacts, dir } = await makeContacts();
        const staged = await stageAvatar(contacts);
        const id = await contacts.addContact(validContact({ firstName: 'RePut', lastName: 'Same', avatar: staged }));

        const cacheName = (await contacts.getContactById(id))!.avatar!.split('/').pop()!;
        const cachePath = join(avatarsDirOf(dir), cacheName);
        const before = computeResourceEtag(new Uint8Array(readFileSync(cachePath)));

        // A phone-side name edit re-PUTs the whole card with an unchanged PHOTO. The stored bytes ARE the
        // resource body a client sends back.
        const stored = await contacts.getCard(`${id}.vcf`);
        expect(stored).not.toBeNull();
        const res = await contacts.putCard(`${id}.vcf`, new TextDecoder().decode(stored!.bytes), {
            ifMatch: null,
            ifNoneMatch: null,
        });
        expect(res.ok).toBe(true);

        // The promoted generation-one webp is kept, not overwritten with a generation-two encode re-derived
        // from the embed: same cache name, identical bytes.
        expect((await contacts.getContactById(id))!.avatar!.split('/').pop()!).toBe(cacheName);
        expect(computeResourceEtag(new Uint8Array(readFileSync(cachePath)))).toBe(before);
    });

    test('updating without changing the avatar leaves the PHOTO bytes byte-identical', async () => {
        const { instance: contacts } = await makeContacts();
        const staged = await stageAvatar(contacts);
        const id = await contacts.addContact(validContact({ firstName: 'Keep', lastName: 'Same', avatar: staged }));

        const before = photoBlock(await cardTextOf(contacts, `${id}.vcf`));
        expect(before).not.toBe('');

        // The app echoes back the stored cache URL when the photo is untouched; only the name changes here.
        const stored = await contacts.getContactById(id);
        await contacts.updateContact(
            id,
            validContact({ firstName: 'Keep', lastName: 'Renamed', avatar: stored?.avatar }),
        );

        expect(photoBlock(await cardTextOf(contacts, `${id}.vcf`))).toBe(before);
    });

    test('a changed avatar whose staged file is gone fails the save and keeps the existing photo', async () => {
        const { instance: contacts, user } = await makeContacts();
        const staged = await stageAvatar(contacts);
        const id = await contacts.addContact(validContact({ firstName: 'Hold', lastName: 'Photo', avatar: staged }));

        const photoBefore = photoBlock(await cardTextOf(contacts, `${id}.vcf`));
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
        expect(photoBlock(await cardTextOf(contacts, `${id}.vcf`))).toBe(photoBefore);
        expect((await contacts.getContactById(id))?.avatar).toBe(avatarBefore);
    });

    test('clearing the avatar removes the PHOTO line and empties the projection URL', async () => {
        const { instance: contacts } = await makeContacts();
        const staged = await stageAvatar(contacts);
        const id = await contacts.addContact(validContact({ firstName: 'Drop', lastName: 'Pic', avatar: staged }));
        expect(await cardTextOf(contacts, `${id}.vcf`)).toContain('PHOTO');

        await contacts.updateContact(id, validContact({ firstName: 'Drop', lastName: 'Pic', avatar: '' }));

        expect(await cardTextOf(contacts, `${id}.vcf`)).not.toContain('PHOTO');
        expect((await contacts.getContactById(id))?.avatar).toBe('');
    });

    test('a create whose staged avatar is gone stores no card', async () => {
        const { instance: contacts, user } = await makeContacts();
        const db = contacts.db;
        const before = db.select().from(contactsSchema.contacts).all().length;

        await expect(
            contacts.addContact(validContact({ firstName: 'NoPic', avatar: `contacts/${user.id}/avatar/gone.webp` })),
        ).rejects.toThrow('Avatar upload could not be found');

        // The guard fires before the commit, so no row and no blob exist for it.
        expect(db.select().from(contactsSchema.contacts).all().length).toBe(before);
        expect((await contacts.getContacts()).some((c) => c.firstName === 'NoPic')).toBe(false);
    });

    test('deleting a contact removes only its derived avatar and keeps size accounting exact', async () => {
        const { instance: contacts, dir, user } = await makeContacts();
        const db = contacts.db;
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

        expect(await contacts.getCard(deletedRow.uri)).toBeNull();
        expect(existsSync(deletedAvatarPath)).toBe(false);
        expect(existsSync(keptAvatarPath)).toBe(true);
        expect(await contacts.getCard(selfRow.uri)).not.toBeNull();
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
        expect(await contacts.size()).toBe(sizeBefore - deletedRow.vcard.byteLength - deletedAvatarBytes);
    });

    test('deleting one of two legacy rows sharing a staged avatar leaves the file and survivor', async () => {
        const { instance: contacts, dir } = await makeContacts();
        const db = contacts.db;
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
        const { instance: contacts, dir } = await makeContacts();
        const db = contacts.db;
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

        expect(await contacts.getCard(row.uri)).toBeNull();
        expect(existsSync(avatarPath)).toBe(true);
        expect(
            db.select().from(contactsSchema.contacts).where(eq(contactsSchema.contacts.id, id)).get(),
        ).toBeUndefined();
        expect(await contacts.size()).toBe(sizeBefore - row.vcard.byteLength);
    });

    test('a second derive of the same photo keeps one cache file instead of double-counting it', async () => {
        const { instance: contacts, dir } = await makeContacts();
        const db = contacts.db;
        const priv = contacts as unknown as { cleanupAvatarImages(): Promise<void> };
        // Settle init's detached sweep so the running total starts out equal to what is on disk.
        await priv.cleanupAvatarImages();
        const sharp = (await import('sharp')).default;
        const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 9, g: 9, b: 9 } } })
            .jpeg()
            .toBuffer();
        const photo = { kind: 'inline', bytes: new Uint8Array(jpeg), mediaType: 'image/jpeg' } as const;
        const contactId = randomUUID();

        const first = await deriveCardPhotoCache(contacts, contactId, photo);
        const second = await deriveCardPhotoCache(contacts, contactId, photo);

        // Same bytes, same hash, same file — the second derive found the cache and counted nothing twice.
        expect(second).toBe(first);
        expect(readdirSync(avatarsDirOf(dir)).filter((n) => n.startsWith(contactId))).toHaveLength(1);
        expect(await contacts.size()).toBe(cardBytesOf(db) + avatarBytesOf(dir));
    });

    test('the avatar sweep holds the write lock, so a card write cannot interleave its recount', async () => {
        const { instance: contacts, dir } = await makeContacts();
        const db = contacts.db;
        const id = await contacts.addContact(validContact({ firstName: 'Swept', avatar: await stageAvatar(contacts) }));
        const priv = contacts as unknown as {
            cleanupAvatarImages(): Promise<void>;
            storage: { dirSize(dirPath: string): Promise<number> };
        };
        await priv.cleanupAvatarImages();

        // Park the sweep on its closing recount; while it waits there it must still own the write lock.
        // `parked` is the positive signal that it got there, so nothing here waits on a clock.
        let release!: () => void;
        let parked!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const reachedRecount = new Promise<void>((resolve) => {
            parked = resolve;
        });
        const originalDirSize = priv.storage.dirSize;
        let gated = true;
        priv.storage.dirSize = async (dirPath: string) => {
            if (gated) {
                gated = false;
                parked();
                await gate;
            }
            return originalDirSize.call(priv.storage, dirPath);
        };

        try {
            const order: string[] = [];
            const sweep = priv.cleanupAvatarImages().then(() => order.push('sweep'));
            const deletion = contacts.deleteContact(id).then(() => order.push('delete'));
            await reachedRecount;

            // Unserialized, the delete's byte credit lands inside the scan and the recount overwrites it.
            expect(order).toEqual([]);

            release();
            await Promise.all([sweep, deletion]);
            expect(order).toEqual(['sweep', 'delete']);
        } finally {
            release();
            priv.storage.dirSize = originalDirSize;
        }

        expect(await contacts.size()).toBe(cardBytesOf(db) + avatarBytesOf(dir));
    });

    test('downloadAvatar serves only the staged and derived cache-name shapes', async () => {
        const { instance: contacts, dir } = await makeContacts();
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

    test('deriveCardPhotoCache with a uri-kind photo returns empty and writes nothing', async () => {
        const { instance: contacts, dir } = await makeContacts();
        const before = readdirSync(avatarsDirOf(dir)).length;

        const url = await deriveCardPhotoCache(contacts, randomUUID(), {
            kind: 'uri',
            uri: 'https://example.com/remote.jpg',
        });

        expect(url).toBe('');
        expect(readdirSync(avatarsDirOf(dir)).length).toBe(before);
    });
});
