import type { Address, Contact } from '../../types/contact';

// How a contact's composed fields read wherever one is shown: the contacts detail card
// (packages/ui/src/components/user/contact-detail-card.tsx) and the Drive vCard preview body
// (apps/api/src/lib/preview/vcard-render.ts) render through these, so a stored contact and a
// previewed card spell them the same. React-free, so the backend imports ./format directly.

export function formatContactAddress(address: Address): string {
    return [address.street, address.city, address.state, address.zipCode, address.country].filter(Boolean).join(', ');
}

// The line under the name — empty unless the card carries both halves.
export function formatContactRole(contact: Contact): string {
    return contact.jobTitle && contact.company ? `${contact.jobTitle} at ${contact.company}` : '';
}

// The Company field's value, job title appended when there is one.
export function formatContactCompany(contact: Contact): string {
    if (!contact.company) return '';
    return contact.jobTitle ? `${contact.company} - ${contact.jobTitle}` : contact.company;
}
