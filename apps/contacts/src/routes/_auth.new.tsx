// The page that adds a contact: ContactEdit's form over a blank card. A Save opens the new contact beside the list.

import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { emptyContact } from '@workspace/lib/constants/contact';
import { useAddContact } from '@workspace/lib/contacts';
import type { CreateContactInput } from '@workspace/lib/types/contact';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app';
import { ContactEdit, ContactEditToolbar } from '../components/contacts/contact-edit';

export const Route = createFileRoute('/_auth/new')({
    component: NewContactRoute,
});

function NewContactRoute() {
    const navigate = useNavigate();
    const addContactMutation = useAddContact();

    const handleSave = async (data: CreateContactInput) => {
        const contactId = await addContactMutation.mutateAsync(data);
        navigate({
            to: '/$filterType/$filterId',
            params: { filterType: 'book', filterId: 'all' },
            search: { contactId },
        });
    };

    const handleCancel = () => {
        navigate({ to: '/$filterType/$filterId', params: { filterType: 'book', filterId: 'all' } });
    };

    return (
        <ColumnLayout mobileColumn="editor">
            <Column id="editor" width="flex" onBack={handleCancel} toolbar={<ContactEditToolbar isNew />}>
                <ContactEdit contact={emptyContact} onSave={handleSave} onCancel={handleCancel} />
            </Column>
        </ColumnLayout>
    );
}
