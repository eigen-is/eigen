// The JSON.parse reviver that turns the API's timestamps back into Dates. A value becomes a Date only when it has
// the exact shape Date's toJSON writes and sits under a key named as a timestamp, so a title or a birthday that
// reads as a date stays the string it is. Whatever parses JSON our own code wrote Dates into passes it to
// JSON.parse, such as the treaty for every reply and the file upload, which reads its reply without the treaty.

const TO_JSON_SHAPE = /^(\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TIMESTAMP_KEY = /(At|Time)$|^(at|date)$/;

export function reviveTimestamp(key: string, value: unknown): unknown {
    return typeof value === 'string' && TIMESTAMP_KEY.test(key) && TO_JSON_SHAPE.test(value) ? new Date(value) : value;
}
