import {createFileRoute} from '@tanstack/react-router'
import {useAuth} from '@workspace/lib/auth/auth-context.js';
import {useContacts} from '@workspace/lib/contacts';

export const Route = createFileRoute('/_auth/user')({
    component: RouteComponent,
})

function RouteComponent() {
    const navigate = Route.useNavigate();
    const {data: contacts = [], isLoading: contactsLoading} = useContacts();
    const auth = useAuth();

    if (contacts) {
        // find yourself!
        const yourself = contacts.find(contact => contact.eigenId === auth.user?.id);
        if (yourself) {
            navigate({
                href: `${import.meta.env.VITE_APP_CONTACTS_URL}/book/all?contactId=${yourself.id}`,
                reloadDocument: true,
                replace: true,
            });
            return null;
        }
    }
    return null;
}
