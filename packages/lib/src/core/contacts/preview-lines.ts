import { unreadableLine } from '../transfer';

// The two counted lines a vCard preview ends on, spelled once for the quick look and the drive hero.
export function droppedContactsLine(dropped: number): string {
    return unreadableLine(dropped, 'contact');
}

export function remainingContactsLine(remaining: number): string {
    return `and ${remaining} more contact${remaining === 1 ? '' : 's'}`;
}
