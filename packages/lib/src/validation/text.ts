// No C0 control character or DEL, so nothing splits a header line.
const CONTROL_RANGE = '\\x00-\\x1f\\x7f';
export const CONTROL_CHARS = new RegExp(`[${CONTROL_RANGE}]`);
// Kept as a string because a TypeBox pattern takes one.
export const NO_CONTROL_PATTERN = `^[^${CONTROL_RANGE}]*$`;
