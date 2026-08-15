import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { emptyContact } from '@workspace/lib/constants/contact';
import { useAddContact, useContacts, useUpdateContact } from '@workspace/lib/contacts';
import type { Contact } from '@workspace/lib/types/contact';
import { Column, ColumnLayout, LoadingState } from '@workspace/ui';
import { useEffect } from 'react';
import { z } from 'zod';
import { ContactEdit, ContactEditToolbar, type ContactFormValues } from '../components/contacts/contact-edit';

const searchSchema = z.object({
    contactId: z.string().optional(),
});

export const Route = createFileRoute('/_auth/edit/$filterType/$filterId')({
    component: EditContactRoute,
    validateSearch: (search: Record<string, unknown>) => {
        // Parse and validate the search params
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
    const contact = contactId ? contacts.find((c): c is Contact => c.id === contactId) : undefined;
    const updateContactMutation = useUpdateContact();
    const addContactMutation = useAddContact();

    // Redirect away from a contactId that no longer exists (e.g. deleted elsewhere) from an effect, not the
    // render body — matching the sibling list route's idiom rather than calling navigate() while rendering.
    useEffect(() => {
        if (!contactsLoading && contactId && !contact) {
            navigate({ to: '/$filterType/$filterId', params: { filterType, filterId }, search: {} });
        }
    }, [contactsLoading, contactId, contact, navigate, filterType, filterId]);

    const handleSave = async (data: ContactFormValues, etag?: string) => {
        const contactData: Omit<Contact, 'id'> = {
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
                // The etag ContactEdit snapshotted when it loaded these fields — not the live query's, which SSE
                // can advance mid-edit. A drifted card then 412s instead of silently clobbering the newer write.
                etag,
            });
        } else {
            const newId = await addContactMutation.mutateAsync(contactData);

            if (newId && typeof newId === 'string') {
                navigate({
                    to: '/$filterType/$filterId',
                    params: { filterType, filterId },
                    search: { contactId: newId },
                });
                return;
            }
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
                    // Remount when the loaded card's etag changes (e.g. after a 412 refetch) so the form fields
                    // and the snapshotted etag re-seed together and the next save carries the fresh etag.
                    key={(contact || emptyContact).etag}
                    contact={contact || emptyContact}
                    onSave={handleSave}
                    onCancel={handleCancel}
                />
            </Column>
        </ColumnLayout>
    );
}
