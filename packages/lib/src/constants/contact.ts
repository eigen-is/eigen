import type { Contact } from '../types/contact';

// The blank card the "new contact" form starts from. It stands in for a contact that isn't stored yet, so
// the two server-assigned fields are empty sentinels — a create submits neither.
export const emptyContact: Contact = {
    id: '',
    etag: '',
    firstName: '',
    lastName: '',
    email: [''],
    phone: [''],
    address: [{}],
    labels: [],
};
