import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ContactEdit } from '../../components/contacts/contact-edit';
import { type Contact } from "@apps/api-server/types/contact";

export const Route = createFileRoute('/_auth/new')({
  component: NewContactRoute,
});

function NewContactRoute() {
  const navigate = useNavigate();
  
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
  const handleSave = () => {
    // Navigeer terug naar contactenlijst na het opslaan
    navigate({
      to: '/c/$filterType/$filterId',
      params: {
        filterType: 'filter',
        filterId: 'all'
      }
    });
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
