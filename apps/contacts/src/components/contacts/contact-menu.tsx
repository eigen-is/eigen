// The contact menu rows that the list's context menu and the detail pane's kebab share, such as Send email, Start chat,
// labels, Export and Delete, and the dialogs those rows open. Also isSelfContact, the one test of whether a card is the
// signed-in user's own, which every contact surface asks.

import type { AuthUser } from '@workspace/lib/auth';
import { useAuth } from '@workspace/lib/auth';
import { useStartChatWith } from '@workspace/lib/chat';
import { useExportContacts } from '@workspace/lib/contacts';
import { useOpenWriteEmailTo } from '@workspace/lib/mail';
import { useMailEnabled } from '@workspace/lib/public';
import type { Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { ChatCreateWizard } from '@workspace/ui/components/chat';
import { EXPORTING_CONTACTS_TITLE } from '@workspace/ui/components/contacts';
import { MenuSections } from '@workspace/ui/components/context-menu';
import { ProgressDialog } from '@workspace/ui/components/drive';
import { DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { LabelAssignSubMenu } from '@workspace/ui/components/labels';
import { useDialogValue } from '@workspace/ui/hooks/use-dialog-value';
import { printDocument } from '@workspace/ui/lib/print-element';
import { Download, Mail, MessageSquare, Pencil, Printer, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';

// A card is yours if it carries your X-EIGEN-ID self-link, its eigenId, or shares your account email.
export function isSelfContact(contact: Contact, user: AuthUser | null): boolean {
    if (user && contact.eigenId === user.id) return true;
    const myEmail = (user?.email ?? '').trim().toLowerCase();
    return myEmail.length > 0 && contact.email.some((email) => email.trim().toLowerCase() === myEmail);
}

export type ContactMenuActions = {
    labels?: Label[];
    onEdit?: (contact: Contact) => void;
    onDelete?: (contacts: Contact[]) => void;
    onToggleLabel?: (contacts: Contact[], labelId: string) => void;
    // Print clones the on-screen [data-document] detail pane, so it belongs only where one contact's detail shows: the
    // detail kebab, never the list.
    showPrint?: boolean;
    // Export asks the server for these cards by id, so it belongs only where the cards are stored ones, never on the
    // made-up team member card, whose id is a stand-in.
    showExport?: boolean;
};

// The contact rows the list's context menu and the detail kebab share; mount `dialogs` outside the menu content.
export function useContactMenu() {
    const openWriteEmailTo = useOpenWriteEmailTo();
    const mailEnabled = useMailEnabled();
    const startChatWith = useStartChatWith();
    const { exportContacts, isExporting } = useExportContacts();
    const { user } = useAuth();
    const chatWizard = useDialogValue<{ email: string; name: string }[]>();

    const startChat = async (emails: string[], name: string) => {
        // startChatWith prefers the registered account address. An existing one-to-one chat the user can write in opens
        // directly, otherwise the wizard opens filled in.
        const result = await startChatWith(emails);
        if (result !== 'opened') chatWizard.openDialog([{ email: result.email, name }]);
    };

    const renderItems = (contacts: Contact[], close: () => void, actions: ContactMenuActions): ReactNode => {
        const { labels = [], onEdit, onDelete, onToggleLabel, showPrint, showExport } = actions;
        const single = contacts.length === 1 ? contacts[0] : undefined;
        const hasSelf = contacts.some((contact) => isSelfContact(contact, user));

        // Send email and Start chat act on everyone selected who has an address, except the user, who is left out
        // without a word. Each contact gives its first email, as a single selection does.
        const eligible = contacts.filter(
            (contact) => !isSelfContact(contact, user) && contact.email.some((email) => email.trim().length > 0),
        );
        const eligiblePeople = eligible.map((contact) => ({
            email: contact.email.find((email) => email.trim().length > 0)?.trim() ?? '',
            name: `${contact.firstName} ${contact.lastName}`.trim(),
        }));
        const canReach = eligible.length > 0;
        const canMail = canReach && mailEnabled;

        const canExport = !!showExport && contacts.length > 0;

        const labelIds = labels.map((label) => label.id);
        const assignedToAll = labelIds.filter((id) => contacts.every((contact) => (contact.labels ?? []).includes(id)));
        const assignedToSome = labelIds.filter(
            (id) => !assignedToAll.includes(id) && contacts.some((contact) => (contact.labels ?? []).includes(id)),
        );

        return (
            <MenuSections
                open={
                    canReach && (
                        <>
                            {canMail && (
                                <DropdownMenuItem
                                    onClick={() => {
                                        openWriteEmailTo(eligiblePeople.map((person) => person.email));
                                        close();
                                    }}
                                >
                                    <Mail className="h-4 w-4" />
                                    {eligible.length === 1 ? 'Send email' : `Send email to ${eligible.length} contacts`}
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                                onClick={() => {
                                    // One contact may open an existing chat, and its whole address list lets
                                    // startChatWith prefer the registered account. Several open the wizard.
                                    if (eligible.length === 1) {
                                        void startChat(
                                            eligible[0].email.filter((email) => email.trim().length > 0),
                                            eligiblePeople[0].name,
                                        );
                                    } else {
                                        chatWizard.openDialog(eligiblePeople);
                                    }
                                    close();
                                }}
                            >
                                <MessageSquare className="h-4 w-4" />
                                {eligible.length === 1 ? 'Start chat' : `Start chat with ${eligible.length} contacts`}
                            </DropdownMenuItem>
                        </>
                    )
                }
                create={
                    single &&
                    onEdit && (
                        <DropdownMenuItem
                            onClick={() => {
                                onEdit(single);
                                close();
                            }}
                        >
                            <Pencil className="h-4 w-4" /> Edit
                        </DropdownMenuItem>
                    )
                }
                organize={
                    onToggleLabel &&
                    labels.length > 0 &&
                    contacts.length > 0 && (
                        <LabelAssignSubMenu
                            labels={labels}
                            assignedLabelIds={assignedToAll}
                            partialLabelIds={assignedToSome}
                            onToggleLabel={(labelId) => {
                                onToggleLabel(contacts, labelId);
                                close();
                            }}
                        />
                    )
                }
                output={
                    <>
                        {canExport && (
                            <DropdownMenuItem
                                disabled={isExporting}
                                onClick={() => {
                                    void exportContacts(contacts.map((contact) => contact.id));
                                    close();
                                }}
                            >
                                <Download className="h-4 w-4" />
                                {contacts.length === 1 ? 'Export vCard' : `Export ${contacts.length} vCards`}
                            </DropdownMenuItem>
                        )}
                        {single && showPrint && (
                            <DropdownMenuItem
                                onClick={() => {
                                    printDocument();
                                    close();
                                }}
                            >
                                <Printer className="h-4 w-4" /> Print
                            </DropdownMenuItem>
                        )}
                    </>
                }
                destructive={
                    onDelete &&
                    contacts.length > 0 &&
                    !hasSelf && (
                        <DropdownMenuItem
                            variant="destructive"
                            onClick={() => {
                                onDelete(contacts);
                                close();
                            }}
                        >
                            <Trash2 className="h-4 w-4" />
                            {contacts.length === 1 ? 'Delete' : `Delete ${contacts.length} contacts`}
                        </DropdownMenuItem>
                    )
                }
            />
        );
    };

    const dialogs = (
        <>
            <ChatCreateWizard
                open={chatWizard.open}
                onOpenChange={chatWizard.setOpen}
                initialPeople={chatWizard.value}
            />
            <ProgressDialog open={isExporting} title={EXPORTING_CONTACTS_TITLE} />
        </>
    );

    return { renderItems, dialogs };
}
