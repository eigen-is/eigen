// A contact card as the web apps, the API and the CardDAV import all see it, and the input shapes a client writes.
// It also spells a contact's name and finds the contact an address belongs to, the way every view of a person
// reads them, such as a guest list, a contact card or a self card pushed to the user's profile.

export type Address = {
    street?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    country?: string;
};

// The fields a card owns and a client may write in a POST body. The server assigns everything else: it mints the id
// and computes the etag from the card file's bytes.
export type CreateContactInput = {
    firstName: string;
    lastName: string;
    email: string[];
    phone: string[];
    company?: string;
    jobTitle?: string;
    address?: Address[];
    birthday?: string;
    notes?: string;
    avatar?: string;
    labels?: string[];
    eigenId?: string;
};

// A stored contact as every read serves it: the server-assigned id and the etag of the card it was read from.
export type Contact = CreateContactInput & {
    id: string;
    // sha256 of the card file's bytes.
    etag: string;
};

// A PUT echoes the etag it loaded, so a stale form gets a 412 instead of overwriting a card that changed meanwhile.
// The id travels in the path, not the body.
export type UpdateContactInput = CreateContactInput & {
    etag: string;
};

// One entry of the address suggestions: personal contacts and team members merged without duplicates. A team member
// carries its team, so the command palette can open the member's page in that team.
export type ContactSuggestion = {
    kind: 'personal' | 'team';
    id: string;
    displayName: string;
    email: string;
    teamId?: string;
};

// A card may come from a phone or an import with a part padded or left empty, so each part is trimmed before the join.
export function contactFullName(contact: Pick<Contact, 'firstName' | 'lastName'>): string {
    return `${contact.firstName.trim()} ${contact.lastName.trim()}`.trim();
}

// Mail addresses compare without case, so a contact saved as Grace@example.com is grace@example.com.
export function findContactByEmail(contacts: readonly Contact[], email: string): Contact | undefined {
    const wanted = email.toLowerCase();
    return contacts.find((contact) => contact.email.some((address) => address.toLowerCase() === wanted));
}
