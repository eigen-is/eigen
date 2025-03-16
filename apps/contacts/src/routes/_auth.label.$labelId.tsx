import { createFileRoute, redirect } from '@tanstack/react-router';
import { ContactsList } from '../../components/contacts/contacts-list';
import { getLabelById } from '../data/mockData';

export const Route = createFileRoute('/_auth/label/$labelId')({
  component: ContactsLabelRoute,
  validateParams: ({ params }) => {
    const labelId = params.labelId;
    const label = getLabelById(labelId);
    
    if (!label) {
      throw redirect({
        to: '/all',
      });
    }
    
    return {
      labelId,
    };
  },
});

function ContactsLabelRoute() {
  const { labelId } = Route.useParams();
  const label = getLabelById(labelId);
  
  if (!label) {
    return null;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="py-3 px-6 border-b">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <span 
            className="h-3 w-3 rounded-full" 
            style={{ backgroundColor: label.color }} 
          />
          {label.name} contacts
        </h1>
      </div>
      <ContactsList />
    </div>
  );
}
