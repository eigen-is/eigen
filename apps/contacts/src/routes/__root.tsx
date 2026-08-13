import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { type RouterAppContext, useAuth } from '@workspace/lib/auth';
import { useContacts, useUpdateContact } from '@workspace/lib/contacts';
import { AppShell } from '@workspace/ui/components/layout/app/app-shell';
import { ContactsSidebar } from '../components/contacts/contacts-sidebar';

function ContactsRoot() {
    const { user } = useAuth();
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
            sidebar={
                user
                    ? ({ condensed }) => (
                          <ContactsSidebar condensed={condensed} onAssignLabel={handleAssignLabelByDrop} />
                      )
                    : undefined
            }
        >
            <Outlet />
        </AppShell>
    );
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
    component: ContactsRoot,
});
