// No C0 control character or DEL, so nothing splits a header line. Strings, as a TypeBox pattern takes one.
const CONTROL_RANGE = '\\x00-\\x1f\\x7f';
export const CONTROL_CHAR_PATTERN = `[${CONTROL_RANGE}]`;
export const NO_CONTROL_PATTERN = `^[^${CONTROL_RANGE}]*$`;
