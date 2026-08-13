import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { emptyContact } from '@workspace/lib/constants/contact';
import { useAddContact } from '@workspace/lib/contacts';
import { Column, ColumnLayout } from '@workspace/ui';
import { ContactEdit, ContactEditToolbar, type ContactFormValues } from '../components/contacts/contact-edit';

export const Route = createFileRoute('/_auth/new')({
    component: NewContactRoute,
});

function NewContactRoute() {
    const navigate = useNavigate();
    const addContactMutation = useAddContact();

    const handleSave = async (data: ContactFormValues) => {
        const contactData = {
            ...data,
            firstName: data.firstName || '',
            lastName: data.lastName || '',
            birthday: data.birthday?.toISOString(),
            labels: data.labels || [],
            avatar: data.avatar ?? '',
        };

        const newId = await addContactMutation.mutateAsync(contactData);

        navigate({
            to: '/$filterType/$filterId',
            params: {
                filterType: 'book',
                filterId: 'all',
            },
            search: newId && typeof newId === 'string' ? { contactId: newId } : {},
        });
    };

    const handleCancel = () => {
        navigate({
            to: '/$filterType/$filterId',
            params: {
                filterType: 'book',
                filterId: 'all',
            },
        });
    };

    return (
        <ColumnLayout mobileColumn="editor">
            <Column id="editor" width="flex" onBack={handleCancel} toolbar={<ContactEditToolbar isNew={true} />}>
                <ContactEdit contact={emptyContact} onSave={handleSave} onCancel={handleCancel} />
            </Column>
        </ColumnLayout>
    );
}
