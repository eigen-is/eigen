// Hard caps on a single outgoing message. Shared with the frontend so the composer can refuse
// the overflow while the user is still composing, instead of letting it reach a request the send
// route only rejects (`maxItems` on the draft schema, plus a runtime re-check in `messageSend`).
export const MAX_SEND_RECIPIENTS = 100;
export const MAX_SEND_REFERENCES = 20;
