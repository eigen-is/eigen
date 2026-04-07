import { createFileRoute, useNavigate } from '@tanstack/react-router';
import {
    useAcceptWaitlistEntry,
    useDeleteWaitlistEntry,
    useRejectWaitlistEntry,
    useResendWaitlistInvite,
    useWaitlistEntries,
} from '@workspace/lib/admin';
import { useAuth } from '@workspace/lib/auth';
import type { WaitlistEntry } from '@workspace/lib/types/waitlist';
import { EmptyState, LoadingState } from '@workspace/ui';
import { Badge } from '@workspace/ui/components/badge';
import { Button } from '@workspace/ui/components/button';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import { DeleteDialog } from '@workspace/ui/components/layout/delete/delete-dialog';
import { SearchBar } from '@workspace/ui/components/layout/search-bar/search-bar';
import { Separator } from '@workspace/ui/components/separator';
import { Tabs, TabsList, TabsTrigger } from '@workspace/ui/components/tabs';
import { formatDistanceToNow } from 'date-fns';
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
    const { user } = useAuth();
    const ownerId = user!.id;
    const { entryId, tab } = Route.useSearch();
    const activeTab = tab ?? 'pending';
    const navigate = useNavigate();
    const [searchQuery, setSearchQuery] = useState('');

    const { data: entries = [], isLoading } = useWaitlistEntries(ownerId, activeTab);

    const accept = useAcceptWaitlistEntry(ownerId);
    const reject = useRejectWaitlistEntry(ownerId);
    const resend = useResendWaitlistInvite(ownerId);
    const remove = useDeleteWaitlistEntry(ownerId);

    const filtered = entries.filter(
        (e) =>
            !searchQuery ||
            e.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
            e.notes.toLowerCase().includes(searchQuery.toLowerCase()),
    );
    const selected = entries.find((e) => e.id === entryId);

    const handleTabChange = (value: string) => {
        navigate({ to: '/waitlist', search: { tab: value } });
    };

    const handleRowClick = (id: string) => {
        navigate({ to: '/waitlist', search: { tab: activeTab, entryId: id } });
    };

    if (isLoading) return <LoadingState />;

    const listToolbar = (
        <div className="flex items-center w-full gap-2">
            <SearchBar value={searchQuery} onChange={setSearchQuery} placeholder="Filter by email..." />
        </div>
    );

    return (
        <ColumnLayout mobileColumn={entryId ? 'detail' : 'list'}>
            <Column id="list" width="350px" toolbar={listToolbar}>
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
                                    className={`flex flex-col gap-0.5 px-4 py-3 text-left hover:bg-muted/50 border-b ${
                                        entry.id === entryId ? 'bg-muted' : ''
                                    }`}
                                    onClick={() => handleRowClick(entry.id)}
                                >
                                    <span className="text-sm font-medium truncate">{entry.email}</span>
                                    {entry.notes && (
                                        <span className="text-xs text-muted-foreground truncate">{entry.notes}</span>
                                    )}
                                    <span className="text-xs text-muted-foreground">
                                        {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true })}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </Column>
            <Column id="detail" width="flex" onBack={() => navigate({ to: '/waitlist', search: { tab: activeTab } })}>
                {selected ? (
                    <WaitlistDetail
                        entry={selected}
                        onAccept={() => accept.mutate(selected.id)}
                        onReject={() => reject.mutate(selected.id)}
                        onResend={() => resend.mutate(selected.id)}
                        onDelete={() => {
                            remove.mutate(selected.id);
                            navigate({ to: '/waitlist', search: { tab: activeTab } });
                        }}
                        isPending={accept.isPending || reject.isPending || resend.isPending || remove.isPending}
                    />
                ) : (
                    <EmptyState message="Select an entry to view details" />
                )}
            </Column>
        </ColumnLayout>
    );
}

function WaitlistDetail({
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
    const [showDelete, setShowDelete] = useState(false);

    const statusVariant =
        entry.status === 'pending'
            ? 'secondary'
            : entry.status === 'invited'
              ? 'default'
              : entry.status === 'registered'
                ? 'default'
                : 'destructive';

    return (
        <div className="p-6 space-y-6">
            <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold">{entry.email}</h2>
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

            <div className="text-sm text-muted-foreground space-y-1">
                <p>Submitted: {new Date(entry.createdAt).toLocaleString()}</p>
                {entry.invitedAt && <p>Invited: {new Date(entry.invitedAt).toLocaleString()}</p>}
                {entry.inviteExpiresAt && (
                    <p>
                        Invite expires: {new Date(entry.inviteExpiresAt).toLocaleString()}
                        {new Date(entry.inviteExpiresAt) < new Date() && (
                            <Badge variant="destructive" className="ml-2 text-xs">
                                Expired
                            </Badge>
                        )}
                    </p>
                )}
                {entry.registeredAt && <p>Registered: {new Date(entry.registeredAt).toLocaleString()}</p>}
                {entry.userId && <p>User ID: {entry.userId}</p>}
            </div>

            <Separator />

            <div className="flex gap-2">
                {entry.status === 'pending' && (
                    <>
                        <Button onClick={onAccept} disabled={isPending}>
                            Accept & Invite
                        </Button>
                        <Button variant="outline" onClick={onReject} disabled={isPending}>
                            Reject
                        </Button>
                    </>
                )}
                {entry.status === 'invited' && (
                    <>
                        <Button onClick={onResend} disabled={isPending}>
                            Resend Invite
                        </Button>
                        <Button variant="outline" onClick={onReject} disabled={isPending}>
                            Reject
                        </Button>
                    </>
                )}
                {entry.status === 'rejected' && (
                    <Button onClick={onAccept} disabled={isPending}>
                        Re-accept & Invite
                    </Button>
                )}
                {entry.status !== 'registered' && (
                    <Button variant="destructive" onClick={() => setShowDelete(true)} disabled={isPending}>
                        Delete
                    </Button>
                )}
            </div>

            <DeleteDialog
                open={showDelete}
                onOpenChange={setShowDelete}
                title="Delete Waitlist Entry"
                description={`Permanently delete the waitlist entry for ${entry.email}?`}
                onDelete={onDelete}
            />
        </div>
    );
}
