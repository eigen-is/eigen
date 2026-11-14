// A contact's name and the contact an address belongs to, as every view of a person reads them, such as a guest list,
// a contact card or a suggestion while typing an address.

import type { Contact } from '../../types/contact';

export function contactFullName(contact: Contact): string {
    return `${contact.firstName} ${contact.lastName}`.trim();
}

// Mail addresses compare without case, so a contact saved as Grace@example.com is grace@example.com.
export function findContactByEmail(contacts: readonly Contact[], email: string): Contact | undefined {
    const wanted = email.toLowerCase();
    return contacts.find((contact) => contact.email.some((address) => address.toLowerCase() === wanted));
}
