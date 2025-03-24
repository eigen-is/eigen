import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {ContactsList} from '../components/contacts/contacts-list';
import {ContactDetail} from '../components/contacts/contact-detail';
import {useContacts, useDeleteContact} from '../hooks/use-contacts';
import {useLabels} from '../hooks/use-labels';
import {useMediaQuery} from '../hooks/use-media-query';

// Define search params type
export interface ContactsSearchParams {
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
    const isMobile = useMediaQuery('(max-width: 768px)');

    // Use TanStack Query hooks for contacts and labels
    const {data: contacts = [], isLoading: contactsLoading} = useContacts();
    const {data: labels = []} = useLabels();
    const deleteMutation = useDeleteContact();

    // Get title based on filter type and ID
    let title = 'All Contacts';

    if (filterType === 'label') {
        const label = labels.find(label => label.id === filterId);
        if (label) {
            title = `${label.name} contacts`;
        }
    } else if (filterType === 'book') {
        if (filterId === 'frequent') {
            title = 'Frequent Contacts';
        } else if (filterId === 'recent') {
            title = 'Recent Contacts';
        }
    }

    // Handle contact deletion
    const handleDeleteContact = async (id: string) => {
        try {
            await deleteMutation.mutateAsync(id);
            // Navigate back to the current filter without the contactId
            navigate({
                to: Route.fullPath,
                params: {filterType, filterId},
                search: {},
            });
        } catch (error) {
            console.error('Failed to delete contact:', error);
        }
    };

    // Handle back navigation (mainly for mobile)
    const handleBackToList = () => {
        navigate({
            to: Route.fullPath,
            params: {filterType, filterId},
            search: {},
        });
    };

    // Show loading status
    if (contactsLoading) {
        return (
            <div className="h-full flex items-center justify-center">
                <p className="text-muted-foreground">Loading contacts...</p>
            </div>
        );
    }

    // On mobile: If a contactId is provided, show only the contact detail view
    if (isMobile && contactId) {
        const contact = contacts.find(c => c.id === contactId);
        if (contact) {
            return (
                <div className="flex flex-col h-full">
                    <ContactDetail
                        contact={contact}
                        onDelete={handleDeleteContact}
                        filterType={filterType}
                        filterId={filterId}
                        onBack={handleBackToList}
                    />
                </div>
            );
        } else {
            // If contact not found, navigate back to the list
            navigate({
                to: Route.fullPath,
                params: {filterType, filterId},
                search: {},
            });
            return null;
        }
    }

    // Desktop/Tablet: Three-column layout (sidebar already handled in _auth.tsx)
    return (
        <div className="flex h-full w-full">
            {/* Middle column: Contacts list (hidden on mobile when viewing a contact) */}
            <div className={`
        ${isMobile && contactId ? 'hidden' : 'block'}
        w-full md:w-[350px] border-r h-full overflow-y-auto
      `}>
                <div className="flex h-full flex-col">
                    {filterType === 'label' && (
                        <div className="h-12 px-4 flex items-center border-b">
                            <h1 className="text-base font-medium flex items-center gap-2">
                                {(() => {
                                    if (filterType === 'label') {
                                        const label = labels.find(l => l.id === filterId);
                                        if (label) {
                                            return (
                                                <>
                          <span
                              className="h-3 w-3 rounded-full"
                              style={{backgroundColor: label.color}}
                          />
                                                    {title}
                                                </>
                                            );
                                        }
                                    }
                                    return title;
                                })()}
                            </h1>
                        </div>
                    )}
                    <ContactsList filterType={filterType} filterId={filterId}/>
                </div>
            </div>

            {/* Right column: Contact details or empty state */}
            <div className={`
        ${isMobile && !contactId ? 'hidden' : 'block'}
        flex-1 h-full overflow-y-auto
      `}>
                {contactId ? (
                    (() => {
                        const contact = contacts.find(c => c.id === contactId);
                        if (contact) {
                            return (
                                <ContactDetail
                                    contact={contact}
                                    onDelete={handleDeleteContact}
                                    filterType={filterType}
                                    filterId={filterId}
                                    onBack={handleBackToList}
                                />
                            );
                        } else {
                            // Navigate back to the list if contact not found
                            navigate({
                                to: Route.fullPath,
                                params: {filterType, filterId},
                                search: {},
                            });
                            return null;
                        }
                    })()
                ) : (
                    <div className="h-full w-full flex items-center justify-center">
                        <p className="text-muted-foreground">Select a contact to view details</p>
                    </div>
                )}
            </div>
        </div>
    );
}
