// The contacts page: the address book, a label or a team's members as a list, filtered by the URL's
// filterType and filterId. The contact the URL's contactId names opens its detail beside the list, and
// one that is gone says so there.
// The page also hosts the delete confirmation and the import picker its list and detail share.

import { createFileRoute, Navigate, useNavigate } from '@tanstack/react-router';
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
import { contactFullName } from '@workspace/lib/types/contact';
import { isVCardFile, VCARD_ACCEPT } from '@workspace/lib/types/file-kinds';
import { ConfirmDialog } from '@workspace/ui/components/confirm-dialog';
import { IMPORTING_CONTACTS_TITLE } from '@workspace/ui/components/contacts';
import { FileImportPicker } from '@workspace/ui/components/drive';
import { LabelFilterHeader } from '@workspace/ui/components/labels';
import { EmptyState, ListDetailLayout, LoadingState } from '@workspace/ui/components/layout/app';
import { useDetailHistory } from '@workspace/ui/hooks/use-detail-history';
import { useDialogValue } from '@workspace/ui/hooks/use-dialog-value';
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
    const { data: labels = [], isSuccess: labelsLoaded } = useLabels();
    const { data: myTeams = [], isLoading: teamsLoading } = useMyTeams();
    const deleteMutation = useDeleteContact();
    const updateContactMutation = useUpdateContact();
    const importMutation = useImportContacts();
    const importFileMutation = useImportContactsFile();

    const [importOpen, setImportOpen] = useState(false);
    const deleteDialog = useDialogValue<Contact[]>();
    const deleteTargets = deleteDialog.value;

    const detail = useDetailHistory(contactId, (next, { replace, state }) =>
        navigate({
            to: Route.fullPath,
            params: { filterType, filterId },
            search: (prev) => ({ ...prev, contactId: next }),
            replace,
            state,
        }),
    );

    const handleConfirmDelete = async (targets: Contact[]) => {
        // allSettled, not all: one 412 mid-batch must not reject the whole run and
        // skip the close, leaving the dialog stuck open.
        await Promise.allSettled(targets.map((c) => deleteMutation.mutateAsync({ id: c.id, etag: c.etag })));
        detail.close();
    };

    const handleToggleLabel = async (selectedContacts: Contact[], labelId: string) => {
        const allHaveLabel = selectedContacts.every((c) => (c.labels ?? []).includes(labelId));
        await Promise.allSettled(
            selectedContacts.map((c) => {
                const currentLabels = c.labels ?? [];
                if (allHaveLabel) {
                    return updateContactMutation.mutateAsync({
                        ...c,
                        labels: currentLabels.filter((id) => id !== labelId),
                    });
                }
                if (!currentLabels.includes(labelId)) {
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
            onDeleteClick={() => deleteDialog.openDialog([contact])}
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
                onClose={detail.close}
            >
                <TeamMemberList
                    members={activeTeam?.members || []}
                    activeMemberEmail={contactId}
                    searchQuery={searchQuery}
                    onRowClick={detail.open}
                />
            </ListDetailLayout>
        );
    }

    // A label deleted here or elsewhere leaves its page with nothing to show.
    if (filterType === 'label' && labelsLoaded && !labels.some((label) => label.id === filterId)) {
        return <Navigate to={Route.fullPath} params={{ filterType: 'book', filterId: 'all' }} replace />;
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
                onClose={detail.close}
            >
                {filterType === 'label' && <LabelFilterHeader labels={labels} labelId={filterId} />}
                <ContactsList
                    filterType={filterType}
                    filterId={filterId}
                    searchQuery={searchQuery}
                    sortBy={sortBy}
                    activeContactId={contactId}
                    labels={labels}
                    onRowClick={detail.open}
                    onEdit={(contact) => {
                        navigate({
                            to: '/edit/$filterType/$filterId',
                            params: { filterType, filterId },
                            search: { contactId: contact.id },
                        });
                    }}
                    onDelete={deleteDialog.openDialog}
                    onToggleLabel={handleToggleLabel}
                />
            </ListDetailLayout>

            {deleteTargets && (
                <ConfirmDialog
                    open={deleteDialog.open}
                    onOpenChange={deleteDialog.setOpen}
                    title="Delete contact"
                    description={
                        deleteTargets.length > 1 ? (
                            `Are you sure you want to delete ${deleteTargets.length} contacts?`
                        ) : (
                            <>
                                Are you sure you want to delete <strong>{contactFullName(deleteTargets[0])}</strong>?
                            </>
                        )
                    }
                    onConfirm={() => handleConfirmDelete(deleteTargets)}
                    confirmText="Delete"
                    destructive
                />
            )}

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
