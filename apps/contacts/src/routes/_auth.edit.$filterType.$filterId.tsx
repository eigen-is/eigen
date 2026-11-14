// The page that edits one contact: ContactEdit's form over the live address book. It leaves for the list when the
// contact is gone.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useContacts, useUpdateContact } from '@workspace/lib/contacts';
import type { CreateContactInput } from '@workspace/lib/types/contact';
import { Column, ColumnLayout, LoadingState } from '@workspace/ui/components/layout/app';
import { useEffect } from 'react';
import { ContactEdit, ContactEditToolbar } from '../components/contacts/contact-edit';

export const Route = createFileRoute('/_auth/edit/$filterType/$filterId')({
    component: EditContactRoute,
    validateSearch: (search: Record<string, unknown>) => ({
        contactId: typeof search.contactId === 'string' ? search.contactId : '',
    }),
});

function EditContactRoute() {
    const { filterType, filterId } = Route.useParams();
    const { contactId } = Route.useSearch();
    const navigate = useNavigate();

    const { data: contacts = [], isLoading: contactsLoading } = useContacts();
    const contact = contacts.find((c) => c.id === contactId);
    const updateContactMutation = useUpdateContact();

    // A contactId with no contact, such as one deleted elsewhere, redirects from an effect, because navigate() can't run
    // while rendering.
    useEffect(() => {
        if (!contactsLoading && !contact) {
            navigate({ to: '/$filterType/$filterId', params: { filterType, filterId }, search: {} });
        }
    }, [contactsLoading, contact, navigate, filterType, filterId]);

    const backToContact = () =>
        navigate({ to: '/$filterType/$filterId', params: { filterType, filterId }, search: { contactId } });

    const handleSave = async (data: CreateContactInput, etag: string) => {
        await updateContactMutation.mutateAsync({ id: contactId, ...data, etag });
        backToContact();
    };

    if (contactsLoading) {
        return <LoadingState />;
    }

    if (!contact) {
        return null;
    }

    return (
        <ColumnLayout mobileColumn="editor">
            <Column id="editor" width="flex" onBack={backToContact} toolbar={<ContactEditToolbar isNew={false} />}>
                <ContactEdit key={contactId} contact={contact} onSave={handleSave} onCancel={backToContact} />
            </Column>
        </ColumnLayout>
    );
}
