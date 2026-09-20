// What a whole-file transfer answers with when the file is not what it was taken for. One spelling per
// format, shared by the route that ingests it, the domain that parses it and the preview guard that
// refuses it before its bytes are read.
export const NOT_A_VCARD_FILE = 'Not a vCard file';
export const NOT_AN_EMAIL_FILE = 'Not an email file';
export const NOT_A_CALENDAR_FILE = 'Not a calendar file';

// A `.vcf` and an `.ics` are UTF-8 (RFC 6350 §3.1, RFC 5545 §3.1). Another encoding is its own answer,
// not "not a calendar": decoded leniently it would store a U+FFFD in every accented name and re-serve it
// to every DAV client.
export const NOT_UTF8_FILE = 'File is not UTF-8 encoded';
