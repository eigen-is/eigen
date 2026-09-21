import type { Contact } from '../types/contact';
import { VCARD_MIMES } from '../types/drive';

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

// The ceiling a vCard transfer is bounded by, shared FE/BE: the raw payload is refused before it is read.
export const VCARD_MAX_BYTES = 20 * 1024 * 1024;

// The media type every vCard byte stream is served under (CardDAV GET, PROPFIND getcontenttype, export).
export const VCARD_CONTENT_TYPE = `${VCARD_MIMES[0]}; charset=utf-8`;
