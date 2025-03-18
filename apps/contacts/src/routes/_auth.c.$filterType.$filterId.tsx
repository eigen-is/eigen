import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ContactsList } from '../../components/contacts/contacts-list';
import { ContactDetail } from '../../components/contacts/contact-detail';
import { useContacts, useDeleteContact } from '../hooks/use-contacts';
import { useLabels } from '../hooks/use-labels';

// Define search params type
export interface ContactsSearchParams {
  contactId?: string;
}

export const Route = createFileRoute('/_auth/c/$filterType/$filterId')({
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
  
  // Gebruik TanStack Query hooks voor contacten en labels
  const { data: contacts = [], isLoading: contactsLoading } = useContacts();
  const { data: labels = [] } = useLabels();
  const deleteMutation = useDeleteContact();
  
  // Get title based on filter type and ID
  let title = 'All Contacts';
  
  if (filterType === 'label') {
    const label = labels.find(label => label.id === filterId);
    if (label) {
      title = `${label.name} contacts`;
    }
  } else if (filterType === 'filter') {
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
        params: { filterType, filterId },
        search: {},
      });
    } catch (error) {
      console.error('Failed to delete contact:', error);
    }
  };
  
  // Toon laadstatus
  if (contactsLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-muted-foreground">Loading contacts...</p>
      </div>
    );
  }
  
  // If a contactId is provided in search params, show the contact detail view
  if (contactId) {
    const contact = contacts.find(c => c.id === contactId);
    if (contact) {
      return (
        <ContactDetail 
          contact={contact} 
          onDelete={handleDeleteContact}
          filterType={filterType}
          filterId={filterId}
          onBack={() => {
            // Navigate back to the current filter without the contactId
            navigate({
              to: Route.fullPath,
              params: { filterType, filterId },
              search: {},
            });
          }}
        />
      );
    } else {
      // Als het contact niet gevonden wordt, navigeer terug naar de lijst
      navigate({
        to: Route.fullPath,
        params: { filterType, filterId },
        search: {},
      });
      return null;
    }
  }
  
  // Otherwise, show the contacts list view
  return (
    <div className="flex h-full flex-col">
      {filterType === 'label' && (
        <div className="py-3 px-6 border-b">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            {(() => {
              if (filterType === 'label') {
                const label = labels.find(l => l.id === filterId);
                if (label) {
                  return (
                    <>
                      <span 
                        className="h-3 w-3 rounded-full" 
                        style={{ backgroundColor: label.color }}
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
      <ContactsList filterType={filterType} filterId={filterId} />
    </div>
  );
}
