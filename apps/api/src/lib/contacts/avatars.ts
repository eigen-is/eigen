import { randomUUID } from 'node:crypto';
import { ApiError, PATHS } from '../core';
import { generateImagePreview } from '../shared/thumbnails';
import type { ParsedCardPhoto } from '../vcard/types';
import {
    AVATAR_FILENAME,
    avatarCacheName,
    avatarNameOf,
    avatarUrl,
    type EmbedFormat,
    stagedEmbedCandidates,
    stagedEmbedName,
} from './card-store';
import type { Contacts } from './contacts';
import * as schema from './schema';

// Avatar staging and the derived photo cache over the Contacts facade. See docs/CONTACTS.md § Photos.

// A staged upload has no card referencing it yet, so the sweep must leave it alone while the user is still filling in the form.
const AVATAR_STAGE_GRACE_MS = 60 * 60 * 1000;

// One shape for every contact-photo encode; the staged embed sibling spreads it with format:'jpeg'/'png'/'gif' for Apple-safe PHOTO bytes.
const AVATAR_PREVIEW = { maxSize: 512, quality: 80, fit: 'cover' } as const;

// An embedded GIF rides along in every device sync of its card, so past this the embed falls back to a first-frame JPEG; the served webp stays animated.
const AVATAR_EMBED_GIF_MAX_BYTES = 2 * 1024 * 1024;

// The embed is what a save writes verbatim into PHOTO; the webp sibling is what it promotes to the cache.
export type StagedAvatarPair = { embed: { bytes: Uint8Array; mediaType: string }; webp: Uint8Array };

// Both siblings decode from the pristine upload, never through one another, so the vCard PHOTO and the served webp are each generation one.
export async function uploadAvatar(contacts: Contacts, file: File): Promise<string> {
    cleanupAvatarImages(contacts).catch((e) => console.warn(`contacts: avatar sweep failed: ${e}`));

    const buffer = Buffer.from(await file.arrayBuffer());
    const webp = await generateImagePreview(buffer, file.type, file.name, '', 'avatar', AVATAR_PREVIEW);
    if (!webp) throw new ApiError(400, 'Failed to generate avatar thumbnail');

    // Animation wins over alpha because a GIF always reports hasAlpha.
    let format: EmbedFormat = webp.frameCount > 1 ? 'gif' : webp.hasAlpha ? 'png' : 'jpeg';
    let embed = await generateImagePreview(buffer, file.type, file.name, '', 'avatar', {
        ...AVATAR_PREVIEW,
        format,
    });
    if (!embed) throw new ApiError(400, 'Failed to generate avatar thumbnail');
    if (format === 'gif' && embed.data.byteLength > AVATAR_EMBED_GIF_MAX_BYTES) {
        const jpeg = await generateImagePreview(buffer, file.type, file.name, '', 'avatar', {
            ...AVATAR_PREVIEW,
            format: 'jpeg',
        });
        if (!jpeg) throw new ApiError(400, 'Failed to generate avatar thumbnail');
        embed = jpeg;
        format = 'jpeg';
    }

    const webpName = `${randomUUID()}.webp`;
    const embedName = stagedEmbedName(webpName, format);
    // The encodes stay outside the lock; the writes and their byte delta take it, so the sweep's recount can't land between them.
    await contacts.writeLock.run(async () => {
        await contacts.storage.write(`${PATHS.CONTACTS.AVATARS}/${webpName}`, webp.data);
        await contacts.storage.write(`${PATHS.CONTACTS.AVATARS}/${embedName}`, embed.data);
        contacts.avatarsBytes += webp.data.byteLength + embed.data.byteLength;
    });

    return avatarUrl(contacts.home.user.id, webpName);
}

export async function downloadAvatar(contacts: Contacts, filename: string): Promise<ArrayBuffer | null> {
    if (!AVATAR_FILENAME.test(filename)) {
        return null;
    }
    const file = contacts.storage.file(`${PATHS.CONTACTS.AVATARS}/${filename}`);
    if (!(await file.exists())) {
        return null;
    }
    return file.arrayBuffer();
}

// A non-empty url whose webp or embed sibling is gone throws, so the caller re-uploads instead of silently dropping a photo the user meant to set.
export async function resolveStagedAvatar(
    contacts: Contacts,
    stagedUrl: string | undefined,
): Promise<StagedAvatarPair | null> {
    if (!stagedUrl) return null;
    const webpName = avatarNameOf(stagedUrl);
    const webp = await downloadAvatar(contacts, webpName);
    let embed: { bytes: Uint8Array; mediaType: string } | null = null;
    if (webp) {
        // The candidate names derive from a webp name the allowlist already accepted, so the embed path is safe by construction.
        for (const cand of stagedEmbedCandidates(webpName)) {
            const path = `${PATHS.CONTACTS.AVATARS}/${cand.name}`;
            if (await contacts.storage.exists(path)) {
                embed = {
                    bytes: new Uint8Array(await contacts.storage.file(path).arrayBuffer()),
                    mediaType: cand.mediaType,
                };
                break;
            }
        }
    }
    if (!webp || !embed) {
        throw new ApiError(400, 'Avatar upload could not be found — please upload it again');
    }
    return { embed, webp: new Uint8Array(webp) };
}

// The cache name hashes the EMBED bytes, the same name a later reindex derives from the card's PHOTO, so only a changed photo re-derives.
export async function promoteAvatarCache(
    contacts: Contacts,
    contactId: string,
    staged: StagedAvatarPair,
): Promise<string> {
    const name = avatarCacheName(contactId, staged.embed.bytes);
    const path = `${PATHS.CONTACTS.AVATARS}/${name}`;
    const replaced = (await contacts.storage.size(path)) ?? 0;
    await contacts.storage.write(path, staged.webp);
    contacts.avatarsBytes += staged.webp.byteLength - replaced;
    return avatarUrl(contacts.home.user.id, name);
}

// Regenerates only when the hash-named file is missing: a phone re-PUTs the whole card for a name edit, and that must keep the first-generation cache.
export async function deriveCardPhotoCache(
    contacts: Contacts,
    id: string,
    photo: ParsedCardPhoto | null,
): Promise<string> {
    if (photo?.kind !== 'inline') return '';
    const cacheName = avatarCacheName(id, photo.bytes);
    if (await contacts.storage.exists(`${PATHS.CONTACTS.AVATARS}/${cacheName}`)) {
        return avatarUrl(contacts.home.user.id, cacheName);
    }
    return cacheCardPhoto(contacts, id, photo);
}

// Naming by the embedded bytes' hash lets a superseded photo fall out of reference for the sweep; a uri-kind photo caches nothing, as SSRF bars the fetch.
async function cacheCardPhoto(contacts: Contacts, contactId: string, photo: ParsedCardPhoto | null): Promise<string> {
    if (photo?.kind !== 'inline') return '';
    const result = await generateImagePreview(
        Buffer.from(photo.bytes),
        photo.mediaType ?? 'image/jpeg',
        'avatar',
        '',
        'avatar',
        AVATAR_PREVIEW,
    );
    if (!result) return '';
    const name = avatarCacheName(contactId, photo.bytes);
    const path = `${PATHS.CONTACTS.AVATARS}/${name}`;
    // Re-deriving the same photo overwrites the hash-named file rather than adding one, so credit the bytes it replaces.
    const replaced = (await contacts.storage.size(path)) ?? 0;
    await contacts.storage.write(path, result.data);
    contacts.avatarsBytes += result.data.byteLength - replaced;
    return avatarUrl(contacts.home.user.id, name);
}

// Runs under the write lock: every other avatarsBytes mutation holds it too, so the closing recount can't clobber an interleaved delta.
export function cleanupAvatarImages(contacts: Contacts): Promise<void> {
    return contacts.writeLock.run(async () => {
        await contacts.storage.mkdir(PATHS.CONTACTS.AVATARS);
        const files = await contacts.storage.list(PATHS.CONTACTS.AVATARS);

        // Straight from the index: the public list hides group rows, whose photo caches are referenced too.
        const referenced = new Set(
            contacts.db
                .select({ data: schema.contacts.data })
                .from(schema.contacts)
                .all()
                .map((row) => row.data?.avatar)
                .filter((url): url is string => !!url)
                .map(avatarNameOf),
        );

        const now = Date.now();
        for (const file of files) {
            if (referenced.has(file)) continue;
            const stat = await contacts.storage.stat(`${PATHS.CONTACTS.AVATARS}/${file}`);
            if (now - stat.mtimeMs < AVATAR_STAGE_GRACE_MS) continue;
            await contacts.storage.delete(`${PATHS.CONTACTS.AVATARS}/${file}`);
        }

        contacts.avatarsBytes = await contacts.storage.dirSize(PATHS.CONTACTS.AVATARS);
    });
}
