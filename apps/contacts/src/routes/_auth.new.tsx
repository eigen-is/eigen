import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ContactEdit } from '../components/contacts/contact-edit';
import { type Contact } from "@apps/api-server/types/contact";
import { useAddContact } from '../hooks/use-contacts';
import { type ContactFormValues } from '../components/contacts/contact-edit';

export const Route = createFileRoute('/_auth/new')({
  component: NewContactRoute,
});

function NewContactRoute() {
  const navigate = useNavigate();
  const addContactMutation = useAddContact();
  
  // Empty contact object for new contacts
  const emptyContact: Contact = {
    id: '',
    firstName: '',
    lastName: '',
    email: [''],
    phone: [''],
    address: [{}],
    labels: [],
  };

  // Handle form submission
  const handleSave = async (data: ContactFormValues) => {
    try {
      // Save the contact data
      await addContactMutation.mutateAsync(data);
      
      // Navigate back to the contacts list after saving
      navigate({
        to: '/c/$filterType/$filterId',
        params: {
          filterType: 'filter',
          filterId: 'all'
        }
      });
    } catch (error) {
      console.error("Error saving contact:", error);
      // Error is handled in the ContactEdit component
    }
  };
  
  // Cancel button navigates back to contacts list
  const handleCancel = () => {
    navigate({
      to: '/c/$filterType/$filterId',
      params: {
        filterType: 'filter',
        filterId: 'all'
      }
    });
  };

  return (
    <ContactEdit
      contact={emptyContact}
      onSave={handleSave}
      onCancel={handleCancel}
      filterType="filter"
      filterId="all"
    />
  );
}
