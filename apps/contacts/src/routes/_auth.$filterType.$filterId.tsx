import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {ContactsList, ContactsListToolbar} from '../components/contacts/contacts-list';
import {ContactDetail, ContactDetailToolbar} from '../components/contacts/contact-detail';
import {useContacts, useDeleteContact, useLabels} from '@workspace/lib/contacts';
import {EigenLoader} from '@workspace/ui/components/layout/eigen-loader';
import {LabelFilterHeader} from "@workspace/ui/components/layout/labels/label-filter-header";
import {ColumnLayout, Column} from "@workspace/ui/components/layout/column-layout";
import {useLayout} from "@workspace/ui/components/layout/layout-context";
import {useEffect, useState} from 'react';

export type ContactsSearchParams = {
    contactId?: string;
}

export const Route = createFileRoute('/_auth/$filterType/$filterId')({
    component: ContactsRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const contactId = typeof search.contactId === 'string' ? search.contactId : undefined;
        return {contactId} as ContactsSearchParams;
    },
});

function ContactsRoute() {
    const {filterType, filterId} = Route.useParams();
    const {contactId} = Route.useSearch();
    const navigate = useNavigate();
    const {isMobile, navigateToColumn} = useLayout();

    const [searchQuery, setSearchQuery] = useState('');
    const [sortBy, setSortBy] = useState<'firstName' | 'lastName'>('firstName');

    const {data: contacts = [], isLoading: contactsLoading} = useContacts();
    const {data: labels = []} = useLabels();
    const deleteMutation = useDeleteContact();

    const handleDeleteContact = async (id: string) => {
        try {
            await deleteMutation.mutateAsync(id);
            navigate({
                to: Route.fullPath,
                params: {filterType, filterId},
                search: {},
            });
        } catch (error) {
            console.error('Failed to delete contact:', error);
        }
    };

    const handleBackToList = () => {
        navigate({
            to: Route.fullPath,
            params: {filterType, filterId},
            search: {},
        });
    };

    const contact = contactsLoading ? undefined : contacts.find(c => c.id === contactId);
    const targetCol = isMobile ? (contactId ? 'detail' : 'list') : 'list';

    useEffect(() => {
        navigateToColumn(targetCol);
    }, [targetCol, navigateToColumn]);

    useEffect(() => {
        if (!contactsLoading && contactId && !contact) {
            navigate({
                to: Route.fullPath,
                params: {filterType, filterId},
                search: {},
            });
        }
    }, [contactsLoading, contactId, contact, navigate, filterType, filterId]);

    const listToolbar = (
        <ContactsListToolbar
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            sortBy={sortBy}
            onSortChange={setSortBy}
        />
    );

    const detailToolbar = contact ? (
        <ContactDetailToolbar
            contact={contact}
            filterType={filterType}
            filterId={filterId}
            onDeleteClick={() => handleDeleteContact(contact.id)}
        />
    ) : null;

    if (contactsLoading) {
        return (
            <div className="h-full flex items-center justify-center">
                <EigenLoader/>
            </div>
        );
    }

    return (
        <ColumnLayout>
            <Column id="list" width="350px" toolbar={listToolbar}>
                <div className="flex h-full flex-col border-r overflow-y-auto">
                    {filterType === 'label' && (
                        <LabelFilterHeader
                            labels={labels}
                            labelId={filterId}
                        />
                    )}
                    <ContactsList filterType={filterType} filterId={filterId} searchQuery={searchQuery} sortBy={sortBy}/>
                </div>
            </Column>
            <Column id="detail" width="flex" backTo="list" onBack={handleBackToList} toolbar={detailToolbar}>
                {contact ? (
                    <ContactDetail
                        contact={contact}
                        onDelete={handleDeleteContact}
                        filterType={filterType}
                        filterId={filterId}
                    />
                ) : (
                    <div className="h-full w-full flex items-center justify-center">
                        <p className="text-muted-foreground">Select a contact to view details</p>
                    </div>
                )}
            </Column>
        </ColumnLayout>
    );
}
