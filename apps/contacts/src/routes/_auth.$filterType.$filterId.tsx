// The contacts page: the address book, a label or a team's members as a list, filtered by the URL's
// filterType and filterId. The contact the URL's contactId names opens its detail beside the list, and
// one that is gone says so there.
// The page also hosts the delete confirmation and the import picker its list and detail share.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import {
    useContacts,
    useDeleteContact,
    useImportContacts,
    useImportContactsFile,
    useLabels,
    useUpdateContact,
} from '@workspace/lib/contacts';
import { useMyTeams } from '@workspace/lib/home';
import type { Contact } from '@workspace/lib/types/contact';
import { isVCardFile, VCARD_ACCEPT } from '@workspace/lib/types/drive';
import { DeleteDialog, EmptyState, ListDetailLayout, LoadingState } from '@workspace/ui';
import { IMPORTING_CONTACTS_TITLE } from '@workspace/ui/components/contacts';
import { FileImportPicker } from '@workspace/ui/components/drive';
import { LabelFilterHeader } from '@workspace/ui/components/labels';
import { useState } from 'react';
import { ContactDetail, ContactDetailToolbar } from '../components/contacts/contact-detail';
import { ContactsList, ContactsListToolbar } from '../components/contacts/contacts-list';
import { TeamMemberDetail, TeamMemberDetailToolbar } from '../components/contacts/team-member-detail';
import { TeamMemberList } from '../components/contacts/team-member-list';

type ContactsSearchParams = {
    contactId?: string;
};

export const Route = createFileRoute('/_auth/$filterType/$filterId')({
    component: ContactsRoute,
    validateSearch: (search: Record<string, unknown>): ContactsSearchParams => {
        const contactId = typeof search.contactId === 'string' ? search.contactId : undefined;
        return { contactId };
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
    const { data: myTeams = [], isLoading: teamsLoading } = useMyTeams();
    const deleteMutation = useDeleteContact();
    const updateContactMutation = useUpdateContact();
    const importMutation = useImportContacts();
    const importFileMutation = useImportContactsFile();

    const [importOpen, setImportOpen] = useState(false);
    const [deleteTargets, setDeleteTargets] = useState<Contact[]>([]);
    const deleteDialogOpen = deleteTargets.length > 0;

    const handleConfirmDelete = async () => {
        // allSettled, not all (matching onToggleLabel): one 412 mid-batch must not reject the whole run and
        // skip the navigate, leaving the dialog stuck open.
        await Promise.allSettled(deleteTargets.map((c) => deleteMutation.mutateAsync({ id: c.id, etag: c.etag })));
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

    // Shared by the list context menu and the detail kebab — toggle one label across the batch.
    const handleToggleLabel = async (selectedContacts: Contact[], labelId: string) => {
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
                    return updateContactMutation.mutateAsync({ ...c, labels: [...currentLabels, labelId] });
                }
                return Promise.resolve();
            }),
        );
    };

    const contact = contacts.find((c) => c.id === contactId);

    const listToolbar = (
        <ContactsListToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            // Team members carry a single display name — no first/last sort to offer, and the
            // member list holds no cards to import into or export.
            onSortChange={filterType === 'team' ? undefined : setSortBy}
            onImportClick={filterType === 'team' ? undefined : () => setImportOpen(true)}
        />
    );

    const detailToolbar = contact ? (
        <ContactDetailToolbar
            contact={contact}
            filterType={filterType}
            filterId={filterId}
            labels={labels}
            onToggleLabel={handleToggleLabel}
            onDeleteClick={() => setDeleteTargets([contact])}
        />
    ) : null;

    if (filterType === 'team') {
        const activeTeam = myTeams.find((t) => t.id === filterId);
        const activeMember = activeTeam?.members.find((m) => m.email === contactId);

        if (teamsLoading) {
            return <LoadingState />;
        }

        return (
            <ListDetailLayout
                listToolbar={listToolbar}
                detail={
                    contactId &&
                    (activeMember ? (
                        <TeamMemberDetail member={activeMember} />
                    ) : (
                        <EmptyState message="Member not found" />
                    ))
                }
                detailToolbar={activeMember && <TeamMemberDetailToolbar member={activeMember} />}
                onBackToList={handleBackToList}
            >
                <TeamMemberList
                    members={activeTeam?.members || []}
                    activeMemberEmail={contactId}
                    searchQuery={searchQuery}
                    onRowClick={handleRowClick}
                />
            </ListDetailLayout>
        );
    }

    if (contactsLoading) {
        return <LoadingState />;
    }

    return (
        <>
            <ListDetailLayout
                listToolbar={listToolbar}
                detail={
                    contactId &&
                    (contact ? <ContactDetail contact={contact} /> : <EmptyState message="Contact not found" />)
                }
                detailToolbar={detailToolbar}
                onBackToList={handleBackToList}
            >
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
                    onToggleLabel={handleToggleLabel}
                />
            </ListDetailLayout>

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

            <FileImportPicker
                open={importOpen}
                onOpenChange={setImportOpen}
                title="Import contacts"
                accept={VCARD_ACCEPT}
                canPick={(item) => isVCardFile(item.mimeType, item.name)}
                onDeviceFile={(file) => importMutation.mutate(file)}
                onDrivePick={(item) =>
                    importFileMutation.mutate({
                        drive: { sourceOwnerId: item.ownerId, sourceMountId: item.mountId, sourcePathId: item.id },
                    })
                }
                pending={importMutation.isPending || importFileMutation.isPending}
                progressTitle={IMPORTING_CONTACTS_TITLE}
            />
        </>
    );
}
