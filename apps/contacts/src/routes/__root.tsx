import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { type AuthContextType, useAuth } from '@workspace/lib/auth';
import { useContacts, useUpdateContact } from '@workspace/lib/contacts';
import { AppShell } from '@workspace/ui/components/layout/app/app-shell.tsx';
import { ContactsSidebar } from '../components/contacts/contacts-sidebar';

type MyRouterContext = {
    auth: AuthContextType;
};

function ContactsRoot() {
    const { user } = useAuth();

    if (!user) {
        return (
            <AppShell appName="contacts" rootRoute={Route}>
                <Outlet />
            </AppShell>
        );
    }

    return <AuthenticatedContactsRoot />;
}

function AuthenticatedContactsRoot() {
    const { data: contacts = [] } = useContacts();
    const updateContact = useUpdateContact();

    const handleAssignLabelByDrop = async (contactIds: string[], labelId: string) => {
        await Promise.allSettled(
            contactIds.map((id) => {
                const contact = contacts.find((c) => c.id === id);
                if (contact) {
                    const currentLabels = contact.labels || [];
                    if (!currentLabels.includes(labelId)) {
                        return updateContact.mutateAsync({ ...contact, labels: [...currentLabels, labelId] });
                    }
                }
                return Promise.resolve();
            }),
        );
    };

    return (
        <AppShell
            appName="contacts"
            rootRoute={Route}
            sidebar={({ condensed, isMobile, onClose }) => (
                <ContactsSidebar
                    condensed={condensed}
                    isMobile={isMobile}
                    onClose={onClose}
                    onAssignLabel={handleAssignLabelByDrop}
                />
            )}
        >
            <Outlet />
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
    component: ContactsRoot,
});
