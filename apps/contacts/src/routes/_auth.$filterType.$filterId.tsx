import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {ContactsList} from '../components/contacts/contacts-list';
import {ContactDetail} from '../components/contacts/contact-detail';
import {useContacts, useDeleteContact, useLabels, useMediaQuery} from '@workspace/lib/contacts';
import {toast} from "sonner";
import {EigenLoader} from '@workspace/ui/components/layout/eigen-loader';
import {LabelFilterHeader} from "@workspace/ui/components/layout/labels/label-filter-header";

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

    // Handle contact deletion
    const handleDeleteContact = async (id: string) => {
        try {
            await deleteMutation.mutateAsync(id);
            toast.info("Contact deleted", {
                description: "Moved to Trash"
            });
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
                <EigenLoader/>
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
                        isMobile={isMobile}
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
                    {filterType === 'label' && (<LabelFilterHeader labels={labels} labelId={filterId} />)}
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
