import type { Contact } from '@workspace/lib/types/contact';
import type { ParsedCard, ParsedCardPhoto } from './types';

// Only an inline image becomes an avatar. A uri photo is never fetched — an import doesn't fetch one
// either (cacheCardPhoto ignores them), and a preview that did would have the browser call a URL an
// untrusted file chose. A non-image media type is refused for the same reason: a data: URI is only ever
// rendered as an image here. The fallback for a 3.0 PHOTO that declares no type is the server's.
function cardAvatar(photo: ParsedCardPhoto | null): string | undefined {
    if (photo?.kind !== 'inline') return undefined;
    const mediaType = photo.mediaType ?? 'image/jpeg';
    if (!mediaType.toLowerCase().startsWith('image/')) return undefined;
    return `data:${mediaType};base64,${Buffer.from(photo.bytes).toString('base64')}`;
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
