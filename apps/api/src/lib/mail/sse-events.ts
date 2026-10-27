// Builds the mail events, which name a message and its mailbox. The Mail domain sends one for each change
// it makes and for each change its folder sync finds on disk.

import type { SSEventMail } from '@workspace/lib/types/sse';

export function buildMailEvent(type: SSEventMail['type'], mail: SSEventMail['mail']): SSEventMail {
    return { type, mail };
}
