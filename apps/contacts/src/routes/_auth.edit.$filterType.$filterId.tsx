import {createFileRoute, redirect, useNavigate} from '@tanstack/react-router';
import {z} from 'zod';
import {ContactEdit, ContactEditToolbar, ContactFormValues} from '../components/contacts/contact-edit';
import {useAddContact, useContacts, useUpdateContact} from '@workspace/lib/contacts';
import {type Contact} from "@workspace/lib/types/contact";
import {EigenLoader} from "@workspace/ui";
import {ColumnLayout, Column} from "@workspace/ui/components/layout/column-layout";

// Define search params type with Zod schema
const searchSchema = z.object({
    contactId: z.string().optional(),
});

export type ContactEditSearchParams = z.infer<typeof searchSchema>;

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
                    filterId: 'all'
                }
            });
        }

        return result.data;
    },
});

function EditContactRoute() {
    const {filterType, filterId} = Route.useParams();
    const {contactId} = Route.useSearch();
    const navigate = useNavigate();

    const {data: contacts = [], isLoading: contactsLoading} = useContacts();
    const contact = contactId ? contacts.find((c): c is Contact => c.id === contactId) : undefined;
    const updateContactMutation = useUpdateContact();
    const addContactMutation = useAddContact();

    const handleSave = async (data: ContactFormValues) => {
        try {
            const formData = data as ContactFormValues & {avatar?: string | null};
            const contactData: Omit<Contact, 'id'> = {
                ...formData,
                firstName: formData.firstName || '',
                lastName: formData.lastName || '',
                birthday: formData.birthday?.toISOString(),
                labels: formData.labels || [],
                avatar: formData.avatar ?? ''
            };

            if (contactId) {
                await updateContactMutation.mutateAsync({
                    id: contactId,
                    ...contactData
                } as Contact);
            } else {
                const result = await addContactMutation.mutateAsync(contactData);
                const newContact = typeof result === 'object' && result !== null ? result as Contact : null;

                if (newContact && newContact.id) {
                    navigate({
                        to: Route.fullPath,
                        params: {filterType, filterId},
                        search: {contactId: newContact.id},
                    });
                    return;
                }
            }

            navigate({
                to: '/$filterType/$filterId',
                params: {filterType, filterId},
                search: contactId ? {contactId} : {},
            });
        } catch (error) {
            console.error('Error saving contact:', error);
        }
    };

    const handleCancel = () => {
        navigate({
            to: '/$filterType/$filterId',
            params: {filterType, filterId},
            search: contactId ? {contactId} : {},
        });
    };

    if (contactsLoading) {
        return (
            <div className="h-full flex items-center justify-center">
                <EigenLoader/>
            </div>
        );
    }

    if (contactId && !contact) {
        navigate({
            to: '/$filterType/$filterId',
            params: {filterType, filterId},
            search: {},
        });
        return null;
    }

    const emptyContact: Contact = {
        id: '',
        firstName: '',
        lastName: '',
        email: [''],
        phone: [''],
        address: [{}],
        labels: [],
    };

    const isNew = !contactId;

    return (
        <ColumnLayout mobileColumn="editor">
            <Column id="editor" width="flex" onBack={handleCancel} toolbar={<ContactEditToolbar isNew={isNew}/>}>
                <ContactEdit
                    contact={contact || emptyContact}
                    onSave={handleSave}
                    onCancel={handleCancel}
                    filterType={filterType}
                    filterId={filterId}
                />
            </Column>
        </ColumnLayout>
    );
}
