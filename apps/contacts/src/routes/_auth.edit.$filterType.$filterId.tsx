import {createFileRoute, redirect, useNavigate} from '@tanstack/react-router';
import {z} from 'zod';
import {ContactEdit, ContactFormValues} from '../components/contacts/contact-edit';
import {useAddContact, useContacts, useUpdateContact} from '../hooks/use-contacts';
import {type Contact} from "@apps/api-server/types/contact";

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

    // Gebruik TanStack Query hooks
    const {data: contacts = [], isLoading: contactsLoading} = useContacts();

    // Vind het huidige contact op basis van id
    const contact = contactId ? contacts.find((c): c is Contact => c.id === contactId) : undefined;

    // Mutatie hooks voor het maken en bijwerken van contacten
    const updateContactMutation = useUpdateContact();
    const addContactMutation = useAddContact();

    // Handle form submission
    const handleSave = async (data: ContactFormValues) => {
        try {
            // Transformeer de data voor compatibiliteit met API
            const contactData: Omit<Contact, 'id'> = {
                ...data,
                birthday: data.birthday ? data.birthday.toISOString().split('T')[0] : undefined,
                labels: data.labels || []
            };

            if (contactId) {
                // Bestaand contact bijwerken
                await updateContactMutation.mutateAsync({
                    id: contactId,
                    ...contactData
                } as Contact);
            } else {
                // Nieuw contact toevoegen
                const result = await addContactMutation.mutateAsync(contactData);

                // Type assertion als Contact, nadat we hebben geverifieerd dat het een object is met een id
                const newContact = typeof result === 'object' && result !== null ? result as Contact : null;

                // Navigeer naar het nieuwe contact als het is aangemaakt
                if (newContact && newContact.id) {
                    navigate({
                        to: Route.fullPath,
                        params: {filterType, filterId},
                        search: {contactId: newContact.id},
                    });
                    return;
                }
            }

            // Navigeer terug naar het contactoverzicht of contactdetail
            navigate({
                to: '/$filterType/$filterId',
                params: {filterType, filterId},
                search: contactId ? {contactId} : {},
            });
        } catch (error) {
            console.error('Error saving contact:', error);
            // Hier zou je een foutmelding kunnen tonen
        }
    };

    const handleCancel = () => {
        navigate({
            to: '/$filterType/$filterId',
            params: {filterType, filterId},
            search: contactId ? {contactId} : {},
        });
    };

    // Toon loading state als contacten worden geladen
    if (contactsLoading) {
        return (
            <div className="h-full flex items-center justify-center">
                <p className="text-muted-foreground">Loading contact information...</p>
            </div>
        );
    }

    // Als we een contactId hebben maar het contact is niet gevonden,
    // navigeer terug naar de lijst
    if (contactId && !contact) {
        navigate({
            to: '/$filterType/$filterId',
            params: {filterType, filterId},
            search: {},
        });
        return null;
    }

    // Als er geen contactId is, maken we een nieuw contact
    const emptyContact: Contact = {
        id: '',
        firstName: '',
        lastName: '',
        email: [''],
        phone: [''],
        address: [{}],
        labels: [],
    };

    return (
        <ContactEdit
            contact={contact || emptyContact}
            onSave={handleSave}
            onCancel={handleCancel}
            filterType={filterType}
            filterId={filterId}
        />
    );
}
