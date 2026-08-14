import { Button } from '@workspace/ui/components/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';
import { useDialogPending } from '@workspace/ui/hooks/use-dialog-pending';
import type { ReactNode } from 'react';
import { useRef } from 'react';

// One grantable reference: the document and the To/Cc recipients that will receive view access.
export type ShareGrant = { id: string; name: string; recipients: string[] };

type ShareAndSendDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    grants: ShareGrant[];
    // Muted informational lines: unshareable refs, chat refs, and the Bcc exclusion.
    notes: string[];
    onShareAndSend: () => Promise<void>;
    onSendWithoutAccess: () => Promise<void>;
};

function joinList(items: string[]): string {
    if (items.length <= 1) return items[0] ?? '';
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// Collapse long recipient lists to a count past five so a large Cc set stays one short line.
function formatRecipients(emails: string[]): string {
    return emails.length > 5 ? `${emails.length} recipients` : joinList(emails);
}

function sameRecipients(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const other = new Set(b);
    return a.every((email) => other.has(email));
}

export function ShareAndSendDialog({
    open,
    onOpenChange,
    grants,
    notes,
    onShareAndSend,
    onSendWithoutAccess,
}: ShareAndSendDialogProps) {
    const { pending, run, handleOpenChange } = useDialogPending(onOpenChange);
    // Both footer send actions dispatch; focus the recommended primary so a keyboard user's reflexive
    // Enter shares rather than sending without access (Radix would otherwise focus the first tabbable).
    const primaryRef = useRef<HTMLButtonElement>(null);

    // All grantable documents share one recipient set → one sentence; otherwise a row per document.
    const sharedSet = grants.length > 0 && grants.every((g) => sameRecipients(g.recipients, grants[0].recipients));

    let description: ReactNode;
    let rows: ReactNode = null;
    if (sharedSet) {
        description = `Let ${formatRecipients(grants[0].recipients)} view ${joinList(grants.map((g) => g.name))}?`;
    } else {
        description = 'Let these recipients view the linked documents?';
        rows = (
            <div className="space-y-2 text-sm">
                {grants.map((g) => (
                    <div key={g.id}>
                        <span className="font-medium">{g.name}</span>
                        <div className="text-muted-foreground">{formatRecipients(g.recipients)}</div>
                    </div>
                ))}
            </div>
        );
    }

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent
                onOpenAutoFocus={(e) => {
                    e.preventDefault();
                    primaryRef.current?.focus();
                }}
            >
                <DialogHeader>
                    <DialogTitle>Share before sending?</DialogTitle>
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
                    <Button variant="outline" onClick={() => run(onSendWithoutAccess)} disabled={pending}>
                        Send without access
                    </Button>
                    <Button ref={primaryRef} onClick={() => run(onShareAndSend)} disabled={pending}>
                        Share & send
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
