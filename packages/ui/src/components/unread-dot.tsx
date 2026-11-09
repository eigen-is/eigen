// The dot on something that holds news for you, such as a chat in a list or a card with an unread reply. It sits on the
// top-right corner of its nearest positioned parent, in red; a card's footer and Mail's list pass their own place, and
// Mail the app's color.

import { cn } from '@workspace/ui/lib/utils';

export function UnreadDot({ className }: { className?: string }) {
    return <span className={cn('absolute -top-1 -right-1 h-2 w-2 rounded-full bg-destructive', className)} />;
}
