import type { Contact } from '../types/contact';

export const emptyContact: Contact = {
    id: '',
    firstName: '',
    lastName: '',
    email: [''],
    phone: [''],
    address: [{}],
    labels: [],
};
