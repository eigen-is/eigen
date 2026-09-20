// The two counted lines a vCard preview ends on, spelled once for the quick look and the drive hero.
export function droppedContactsLine(dropped: number): string {
    return `${dropped} contact${dropped === 1 ? '' : 's'} could not be read`;
}

export function remainingContactsLine(remaining: number): string {
    return `and ${remaining} more contact${remaining === 1 ? '' : 's'}`;
}
