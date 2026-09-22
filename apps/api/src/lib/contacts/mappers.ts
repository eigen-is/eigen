import type { Contact, CreateContactInput } from '@workspace/lib/types/contact';
import type { CardData, ContactRow } from './card-store';

// Optionals collapse to '' / [] so the shape matches prepareCard's and `avatarChanged` can't misfire on `undefined !== ''`.
export function toData(contact: CreateContactInput): CardData {
    return {
        email: contact.email,
        phone: contact.phone,
        company: contact.company ?? '',
        jobTitle: contact.jobTitle ?? '',
        address: contact.address ?? [],
        birthday: contact.birthday ?? '',
        notes: contact.notes ?? '',
        avatar: contact.avatar ?? '',
    };
}

// Derived from toData so a NULL `data` column reads back as the shape every write stores.
const EMPTY_CARD_DATA: CardData = toData({ firstName: '', lastName: '', email: [], phone: [] });

export function dbRowToContact(row: ContactRow, labelIds: string[]): Contact {
    const data = row.data ?? EMPTY_CARD_DATA;

    return {
        id: row.id,
        firstName: row.firstName.trim(),
        lastName: row.lastName.trim(),
        eigenId: row.eigenId,
        etag: row.etag,
        ...data,
        labels: labelIds,
    };
}
