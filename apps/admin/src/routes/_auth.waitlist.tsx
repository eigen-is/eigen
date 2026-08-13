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
import { Column, ColumnLayout, DeleteDialog, EmptyState, LoadingState, SearchBar, TooltipButton } from '@workspace/ui';
import { Badge } from '@workspace/ui/components/badge';
import { Separator } from '@workspace/ui/components/separator';
import { Tabs, TabsList, TabsTrigger } from '@workspace/ui/components/tabs';
import { UserItem } from '@workspace/ui/components/user';
import { cn } from '@workspace/ui/lib/utils';
import { Check, RefreshCw, Trash2, X } from 'lucide-react';
import { useState } from 'react';

type WaitlistSearch = {
    entryId?: string;
    tab?: string;
};

export const Route = createFileRoute('/_auth/waitlist')({
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
    const [showDelete, setShowDelete] = useState(false);

    const { data: entries = [], isLoading } = useWaitlistEntries(activeTab);

    const accept = useAcceptWaitlistEntry();
    const reject = useRejectWaitlistEntry();
    const resend = useResendWaitlistInvite();
    const remove = useDeleteWaitlistEntry();

    const filtered = entries.filter(
        (e) =>
            !searchQuery ||
            e.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
            e.notes.toLowerCase().includes(searchQuery.toLowerCase()),
    );
    const selected = entries.find((e) => e.id === entryId);
    const isPending = accept.isPending || reject.isPending || resend.isPending || remove.isPending;

    const handleTabChange = (value: string) => {
        navigate({ to: '/waitlist', search: { tab: value } });
    };

    const handleRowClick = (id: string) => {
        navigate({ to: '/waitlist', search: { tab: activeTab, entryId: id } });
    };

    const handleBack = () => navigate({ to: '/waitlist', search: { tab: activeTab } });

    const handleDelete = async () => {
        if (!selected) return;
        await remove.mutateAsync(selected.id);
        handleBack();
    };

    if (isLoading) return <LoadingState />;

    const listToolbar = (
        <div className="flex items-center w-full gap-2">
            <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Filter by email..." />
        </div>
    );

    const detailToolbar = selected ? (
        <WaitlistDetailToolbar
            entry={selected}
            onAccept={() => accept.mutate(selected.id)}
            onReject={() => reject.mutate(selected.id)}
            onResend={() => resend.mutate(selected.id)}
            onDelete={() => setShowDelete(true)}
            isPending={isPending}
        />
    ) : null;

    return (
        <ColumnLayout mobileColumn={entryId ? 'detail' : 'list'}>
            <Column id="list" width="400px" onBack="sidebar" toolbar={listToolbar}>
                <div className="flex h-full flex-col border-r overflow-y-auto">
                    <div className="p-2">
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
                                        'flex flex-col gap-0.5 px-4 py-3 text-left hover:bg-muted/50 border-b',
                                        entry.id === entryId && 'bg-muted',
                                    )}
                                    onClick={() => handleRowClick(entry.id)}
                                >
                                    <UserItem email={entry.email} />
                                    {entry.notes && (
                                        <span className="text-xs text-muted-foreground truncate">{entry.notes}</span>
                                    )}
                                    <span className="text-xs text-muted-foreground">
                                        {formatTimeAgo(entry.createdAt)}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </Column>
            <Column id="detail" width="flex" onBack={handleBack} toolbar={detailToolbar}>
                {selected ? (
                    <WaitlistDetail entry={selected} />
                ) : (
                    <EmptyState message="Select an entry to view details" />
                )}
            </Column>

            <DeleteDialog
                open={showDelete}
                onOpenChange={setShowDelete}
                title="Delete Waitlist Entry"
                description={`Permanently delete the waitlist entry for ${selected?.email}?`}
                onDelete={handleDelete}
            />
        </ColumnLayout>
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
        <div className="flex items-center gap-1 ml-auto">
            {entry.status === 'pending' && (
                <>
                    <TooltipButton icon={Check} tooltipText="Accept & Invite" onClick={onAccept} disabled={isPending} />
                    <TooltipButton icon={X} tooltipText="Reject" onClick={onReject} disabled={isPending} />
                </>
            )}
            {entry.status === 'invited' && (
                <>
                    <TooltipButton
                        icon={RefreshCw}
                        tooltipText="Resend Invite"
                        onClick={onResend}
                        disabled={isPending}
                    />
                    <TooltipButton icon={X} tooltipText="Reject" onClick={onReject} disabled={isPending} />
                </>
            )}
            {entry.status === 'rejected' && (
                <TooltipButton icon={Check} tooltipText="Re-accept & Invite" onClick={onAccept} disabled={isPending} />
            )}
            <TooltipButton icon={Trash2} tooltipText="Delete" onClick={onDelete} disabled={isPending} />
        </div>
    );
}

function WaitlistDetail({ entry }: { entry: WaitlistEntry }) {
    const statusVariant =
        entry.status === 'pending'
            ? 'secondary'
            : entry.status === 'invited'
              ? 'default'
              : entry.status === 'registered'
                ? 'default'
                : 'destructive';

    return (
        <div className="app-gutter space-y-6">
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
