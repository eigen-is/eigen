import type { TextPreviewMode } from '../constants/preview';
import type { Contact } from './contact';

// What a text preview serves, from Drive bytes or a mail part alike: a rendered HTML body plus the mode
// that tells a surface how to frame it (prose, a code block, a page-sized document).
export type TextPreviewResult = {
    body: string;
    mode: TextPreviewMode;
};

// What a .vcf preview serves: the cards themselves, not a rendered body — the overlay and the drive hero
// both render them with ContactDetailCard/UserAvatar (packages/ui). `cards` holds the first
// VCARD_PREVIEW_MAX_CARDS readable ones; `dropped` counts the cards the parser refused and `total` the
// cards the file holds, so a surface can say how many it is not showing.
export type VCardPreview = { cards: { contact: Contact; categories: string[] }[]; dropped: number; total: number };
