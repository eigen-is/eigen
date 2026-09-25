// No C0 control character or DEL, so nothing splits a header line. A string, as a TypeBox pattern takes one.
export const NO_CONTROL_PATTERN = '^[^\\x00-\\x1f\\x7f]*$';
