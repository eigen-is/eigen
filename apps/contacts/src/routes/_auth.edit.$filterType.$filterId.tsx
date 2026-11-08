// The page that adds or edits one contact: ContactEdit's form over the live address book. It leaves for the list when
// the contact is gone.

import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { emptyContact } from '@workspace/lib/constants/contact';
import { useContacts, useUpdateContact } from '@workspace/lib/contacts';
import type { CreateContactInput } from '@workspace/lib/types/contact';
import { Column, ColumnLayout, LoadingState } from '@workspace/ui';
import { useEffect } from 'react';
import { z } from 'zod';
import type { ContactFormValues } from '../components/contacts/contact-edit';
import { ContactEdit, ContactEditToolbar } from '../components/contacts/contact-edit';

const searchSchema = z.object({
    contactId: z.string().optional(),
});

export const Route = createFileRoute('/_auth/edit/$filterType/$filterId')({
    component: EditContactRoute,
    validateSearch: (search: Record<string, unknown>) => {
        const result = searchSchema.safeParse(search);

        if (!result.success) {
            throw redirect({
                to: '/$filterType/$filterId',
                params: {
                    filterType: 'book',
                    filterId: 'all',
                },
            });
        }

        return result.data;
    },
});

function EditContactRoute() {
    const { filterType, filterId } = Route.useParams();
    const { contactId } = Route.useSearch();
    const navigate = useNavigate();

    const { data: contacts = [], isLoading: contactsLoading } = useContacts();
    const contact = contactId ? contacts.find((c) => c.id === contactId) : undefined;
    const updateContactMutation = useUpdateContact();

    // A contactId that no longer exists, such as one deleted elsewhere, redirects from an effect, because navigate()
    // can't run while rendering.
    useEffect(() => {
        if (!contactsLoading && contactId && !contact) {
            navigate({ to: '/$filterType/$filterId', params: { filterType, filterId }, search: {} });
        }
    }, [contactsLoading, contactId, contact, navigate, filterType, filterId]);

    const handleSave = async (data: ContactFormValues, etag: string) => {
        const contactData: CreateContactInput = {
            ...data,
            firstName: data.firstName || '',
            lastName: data.lastName || '',
            labels: data.labels || [],
            avatar: data.avatar ?? '',
        };

        if (contactId) {
            await updateContactMutation.mutateAsync({
                id: contactId,
                ...contactData,
                etag,
            });
        }

        navigate({
            to: '/$filterType/$filterId',
            params: { filterType, filterId },
            search: contactId ? { contactId } : {},
        });
    };

    const handleCancel = () => {
        navigate({
            to: '/$filterType/$filterId',
            params: { filterType, filterId },
            search: contactId ? { contactId } : {},
        });
    };

    if (contactsLoading) {
        return <LoadingState />;
    }

    // The effect above is redirecting; render nothing rather than flash the editor over emptyContact.
    if (contactId && !contact) {
        return null;
    }

    const isNew = !contactId;

    return (
        <ColumnLayout mobileColumn="editor">
            <Column id="editor" width="flex" onBack={handleCancel} toolbar={<ContactEditToolbar isNew={isNew} />}>
                <ContactEdit
                    key={contactId}
                    contact={contact || emptyContact}
                    onSave={handleSave}
                    onCancel={handleCancel}
                />
            </Column>
        </ColumnLayout>
    );
}
