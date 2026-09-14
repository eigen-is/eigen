import type { Contact } from '@workspace/lib/types/contact';
import { MAX_EMAIL_LENGTH } from '@workspace/lib/validation';
import { type Static, t } from 'elysia';
import { CARD_MAX_BYTES } from './card-store';

// The Contact shape, spelled once for every backend schema that carries one: the write bodies
// (routes/contacts.ts) and the Drive vCard preview payload (lib/preview/vcard-preview-payload.ts).
//
// The two differ only in their bounds, which is why this is a factory. A write body is checked against
// what a client may send — generous enough that no real contact meets it, tight enough that no single
// value can be the whole card, in front of the ceiling the write seam enforces on the assembled card.
// A previewed card comes out of a file nobody wrote through this API and is never stored: its inline
// PHOTO alone is a data: URI far past any of these, so the preview spells the same fields with no bound
// and leans on IMPORT_MAX_BYTES instead.
function contactProperties(bounded: boolean) {
    const text = bounded ? { maxLength: 512 } : {};
    const freeText = bounded ? { maxLength: CARD_MAX_BYTES } : {};
    const email = bounded ? { maxLength: MAX_EMAIL_LENGTH } : {};
    const items = (maxItems: number) => (bounded ? { maxItems } : {});

    const address = t.Object({
        street: t.Optional(t.String(text)),
        city: t.Optional(t.String(text)),
        state: t.Optional(t.String(text)),
        zipCode: t.Optional(t.String(text)),
        country: t.Optional(t.String(text)),
    });

    return {
        firstName: t.String(text),
        lastName: t.String(text),
        email: t.Array(t.String(email), items(100)),
        phone: t.Array(t.String(text), items(100)),
        company: t.Optional(t.String(text)),
        jobTitle: t.Optional(t.String(text)),
        address: t.Optional(t.Array(address, items(50))),
        birthday: t.Optional(t.String(text)),
        notes: t.Optional(t.String(freeText)),
        avatar: t.Optional(t.String(text)),
        labels: t.Optional(t.Array(t.String(text), items(200))),
        eigenId: t.Optional(t.String(text)),
    };
}

// The client-writable fields — the create body. The id and the etag are the server's to assign.
export const CreateContactSchema = t.Object(contactProperties(true));

// A contact as a preview serves it: the same fields plus the two every read carries, which
// `parsedCardToContact` fills with the empty sentinels a card that is only being looked at gets.
export const PreviewContactSchema = t.Object({
    ...contactProperties(false),
    id: t.String(),
    etag: t.String(),
});

// Compile-time guard that the previewed shape stays exactly the shared Contact type — mutual
// assignability would let a field added to one side and not the other through. Same identity check
// shared-schemas.ts makes for attachmentReferenceSchema; Contact is an intersection, so it is flattened
// first or the two never compare equal.
type Flatten<T> = { [K in keyof T]: T[K] };
type TypesEqual<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
const _previewContactSchemaMatchesType: TypesEqual<Static<typeof PreviewContactSchema>, Flatten<Contact>> = true;
void _previewContactSchemaMatchesType;
