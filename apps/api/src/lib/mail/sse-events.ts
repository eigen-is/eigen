import type { SSEvent, SSEventType } from '@workspace/lib/types/sse';

type MailEventType = (typeof SSEventType)[keyof typeof SSEventType] & `mail:${string}`;

type MailData = { messageId: string; mailbox: string; toMailbox?: string };

export function buildMailEvent(type: MailEventType, mail: MailData): SSEvent {
    return { type, mail } as SSEvent;
}
