// Hard caps on one outgoing message, shared with the frontend so the composer can refuse the
// overflow itself instead of letting every save 422 against the send route's `maxItems`.
export const MAX_SEND_RECIPIENTS = 100;
export const MAX_SEND_REFERENCES = 20;
