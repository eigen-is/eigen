import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { ContactDetail } from '../../components/contacts/contact-detail';
import { getContactById, mockContacts } from '../data/mockData';
import { useState } from 'react';

export const Route = createFileRoute('/_auth/contacts/$contactId')({
  component: ContactDetailRoute,
  validateParams: ({ params }) => {
    const contactId = params.contactId;
    const contact = getContactById(contactId);
    
    if (!contact) {
      throw redirect({
        to: '/contacts',
      });
    }
    
    return {
      contactId,
    };
  },
});

function ContactDetailRoute() {
  const { contactId } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  const [contacts, setContacts] = useState(mockContacts);
  
  const contact = getContactById(contactId);
  
  if (!contact) {
    return null;
  }

  const handleDeleteContact = (id: string) => {
    // In a real app, you would make an API call here
    setContacts(contacts.filter(c => c.id !== id));
    navigate({ to: '/contacts' });
  };

  return (
    <ContactDetail contact={contact} onDelete={handleDeleteContact} />
  );
}
