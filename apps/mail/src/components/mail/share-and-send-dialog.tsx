// Asks before a draft goes out with links to documents some recipients can't open. The draft opens it on Send and
// can give those recipients view access first, or send as it is. Notes under the list name what Send can't share.

import type { DrivePathType } from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';
import { getFileIcon } from '@workspace/ui/components/drive';
import { useDialogPending } from '@workspace/ui/hooks/use-dialog-pending';
import { useRef } from 'react';

// One grantable reference: the document and the To/Cc recipients that will receive view access.
export type ShareGrant = {
    id: string;
    name: string;
    mimeType: string;
    driveType: DrivePathType;
    recipients: string[];
};

type ShareAndSendDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // Empty when nothing is grantable: the dialog is then a notes-only send confirm.
    grants: ShareGrant[];
    // Muted lines about what Send can't share, such as a chat link or the Bcc recipients.
    notes: string[];
    onShareAndSend: () => Promise<void>;
    onSendWithoutAccess: () => Promise<void>;
};

export function ShareAndSendDialog({
    open,
    onOpenChange,
    grants,
    notes,
    onShareAndSend,
    onSendWithoutAccess,
}: ShareAndSendDialogProps) {
    const { pending, run, handleOpenChange } = useDialogPending({ open, onOpenChange });
    // Radix would focus Cancel, the first button, so the dialog focuses the primary instead: a reflexive Enter
    // shares rather than sending without access.
    const primaryRef = useRef<HTMLButtonElement>(null);

    const hasGrants = grants.length > 0;
    // The lead line names every recipient who needs access. When the documents need different ones, a closing line
    // says only missing access is granted, so the sentence stays true.
    const sharedSet = hasGrants && grants.every((g) => sameRecipients(g.recipients, grants[0].recipients));
    const allRecipients = [...new Set(grants.flatMap((g) => g.recipients))];

    const description = hasGrants
        ? `Not everyone on this email can open the linked ${grants.length === 1 ? 'document' : 'documents'}.`
        : "Some recipients won't get access to the linked documents.";

    // Lead line and file list are separate DialogContent children so the grid's default
    // gap-4 section spacing applies around the list.
    const rows = hasGrants && (
        <>
            <p className="text-sm">Give {formatRecipients(allRecipients)} access to:</p>
            <div className="space-y-2 text-sm">
                {grants.map((g) => (
                    <div key={g.id} className="flex items-center gap-2">
                        {getFileIcon(g.mimeType, g.driveType, g.name, {
                            className: 'h-4 w-4 shrink-0 text-muted-foreground',
                        })}
                        <span className="truncate font-medium">{g.name}</span>
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">Viewer</span>
                    </div>
                ))}
            </div>
            {!sharedSet && <p className="text-sm">unless they already have access.</p>}
        </>
    );

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent
                size="sm"
                onOpenAutoFocus={(e) => {
                    e.preventDefault();
                    primaryRef.current?.focus();
                }}
            >
                <DialogHeader>
                    <DialogTitle>{hasGrants ? 'Share before sending?' : 'Send without sharing?'}</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                {rows}
                {notes.length > 0 && (
                    <div className="space-y-1 text-sm text-muted-foreground">
                        {notes.map((note) => (
                            <p key={note}>{note}</p>
                        ))}
                    </div>
                )}
                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                        Cancel
                    </Button>
                    {hasGrants && (
                        <Button variant="outline" onClick={() => run(onSendWithoutAccess)} disabled={pending}>
                            Send without access
                        </Button>
                    )}
                    <Button
                        ref={primaryRef}
                        onClick={() => run(hasGrants ? onShareAndSend : onSendWithoutAccess)}
                        disabled={pending}
                    >
                        {hasGrants ? 'Share & send' : 'Send'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function joinList(items: string[]): string {
    if (items.length <= 1) return items[0] ?? '';
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// Past five recipients a count, so a large Cc stays one short line.
function formatRecipients(emails: string[]): string {
    return emails.length > 5 ? `${emails.length} recipients` : joinList(emails);
}

function sameRecipients(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const other = new Set(b);
    return a.every((email) => other.has(email));
}
