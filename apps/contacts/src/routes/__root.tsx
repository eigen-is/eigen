import {createRootRouteWithContext, Outlet} from '@tanstack/react-router'
import {AuthContextType, useAuth} from "@workspace/lib/auth";
import {AppShell} from "@workspace/ui/components/layout/app/app-shell.tsx";
import {ContactsSidebar} from "../components/contacts/contacts-sidebar";
import {useContacts, useUpdateContact} from "@workspace/lib/contacts";
import {Contact} from "@workspace/lib/types/contact";

interface MyRouterContext {
    auth: AuthContextType;
}

function ContactsRoot() {
    const {user} = useAuth();

    if (!user) {
        return (
            <AppShell appName="contacts" rootRoute={Route}>
                <Outlet/>
            </AppShell>
        );
    }

    return <AuthenticatedContactsRoot/>;
}

function AuthenticatedContactsRoot() {
    const {data: contacts = []} = useContacts();
    const updateContact = useUpdateContact();

    const handleAssignLabelByDrop = (contactIds: string[], labelId: string) => {
        for (const id of contactIds) {
            const contact = contacts.find(c => c.id === id);
            if (contact) {
                const currentLabels = contact.labels || [];
                if (!currentLabels.includes(labelId)) {
                    updateContact.mutate({...contact, labels: [...currentLabels, labelId]} as Contact);
                }
            }
        }
    };

    return (
        <AppShell
            appName="contacts"
            rootRoute={Route}
            sidebar={({condensed, isMobile, onClose}) => (
                <ContactsSidebar
                    condensed={condensed}
                    isMobile={isMobile}
                    onClose={onClose}
                    onAssignLabel={handleAssignLabelByDrop}
                />
            )}
        >
            <Outlet/>
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: ContactsRoot,
});
