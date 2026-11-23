// The control characters a line of text from outside may not hold, such as a file name, a header or a calendar uid,
// and the rule for a name looked up in a folder. The patterns here refuse the C0 range. The C1 range is one a pattern
// opts into, such as the message of a restart notice. The ranges are strings, because a TypeBox pattern takes one and
// compiles it without the u flag.

// C0 and DEL, which can split a header line or a path.
export const C0_CONTROL_RANGE = '\\x00-\\x1f\\x7f';
// C1, the control characters past DEL, which a terminal can read as an escape.
export const C1_CONTROL_RANGE = '\\x80-\\x9f';

export const CONTROL_CHARS = new RegExp(`[${C0_CONTROL_RANGE}]`);
export const NO_CONTROL_PATTERN = `^[^${C0_CONTROL_RANGE}]*$`;

// A name looked up in a folder, such as a Drive file's or a document's media file. A separator, `.` or `..` would reach
// outside it, and a control character would leave it unreachable over WebDAV (RFC 4918) and unarchivable.
export function isSafeFileName(name: string): boolean {
    if (name === '' || name === '.' || name === '..') return false;
    return !name.includes('/') && !name.includes('\\') && !CONTROL_CHARS.test(name);
}
