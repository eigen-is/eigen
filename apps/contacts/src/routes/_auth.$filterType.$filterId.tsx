import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useContacts, useDeleteContact, useLabels, useUpdateContact } from '@workspace/lib/contacts';
import { useMyTeams } from '@workspace/lib/home';
import type { Contact } from '@workspace/lib/types/contact';
import { Column, ColumnLayout, DeleteDialog, EmptyState, LoadingState } from '@workspace/ui';
import { LabelFilterHeader } from '@workspace/ui/components/labels';
import { useEffect, useState } from 'react';
import { ContactDetail, ContactDetailToolbar } from '../components/contacts/contact-detail';
import { ContactsList, ContactsListToolbar } from '../components/contacts/contacts-list';
import { TeamMemberDetail, TeamMemberDetailToolbar } from '../components/contacts/team-member-detail';
import { TeamMemberList } from '../components/contacts/team-member-list';

type ContactsSearchParams = {
    contactId?: string;
};

export const Route = createFileRoute('/_auth/$filterType/$filterId')({
    component: ContactsRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const contactId = typeof search.contactId === 'string' ? search.contactId : undefined;
        return { contactId } as ContactsSearchParams;
    },
});

function ContactsRoute() {
    const { filterType, filterId } = Route.useParams();
    const { contactId } = Route.useSearch();
    const navigate = useNavigate();

    const [searchQuery, setSearchQuery] = useState('');
    const [sortBy, setSortBy] = useState<'firstName' | 'lastName'>('firstName');

    const { data: contacts = [], isLoading: contactsLoading } = useContacts();
    const { data: labels = [] } = useLabels();
    const { data: myTeams = [] } = useMyTeams();
    const deleteMutation = useDeleteContact();
    const updateContactMutation = useUpdateContact();

    const [deleteTargets, setDeleteTargets] = useState<Contact[]>([]);
    const deleteDialogOpen = deleteTargets.length > 0;

    const handleConfirmDelete = async () => {
        await Promise.all(deleteTargets.map((c) => deleteMutation.mutateAsync(c.id)));
        navigate({
            to: Route.fullPath,
            params: { filterType, filterId },
            search: {},
        });
    };

    const handleBackToList = () => {
        navigate({
            to: Route.fullPath,
            params: { filterType, filterId },
            search: {},
        });
    };

    const handleRowClick = (id: string) => {
        navigate({
            to: Route.fullPath,
            params: { filterType, filterId },
            search: { contactId: id },
        });
    };

    const contact = contactsLoading ? undefined : contacts.find((c) => c.id === contactId);

    useEffect(() => {
        if (filterType === 'team') return;
        if (!contactsLoading && contactId && !contact) {
            navigate({
                to: Route.fullPath,
                params: { filterType, filterId },
                search: {},
            });
        }
    }, [contactsLoading, contactId, contact, navigate, filterType, filterId]);

    const listToolbar = (
        <ContactsListToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            // Team members carry a single display name — no first/last sort to offer.
            onSortChange={filterType === 'team' ? undefined : setSortBy}
        />
    );

    const detailToolbar = contact ? (
        <ContactDetailToolbar
            contact={contact}
            filterType={filterType}
            filterId={filterId}
            onDeleteClick={() => setDeleteTargets([contact])}
        />
    ) : null;

    if (filterType === 'team') {
        const activeTeam = myTeams.find((t) => t.id === filterId);
        const activeMember = activeTeam?.members.find((m) => m.email === contactId);

        return (
            <ColumnLayout mobileColumn={contactId ? 'detail' : 'list'}>
                <Column id="list" width="350px" onBack="sidebar" toolbar={listToolbar}>
                    <div className="flex h-full flex-col border-r overflow-y-auto">
                        <TeamMemberList
                            members={activeTeam?.members || []}
                            activeMemberEmail={contactId}
                            searchQuery={searchQuery}
                            onRowClick={handleRowClick}
                        />
                    </div>
                </Column>
                <Column
                    id="detail"
                    width="flex"
                    onBack={handleBackToList}
                    toolbar={activeMember ? <TeamMemberDetailToolbar member={activeMember} /> : null}
                >
                    {activeMember ? (
                        <TeamMemberDetail member={activeMember} />
                    ) : (
                        <EmptyState message="Select a member to view details" />
                    )}
                </Column>
            </ColumnLayout>
        );
    }

    if (contactsLoading) {
        return <LoadingState />;
    }

    return (
        <>
            <ColumnLayout mobileColumn={contactId ? 'detail' : 'list'}>
                <Column id="list" width="350px" onBack="sidebar" toolbar={listToolbar}>
                    <div className="flex h-full flex-col border-r overflow-y-auto">
                        {filterType === 'label' && <LabelFilterHeader labels={labels} labelId={filterId} />}
                        <ContactsList
                            filterType={filterType}
                            filterId={filterId}
                            searchQuery={searchQuery}
                            sortBy={sortBy}
                            activeContactId={contactId}
                            labels={labels}
                            onRowClick={handleRowClick}
                            onEdit={(contact) => {
                                navigate({
                                    to: '/edit/$filterType/$filterId',
                                    params: { filterType, filterId },
                                    search: { contactId: contact.id },
                                });
                            }}
                            onDelete={(selectedContacts) => {
                                setDeleteTargets(selectedContacts);
                            }}
                            onToggleLabel={async (selectedContacts, labelId) => {
                                const allHaveLabel = selectedContacts.every((c) => (c.labels || []).includes(labelId));
                                await Promise.allSettled(
                                    selectedContacts.map((c) => {
                                        const currentLabels = c.labels || [];
                                        if (allHaveLabel) {
                                            return updateContactMutation.mutateAsync({
                                                ...c,
                                                labels: currentLabels.filter((id) => id !== labelId),
                                            });
                                        } else if (!currentLabels.includes(labelId)) {
                                            return updateContactMutation.mutateAsync({
                                                ...c,
                                                labels: [...currentLabels, labelId],
                                            });
                                        }
                                        return Promise.resolve();
                                    }),
                                );
                            }}
                        />
                    </div>
                </Column>
                <Column id="detail" width="flex" onBack={handleBackToList} toolbar={detailToolbar}>
                    {contact ? (
                        <ContactDetail contact={contact} />
                    ) : (
                        <EmptyState message="Select a contact to view details" />
                    )}
                </Column>
            </ColumnLayout>

            <DeleteDialog
                open={deleteDialogOpen}
                onOpenChange={(open) => {
                    if (!open) setDeleteTargets([]);
                }}
                title="Delete Contact"
                description={
                    deleteTargets.length > 1
                        ? `Are you sure you want to delete ${deleteTargets.length} contacts`
                        : 'Are you sure you want to delete'
                }
                itemName={
                    deleteTargets.length === 1
                        ? `${deleteTargets[0].firstName} ${deleteTargets[0].lastName}`
                        : undefined
                }
                onDelete={handleConfirmDelete}
            />
        </>
    );
}
