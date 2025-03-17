import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { ContactsList } from '../../components/contacts/contacts-list';
import { ContactDetail } from '../../components/contacts/contact-detail';
import { getContactById, getLabelById, mockContacts } from '../data/mockData';
import { useState } from 'react';

// Define search params type
export interface ContactsSearchParams {
  contactId?: string;
}

export const Route = createFileRoute('/_auth/c/$filterType/$filterId')({
  component: ContactsRoute,
  validateSearch: (search: Record<string, unknown>) => {
    const contactId = typeof search.contactId === 'string' ? search.contactId : undefined;
    
    // Validate contact ID if present
    if (contactId) {
      const contact = getContactById(contactId);
      if (!contact) {
        throw redirect({
          to: '/c/$filterType/$filterId',
          params: {
            filterType: 'filter',
            filterId: 'all'
          }
        });
      }
    }
    
    return { contactId } as ContactsSearchParams;
  },
});

function ContactsRoute() {
  const { filterType, filterId } = Route.useParams();
  const { contactId } = Route.useSearch();
  const navigate = useNavigate();
  const [contacts, setContacts] = useState(mockContacts);
  
  // Get title based on filter type and ID
  let title = 'All Contacts';
  
  if (filterType === 'label') {
    const label = getLabelById(filterId);
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
  const handleDeleteContact = (id: string) => {
    // In a real app, you would make an API call here
    setContacts(contacts.filter((c) => c.id !== id));
    // Navigate back to the current filter without the contactId
    navigate({
      search: { contactId: undefined }
    });
  };
  
  // If a contactId is provided in search params, show the contact detail view
  if (contactId) {
    const contact = getContactById(contactId);
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
              search: { contactId: undefined }
            });
          }}
        />
      );
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
                const label = getLabelById(filterId);
                if (label) {
                  return (
                    <>
                      <span 
                        className="h-3 w-3 rounded-full" 
                        style={{ backgroundColor: label.color }} 
                      />
                      {label.name} contacts
                    </>
                  );
                }
              }
              return title;
            })()}
          </h1>
        </div>
      )}
      <ContactsList 
        filterType={filterType}
        filterId={filterId}
      />
    </div>
  );
}
