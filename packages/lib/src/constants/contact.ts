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

// The two ceilings a vCard import is bounded by, shared FE/BE: the raw payload is refused before it is read,
// and a file with more cards than this is refused right after the split.
export const VCARD_MAX_BYTES = 20 * 1024 * 1024;
export const VCARD_IMPORT_MAX_CARDS = 1000;

// A quick look reads, it doesn't scroll a whole address book: past this the preview serves counts only.
export const VCARD_PREVIEW_MAX_CARDS = 200;

// The media type every vCard byte stream is served under (CardDAV GET, PROPFIND getcontenttype, export).
export const VCARD_CONTENT_TYPE = 'text/vcard; charset=utf-8';
