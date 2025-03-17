import { createFileRoute } from '@tanstack/react-router';
import { ContactsList } from '../../components/contacts/contacts-list';

export const Route = createFileRoute('/_auth/c/$filterId/')({
  component: ContactsIndexRoute,
});

function ContactsIndexRoute() {
  return (
    <div className="flex h-full flex-col">
      <ContactsList />
    </div>
  );
}
