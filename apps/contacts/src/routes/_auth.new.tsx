import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {ContactEdit, type ContactFormValues} from '../components/contacts/contact-edit';
import {type Contact} from "@workspace/lib/types/contact";
import {useAddContact} from '@workspace/lib/contacts';

export const Route = createFileRoute('/_auth/new')({
    component: NewContactRoute,
});

function NewContactRoute() {
    const navigate = useNavigate();
    const addContactMutation = useAddContact();

    // Empty contact object for new contacts
    const emptyContact: Contact = {
        id: '',
        firstName: '',
        lastName: '',
        email: [''],
        phone: [''],
        address: [{}],
        labels: [],
    };

    // Handle form submission
    const handleSave = async (data: ContactFormValues) => {
        try {
            // Transform the data for API compatibility (avatar is added by ContactEdit component)
            const formData = data as ContactFormValues & {avatar?: string | null};
            const contactData = {
                ...formData,
                firstName: formData.firstName || '',
                lastName: formData.lastName || '',
                birthday: formData.birthday?.toISOString(),
                labels: formData.labels || [],
                avatar: formData.avatar || undefined
            };

            // Save the contact data
            await addContactMutation.mutateAsync(contactData);

            // Navigate back to the contacts list after saving
            navigate({
                to: '/$filterType/$filterId',
                params: {
                    filterType: 'book',
                    filterId: 'all'
                }
            });
        } catch (error) {
            console.error("Error saving contact:", error);
            // Error is handled in the ContactEdit component
        }
    };

    // Cancel button navigates back to contacts list
    const handleCancel = () => {
        navigate({
            to: '/$filterType/$filterId',
            params: {
                filterType: 'book',
                filterId: 'all'
            }
        });
    };

    return (
        <ContactEdit
            contact={emptyContact}
            onSave={handleSave}
            onCancel={handleCancel}
            filterType="book"
            filterId="all"
        />
    );
}
