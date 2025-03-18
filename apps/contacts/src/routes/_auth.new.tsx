import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ContactEdit, ContactFormValues } from '../../components/contacts/contact-edit';
import { useAddContact } from '../hooks/use-contacts';
import { type Contact } from "@apps/api-server/types/contact";

export const Route = createFileRoute('/_auth/new')({
  component: NewContactRoute,
});

function NewContactRoute() {
  const navigate = useNavigate();
  
  // Mutatie hook voor het toevoegen van contacten
  const addContactMutation = useAddContact();
  
  // Leeg contact object voor nieuwe contacten
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
      // Transformeer de data voor compatibiliteit met API
      const contactData = {
        ...data,
        birthday: data.birthday ? data.birthday.toISOString().split('T')[0] : undefined,
        labels: data.labels || []
      };
      
      // Nieuw contact toevoegen
      const result = await addContactMutation.mutateAsync(contactData);
      const newContact = typeof result === 'object' && result !== null ? result as Contact : null;
      
      // Navigeer naar het nieuwe contact als het is aangemaakt
      if (newContact && newContact.id) {
        navigate({
          to: '/c/$filterType/$filterId',
          params: {
            filterType: 'filter',
            filterId: 'all'
          },
          search: { contactId: newContact.id },
        });
      } else {
        // Als er geen id is, navigeer terug naar contactenlijst
        navigate({
          to: '/c/$filterType/$filterId',
          params: {
            filterType: 'filter',
            filterId: 'all'
          }
        });
      }
    } catch (error) {
      console.error('Error creating contact:', error);
      // Hier zou je een foutmelding kunnen tonen
    }
  };
  
  // Cancel knop navigeert terug naar contactenlijst
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
