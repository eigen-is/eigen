import type { SSEventMail } from '@workspace/lib/types/sse';

export function buildMailEvent(type: SSEventMail['type'], mail: SSEventMail['mail']): SSEventMail {
    return { type, mail };
}
