// Hard caps on one outgoing message. The reference cap is also enforced in the composer, so a
// 21st linked document is refused before it 422s every save; the recipient cap is a 400 at send.
export const MAX_SEND_RECIPIENTS = 100;
export const MAX_SEND_REFERENCES = 20;
