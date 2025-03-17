import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { getContactById } from '../data/mockData';
import { z } from 'zod';
import { ContactEdit, ContactFormValues } from '../../components/contacts/contact-edit';

// Define search params type with Zod schema
const searchSchema = z.object({
  contactId: z.string().optional(),
});

export type ContactEditSearchParams = z.infer<typeof searchSchema>;

export const Route = createFileRoute('/_auth/c/edit/$filterType/$filterId')({
  component: EditContactRoute,
  validateSearch: (search: Record<string, unknown>) => {
    // Parse and validate the search params
    const result = searchSchema.safeParse(search);
    
    if (!result.success) {
      throw redirect({
        to: '/c/$filterType/$filterId',
        params: {
          filterType: 'filter',
          filterId: 'all'
        }
      });
    }
    
    const { contactId } = result.data;
    
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
      return { contactId };
    }
    
    // If no contactId, redirect to contacts list
    throw redirect({
      to: '/c/$filterType/$filterId',
      params: {
        filterType: 'filter',
        filterId: 'all'
      }
    });
  },
});

function EditContactRoute() {
  console.log("EditContactRoute rendered");
  const { filterType, filterId } = Route.useParams();
  const { contactId } = Route.useSearch();
  const navigate = useNavigate();
  
  // Get contact data
  const contact = getContactById(contactId!);
  console.log("Contact data:", contact);
  
  // Handle form submission
  const handleSave = (data: ContactFormValues) => {
    console.log("Saving contact data:", data);
    // Here you would update the contact in a real implementation
    
    // Navigate back to contact detail
    navigate({
      to: '/c/$filterType/$filterId',
      params: { filterType, filterId },
      search: { contactId }
    });
  };
  
  const handleCancel = () => {
    navigate({
      to: '/c/$filterType/$filterId',
      params: { filterType, filterId },
      search: { contactId }
    });
  };

  if (!contact) {
    return <div>Contact not found</div>;
  }

  return (
    <ContactEdit
      contact={contact}
      onSave={handleSave}
      onCancel={handleCancel}
      filterType={filterType}
      filterId={filterId}
    />
  );
}
