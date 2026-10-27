// Hands one event from the stream to every domain's handler, such as the drive's or the mail's. Each
// handler picks the events of its own domain and invalidates the queries they name. useSSE calls this
// for each message; the answer says whether any domain knew the event.

import type { QueryClient } from '@tanstack/react-query';
import { handleAdminSSEvent } from '@workspace/lib/admin';
import { handleCalendarSSEvent } from '@workspace/lib/calendar';
import { handleChatSSEvent } from '@workspace/lib/chat';
import { handleContactsSSEvent } from '@workspace/lib/contacts';
import { handleDriveSSEvent } from '@workspace/lib/drive';
import { handleHomeSSEvent } from '@workspace/lib/home';
import { handleMailSSEvent } from '@workspace/lib/mail';
import { handleNotificationSSEvent } from '@workspace/lib/notification';
import type { SSEvent } from '@workspace/lib/types/sse';

export function handleSSEvent(event: SSEvent, queryClient: QueryClient, userId: string): boolean {
    const handled = [
        handleDriveSSEvent(event, queryClient, userId),
        handleMailSSEvent(event, queryClient, userId),
        handleContactsSSEvent(event, queryClient, userId),
        handleChatSSEvent(event, queryClient),
        handleCalendarSSEvent(event, queryClient, userId),
        handleNotificationSSEvent(event, queryClient, userId),
        handleAdminSSEvent(event, queryClient),
        handleHomeSSEvent(event),
    ];
    return handled.includes(true);
}
