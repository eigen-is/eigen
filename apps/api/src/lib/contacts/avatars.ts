import { randomUUID } from 'node:crypto';
import type { ParsedCardPhoto } from '../carddav/vcard-parse';
import { ApiError, PATHS } from '../core';
import { generateImagePreview } from '../shared/thumbnails';
import {
    AVATAR_FILENAME,
    avatarCacheName,
    avatarUrl,
    type EmbedFormat,
    stagedEmbedCandidates,
    stagedEmbedName,
} from './card-store';
import type { Contacts } from './contacts';
import * as schema from './schema';

// Avatar staging and the derived photo cache over the Contacts facade: the two first-generation encodes an
// upload leaves in `avatars/`, the hash-named webp a card's PHOTO derives, and the sweep that reclaims what
// no row references. See docs/CONTACTS.md § Photos.

// A freshly-staged avatar has no card referencing it yet — the user is still filling in the form. Give an
// upload an hour before the unreferenced-avatar sweep may reclaim it, so an in-progress edit's staged webp
// isn't deleted out from under the save.
const AVATAR_STAGE_GRACE_MS = 60 * 60 * 1000;

// Every contact-photo encode shares one preview shape: a 512px q80 square-cropped image. It defaults to webp
// (the only format Eigen serves); the staged embed sibling spreads it with format:'jpeg'/'png'/'gif' for the
// Apple-safe PHOTO bytes. App-authored cards with this shape naturally stay around 230 KiB; that is normal
// behavior, not a resource limit or guarantee.
const AVATAR_PREVIEW = { maxSize: 512, quality: 80, fit: 'cover' } as const;

// A single animated GIF embedded in a card rides along in every device sync of that card. Past this ceiling the
// staged embed falls back to a first-frame JPEG so one long GIF can't bloat every sync (the served webp sibling
// stays animated regardless — the cap is only on the bytes stored in the vCard).
const AVATAR_EMBED_GIF_MAX_BYTES = 2 * 1024 * 1024;

// The two first-generation encodes a staged upload carries: the Apple-safe embed the save writes verbatim into
// PHOTO, and the webp sibling it promotes to the cache. `resolveStagedAvatar` pairs them from a staged url.
export type StagedAvatarPair = { embed: { bytes: Uint8Array; mediaType: string }; webp: Uint8Array };

// Stage two first-generation siblings from the pristine upload: the 512px webp Eigen serves (alpha and
// animation preserved natively) and an Apple-safe embed for the vCard PHOTO. Both are decoded from the
// original — never chained through one another — so a save can embed the embed verbatim and promote the
// webp to the cache, and the app/DAV both get generation one. Only the webp url is returned; the embed
// sibling rides beside it under `<uuid>.embed.<ext>` for `resolveStagedAvatar` to pair up at save time.
export async function uploadAvatar(contacts: Contacts, file: File): Promise<string> {
    cleanupAvatarImages(contacts).catch(() => {});

    const buffer = Buffer.from(await file.arrayBuffer());
    const webp = await generateImagePreview(buffer, file.type, file.name, '', 'avatar', AVATAR_PREVIEW);
    if (!webp) throw new ApiError(400, 'Failed to generate avatar thumbnail');

    // Animation wins over alpha (a GIF always reports hasAlpha), so an animated source embeds as GIF, an
    // opaque still as JPEG q80, and anything else carrying transparency as PNG.
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
    // The encodes stay outside the lock (the slow part, no accounting); the writes and their byte delta take
    // it, so the sweep's recount can never land between them and lose the increment.
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

// Pair a staged upload back up: the Apple-safe embed bytes a save writes verbatim into PHOTO, and the
// first-generation webp sibling it promotes to the cache. No transcode here — both were encoded once at
// staging (uploadAvatar). Null for an empty url; a non-empty url whose webp or embed sibling is gone (swept,
// a torn upload) throws so the caller re-uploads rather than silently dropping a photo the user meant to set.
export async function resolveStagedAvatar(
    contacts: Contacts,
    stagedUrl: string | undefined,
): Promise<StagedAvatarPair | null> {
    if (!stagedUrl) return null;
    const webpName = stagedUrl.split('/').pop()!;
    const webp = await downloadAvatar(contacts, webpName);
    let embed: { bytes: Uint8Array; mediaType: string } | null = null;
    if (webp) {
        // The candidate names derive from a webp name the allowlist already accepted (downloadAvatar), so the
        // embed path is safe by construction; exactly one sibling extension is ever written per upload.
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

// Save-seam cache write: store the staged first-generation webp sibling under the embed-derived cache name
// (avatarCacheName over the EMBED bytes — the same name a later reindex derives from the card's PHOTO). The
// app then serves generation one; a reconcile that finds this name keeps the file, and only a changed embed
// yields a new name and re-derivation. Mirrors cacheCardPhoto's replaced-bytes accounting.
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

// The projection avatar URL for a card's PHOTO: the derived-cache URL, regenerating the webp only when its
// hash-named file is missing. So an unchanged-photo re-PUT (any phone-side name edit re-sends the whole
// card) or a reconcile keeps a promoted first-generation cache rather than overwriting it with a
// second-generation encode. A uri-kind or absent photo caches nothing (returns '').
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

// Derive the webp avatar cache from an inline PHOTO and return its projection URL — the regeneration path
// (a reindex after avatars/ loss, an external DAV PUT), one generation older than a save's promoted webp.
// The 512px webp target decodes every format: a JPEG/PNG embed becomes an opaque/alpha webp, an animated
// GIF becomes an animated webp (the worker reads all pages for webp), each a full frame — never a filmstrip.
// Naming by the embedded bytes' hash makes a superseded photo's file fall out of reference, so
// cleanupAvatarImages sweeps it. A uri-kind or absent photo caches nothing — remote URIs are never fetched
// (SSRF, spec Non-goals).
export async function cacheCardPhoto(
    contacts: Contacts,
    contactId: string,
    photo: ParsedCardPhoto | null,
): Promise<string> {
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
    // Re-deriving the same photo (a drained write, a reconcile, a re-upload of the same image) overwrites
    // the hash-named file rather than adding one, so credit the bytes it replaces.
    const replaced = (await contacts.storage.size(path)) ?? 0;
    await contacts.storage.write(path, result.data);
    contacts.avatarsBytes += result.data.byteLength - replaced;
    return avatarUrl(contacts.home.user.id, name);
}

// Reclaim avatar files no indexed row references any more, then re-seed the running total from disk.
// Runs under the write lock — every other avatarsBytes mutation holds it too, so the closing recount can
// no longer clobber a delta an interleaved write applied mid-sweep.
export function cleanupAvatarImages(contacts: Contacts): Promise<void> {
    return contacts.writeLock.run(async () => {
        await contacts.storage.mkdir(PATHS.CONTACTS.AVATARS);
        const files = await contacts.storage.list(PATHS.CONTACTS.AVATARS);

        // Build the referenced-filename set once, then sweep — O(avatars + contacts), not O(avatars × contacts).
        // Read the projection straight from the index: the public list would re-enter the lock this holds,
        // and it hides group rows, whose photo caches are referenced all the same.
        const referenced = new Set(
            contacts.db
                .select({ data: schema.contacts.data })
                .from(schema.contacts)
                .all()
                .map((row) => row.data?.avatar?.split('/').pop())
                .filter((name): name is string => !!name),
        );

        const now = Date.now();
        for (const file of files) {
            if (referenced.has(file)) continue;
            // A freshly-staged upload has no card pointing at it yet; leave it inside the grace window so an
            // in-progress edit's avatar isn't swept out from under the save.
            const stat = await contacts.storage.stat(`${PATHS.CONTACTS.AVATARS}/${file}`);
            if (now - stat.mtimeMs < AVATAR_STAGE_GRACE_MS) continue;
            await contacts.storage.delete(`${PATHS.CONTACTS.AVATARS}/${file}`);
        }

        contacts.avatarsBytes = await contacts.storage.dirSize(PATHS.CONTACTS.AVATARS);
    });
}
