// The admin's waitlist: the people who asked to join from the landing page, in tabs by status. The entry the URL's
// entryId names opens its detail beside the list, from whose bar the admin accepts and invites, rejects, resends an
// invite or deletes it. An accept or a reject moves the entry to another tab, so it closes the detail.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import {
    useAcceptWaitlistEntry,
    useDeleteWaitlistEntry,
    useRejectWaitlistEntry,
    useResendWaitlistInvite,
    useWaitlistEntries,
} from '@workspace/lib/admin';
import { formatDateTime, formatTimeAgo } from '@workspace/lib/date';
import type { WaitlistEntry } from '@workspace/lib/types/waitlist';
import { Badge } from '@workspace/ui/components/badge';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { EmptyState, ListDetailLayout, LoadingState } from '@workspace/ui/components/layout/app';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { SearchBar } from '@workspace/ui/components/search-bar/search-bar';
import { Separator } from '@workspace/ui/components/separator';
import { Tabs, TabsList, TabsTrigger } from '@workspace/ui/components/tabs';
import { UserItem } from '@workspace/ui/components/user';
import { useDetailHistory } from '@workspace/ui/hooks/use-detail-history';
import { useDialogValue } from '@workspace/ui/hooks/use-dialog-value';
import { cn } from '@workspace/ui/lib/utils';
import { Ban, Check, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';

type WaitlistSearch = {
    entryId?: string;
    tab?: string;
};

export const Route = createFileRoute('/_auth/_owner/waitlist')({
    component: WaitlistRoute,
    validateSearch: (search: Record<string, unknown>): WaitlistSearch => ({
        entryId: typeof search.entryId === 'string' ? search.entryId : undefined,
        tab: typeof search.tab === 'string' ? search.tab : undefined,
    }),
});

const TABS = ['pending', 'invited', 'registered', 'rejected'] as const;

function WaitlistRoute() {
    const { entryId, tab } = Route.useSearch();
    const activeTab = tab ?? 'pending';
    const navigate = useNavigate();
    const [searchQuery, setSearchQuery] = useState('');
    const deleteDialog = useDialogValue<WaitlistEntry>();
    const deleting = deleteDialog.value;

    const { data: entries = [], isLoading } = useWaitlistEntries(activeTab);

    const accept = useAcceptWaitlistEntry();
    const reject = useRejectWaitlistEntry();
    const resend = useResendWaitlistInvite();
    const remove = useDeleteWaitlistEntry();

    const query = searchQuery.toLowerCase();
    const filtered = entries.filter(
        (e) => e.email.toLowerCase().includes(query) || e.notes.toLowerCase().includes(query),
    );
    const selected = entries.find((e) => e.id === entryId);
    const isPending = accept.isPending || reject.isPending || resend.isPending || remove.isPending;

    const handleTabChange = (value: string) => {
        navigate({ to: '/waitlist', search: { tab: value } });
    };

    const detail = useDetailHistory<string>(entryId !== undefined, (next, { replace, state }) =>
        navigate({ to: '/waitlist', search: (prev) => ({ ...prev, entryId: next }), replace, state }),
    );

    const handleDelete = async (entry: WaitlistEntry) => {
        await remove.mutateAsync(entry.id);
        detail.close();
    };

    if (isLoading) return <LoadingState />;

    const listToolbar = (
        <div className="flex items-center w-full gap-2">
            <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Search waitlist..." />
        </div>
    );

    const detailToolbar = selected ? (
        <WaitlistDetailToolbar
            entry={selected}
            onAccept={() => accept.mutate(selected.id, { onSuccess: detail.close })}
            onReject={() => reject.mutate(selected.id, { onSuccess: detail.close })}
            onResend={() => resend.mutate(selected.id)}
            onDelete={() => deleteDialog.openDialog(selected)}
            isPending={isPending}
        />
    ) : null;

    return (
        <>
            <ListDetailLayout
                listToolbar={listToolbar}
                detail={
                    entryId &&
                    (selected ? <WaitlistDetail entry={selected} /> : <EmptyState message="Entry not found" />)
                }
                detailToolbar={detailToolbar}
                onClose={detail.close}
            >
                <div className="app-gutter-x py-2">
                    <Tabs value={activeTab} onValueChange={handleTabChange}>
                        <TabsList className="w-full">
                            {TABS.map((t) => (
                                <TabsTrigger key={t} value={t} className="flex-1 capitalize text-xs">
                                    {t}
                                </TabsTrigger>
                            ))}
                        </TabsList>
                    </Tabs>
                </div>
                {filtered.length === 0 ? (
                    <EmptyState message={`No ${activeTab} entries`} />
                ) : (
                    <div className="flex flex-col">
                        {filtered.map((entry) => (
                            <button
                                key={entry.id}
                                type="button"
                                className={cn(
                                    'flex flex-col gap-0.5 app-gutter-x py-3 text-left hover:bg-muted/50 border-b',
                                    entry.id === entryId && 'bg-muted',
                                )}
                                onClick={() => detail.open(entry.id)}
                            >
                                <UserItem email={entry.email} />
                                {entry.notes && (
                                    <span className="text-xs text-muted-foreground truncate">{entry.notes}</span>
                                )}
                                <span className="text-xs text-muted-foreground">{formatTimeAgo(entry.createdAt)}</span>
                            </button>
                        ))}
                    </div>
                )}
            </ListDetailLayout>
            {deleting && (
                <ConfirmDialog
                    open={deleteDialog.open}
                    onOpenChange={deleteDialog.setOpen}
                    title="Delete waitlist entry"
                    description={
                        <>
                            Permanently delete the waitlist entry for <strong>{deleting.email}</strong>?
                        </>
                    }
                    onConfirm={() => handleDelete(deleting)}
                    confirmText="Delete"
                    destructive
                />
            )}
        </>
    );
}

function WaitlistDetailToolbar({
    entry,
    onAccept,
    onReject,
    onResend,
    onDelete,
    isPending,
}: {
    entry: WaitlistEntry;
    onAccept: () => void;
    onReject: () => void;
    onResend: () => void;
    onDelete: () => void;
    isPending: boolean;
}) {
    return (
        <>
            {entry.status === 'pending' && (
                <>
                    <TooltipButton
                        icon={Check}
                        tooltipText="Accept and invite"
                        onClick={onAccept}
                        disabled={isPending}
                    />
                    <TooltipButton icon={Ban} tooltipText="Reject" onClick={onReject} disabled={isPending} />
                </>
            )}
            {entry.status === 'invited' && (
                <>
                    <TooltipButton
                        icon={RefreshCw}
                        tooltipText="Resend invite"
                        onClick={onResend}
                        disabled={isPending}
                    />
                    <TooltipButton icon={Ban} tooltipText="Reject" onClick={onReject} disabled={isPending} />
                </>
            )}
            {entry.status === 'rejected' && (
                <TooltipButton
                    icon={Check}
                    tooltipText="Re-accept and invite"
                    onClick={onAccept}
                    disabled={isPending}
                />
            )}
            <TooltipButton icon={Trash2} tooltipText="Delete" onClick={onDelete} disabled={isPending} />
        </>
    );
}

function WaitlistDetail({ entry }: { entry: WaitlistEntry }) {
    const statusVariant =
        entry.status === 'pending'
            ? 'secondary'
            : entry.status === 'invited' || entry.status === 'registered'
              ? 'default'
              : 'destructive';

    return (
        <div className="app-gutter space-y-6 h-full overflow-y-auto">
            <div className="flex items-center gap-3">
                <h2 className="text-lg font-medium">{entry.email}</h2>
                <Badge variant={statusVariant} className="capitalize">
                    {entry.status}
                </Badge>
            </div>

            {entry.notes && (
                <div>
                    <h3 className="text-sm font-medium text-muted-foreground mb-1">Notes</h3>
                    <p className="text-sm whitespace-pre-wrap">{entry.notes}</p>
                </div>
            )}

            <Separator />

            <div className="text-sm text-muted-foreground space-y-1">
                <p>Submitted: {formatDateTime(entry.createdAt)}</p>
                {entry.invitedAt && <p>Invited: {formatDateTime(entry.invitedAt)}</p>}
                {entry.inviteExpiresAt && (
                    <p>
                        Invite expires: {formatDateTime(entry.inviteExpiresAt)}
                        {entry.inviteExpiresAt < new Date() && (
                            <Badge variant="destructive" className="ml-2 text-xs">
                                Expired
                            </Badge>
                        )}
                    </p>
                )}
                {entry.registeredAt && <p>Registered: {formatDateTime(entry.registeredAt)}</p>}
                {entry.userId && <p>User ID: {entry.userId}</p>}
            </div>
        </div>
    );
}
