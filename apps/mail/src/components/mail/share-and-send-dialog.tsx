import { Button } from '@workspace/ui/components/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@workspace/ui/components/dialog';
import type { ReactNode } from 'react';
import { useState } from 'react';

// One grantable reference: the document and the To/Cc recipients that will receive read access.
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

// Collapse long recipient lists to a count past five, matching the share dialog's density.
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
    const [pending, setPending] = useState(false);

    // Own the async lifecycle like ConfirmDialog: disable both actions in-flight, close only after
    // the send fulfils, and stay open on rejection so the mutation's error toast reads with the retry.
    const run = async (action: () => Promise<void>) => {
        if (pending) return;
        setPending(true);
        try {
            await action();
            onOpenChange(false);
        } catch {
            // Stay open for retry; the mutation's onMutationError already surfaced the toast.
        } finally {
            setPending(false);
        }
    };

    // All grantable documents share one recipient set → one sentence; otherwise a row per document.
    const sharedSet = grants.length > 0 && grants.every((g) => sameRecipients(g.recipients, grants[0].recipients));

    let description: ReactNode;
    let rows: ReactNode = null;
    if (sharedSet) {
        description = `Give ${formatRecipients(grants[0].recipients)} read access to ${joinList(
            grants.map((g) => g.name),
        )}?`;
    } else {
        description = 'Give recipients read access to the documents you are sharing?';
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
        // While pending, ignore every close path (Escape/backdrop/X) so the retry surface survives;
        // opening is always allowed.
        <Dialog open={open} onOpenChange={(o) => (o || !pending) && onOpenChange(o)}>
            <DialogContent>
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
                    <Button variant="outline" onClick={() => run(onSendWithoutAccess)} disabled={pending}>
                        Send without access
                    </Button>
                    <Button onClick={() => run(onShareAndSend)} disabled={pending}>
                        Share &amp; send
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
