// The JSON.parse reviver that turns the API's timestamps back into Dates. A value becomes a Date only when it has
// the exact shape Date's toJSON writes and sits under a key named as a timestamp, so a title or a birthday that
// reads as a date stays the string it is. The treaty passes it to every JSON reply, and so does the file upload,
// which reads its reply without the treaty.

const TO_JSON_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// The naming rule: a field that holds a Date ends in At or Time, or is called at or date.
const TIMESTAMP_KEY = /(At|Time)$|^(at|date)$/;

export function reviveTimestamp(key: string, value: unknown): unknown {
    return typeof value === 'string' && TIMESTAMP_KEY.test(key) && TO_JSON_SHAPE.test(value) ? new Date(value) : value;
}
