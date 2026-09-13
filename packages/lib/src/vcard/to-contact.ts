import type { Contact, ParsedCard, ParsedCardPhoto } from '../types/contact';

// btoa over a chunked binary string, not Buffer: this runs in the browser. Mirrors blobToDataUri in
// core/clipboard. The media-type fallback is the server's (cacheCardPhoto) — a 3.0 PHOTO may declare none.
function photoDataUri(bytes: Uint8Array, mediaType: string | null): string {
    let binary = '';
    const CHUNK = 0x8000; // stay well under the spread arg-count limit
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return `data:${mediaType ?? 'image/jpeg'};base64,${btoa(binary)}`;
}

function cardAvatar(photo: ParsedCardPhoto | null): string | undefined {
    if (!photo) return undefined;
    return photo.kind === 'inline' ? photoDataUri(photo.bytes, photo.mediaType) : photo.uri;
}

// A parsed card as the app renders a contact, for a file that is only being previewed: nothing is stored,
// so the server-assigned fields are the empty sentinels emptyContact uses. Categories come back beside the
// contact because they are label NAMES, and `labels` holds label ids. X-EIGEN-ID is dropped on purpose —
// a self-link is the server's to grant (spec § 2 trust rule), never a claim a file makes.
export function parsedCardToContact(card: ParsedCard): { contact: Contact; categories: string[] } {
    return {
        contact: {
            id: card.uid ?? '',
            etag: '',
            firstName: card.firstName.trim(),
            lastName: card.lastName.trim(),
            email: card.email,
            phone: card.phone,
            company: card.company,
            jobTitle: card.jobTitle,
            address: card.address,
            birthday: card.birthday,
            notes: card.notes,
            avatar: cardAvatar(card.photo),
            labels: [],
        },
        categories: card.categories,
    };
}
