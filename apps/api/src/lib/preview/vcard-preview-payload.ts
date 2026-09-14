import { getSchemaValidator, type Static, t } from 'elysia';
import { PreviewContactSchema } from '../contacts/contact-schema';

// What a .vcf preview serves: the cards themselves, not a rendered body — the overlay and the drive
// hero both render them with ContactDetailCard/UserAvatar (packages/ui). The schema is the payload's
// one definition: the route answers under it, and the cache seam parses a stored body through it, so
// nothing between the Worker and the component casts.
//
// `contact` is the shared Contact shape, spelled once on the backend in lib/contacts/contact-schema.ts
// beside the write bodies; the identity guard there is what keeps it equal to `Contact`.

// `cards` holds the first VCARD_PREVIEW_MAX_CARDS readable ones; `dropped` counts the cards the parser
// refused and `total` the cards the file holds, so a surface can say how many it is not showing.
export const vCardPreviewSchema = t.Object({
    cards: t.Array(t.Object({ contact: PreviewContactSchema, categories: t.Array(t.String()) })),
    dropped: t.Integer(),
    total: t.Integer(),
});

export type VCardPreview = Static<typeof vCardPreviewSchema>;

const validator = getSchemaValidator(vCardPreviewSchema);

// The one runtime check between the Worker and the route: a cached body is a file on disk, not a value
// this process still holds, so it is validated rather than trusted on the way back out. safeParse, not
// parse: parse throws a bare array of TypeBox errors, which reads as nothing at all in a log and is not
// an Error the cache seam can tell from any other unreadable file.
export function parseVCardPreview(body: string): VCardPreview {
    const parsed = validator.safeParse(JSON.parse(body));
    if (!parsed.success) throw new Error(`vCard preview payload does not match its schema: ${parsed.error}`);
    return parsed.data;
}
