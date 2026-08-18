import { type AuthUser, useAuth } from '@workspace/lib/auth';
import { useStartChatWith } from '@workspace/lib/chat';
import { useOpenWriteEmailTo } from '@workspace/lib/mail';
import type { Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { ChatCreateWizard } from '@workspace/ui/components/chat';
import { DropdownMenuItem, DropdownMenuSeparator } from '@workspace/ui/components/dropdown-menu';
import { LabelAssignSubMenu } from '@workspace/ui/components/labels';
import { printDocument } from '@workspace/ui/lib/printElement';
import { Mail, MessageSquare, Pencil, Printer, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';

// One "is this card me?" test for every contact surface: a card is you if it carries your
// X-EIGEN-ID self-link (eigenId) or shares your account email — the two proxies the list and
// the detail page used to check separately.
export function isSelfContact(contact: Contact, user: AuthUser | null): boolean {
    if (user && contact.eigenId === user.id) return true;
    const myEmail = (user?.email ?? '').trim().toLowerCase();
    return myEmail.length > 0 && (contact.email ?? []).some((e) => e.trim().toLowerCase() === myEmail);
}

export type ContactMenuActions = {
    labels?: Label[];
    onEdit?: (contact: Contact) => void;
    onDelete?: (contacts: Contact[]) => void;
    onToggleLabel?: (contacts: Contact[], labelId: string) => void;
    // Print clones the on-screen [data-document] detail pane, so it only belongs where a single
    // contact's detail is showing — the detail kebab, never the multi-context list.
    showPrint?: boolean;
};

// The single menu-item definition the contact list's context menu and the detail page's kebab both
// render — same actions, same order on both surfaces (Send email, Start chat, Print, Edit, Delete,
// Assign label). Send email and Start chat act on the whole selection, silently dropping your own
// card (a mail/chat with yourself is pointless); print and edit are single-select-only; delete and
// labels act on the whole batch. Owns the start-chat handoff and the wizard both surfaces open, so
// mount `chatWizard` at a stable spot outside the menu content.
export function useContactMenu() {
    const openWriteEmailTo = useOpenWriteEmailTo();
    const startChatWith = useStartChatWith();
    const { user } = useAuth();
    const [chatWith, setChatWith] = useState<{ email: string; name: string }[] | null>(null);

    const startChat = async (emails: string[], name: string) => {
        // startChatWith prefers the registered account address; an existing writable 1:1 opens
        // directly, otherwise the wizard opens pre-filled.
        const result = await startChatWith(emails);
        if (result !== 'opened') setChatWith([{ email: result.email, name }]);
    };

    const renderItems = (contacts: Contact[], close: () => void, actions: ContactMenuActions): ReactNode => {
        const { labels = [], onEdit, onDelete, onToggleLabel, showPrint } = actions;
        const single = contacts.length === 1 ? contacts[0] : undefined;
        const hasSelf = contacts.some((c) => isSelfContact(c, user));

        // Send email / Start chat act on everyone selected who isn't me and has an address — self is
        // silently dropped. Each contact contributes its first email (the single-select convention).
        const eligible = contacts.filter(
            (c) => !isSelfContact(c, user) && (c.email ?? []).some((e) => e.trim().length > 0),
        );
        const eligiblePeople = eligible.map((c) => ({
            email: (c.email ?? []).find((e) => e.trim().length > 0)?.trim() ?? '',
            name: `${c.firstName} ${c.lastName}`.trim(),
        }));
        const canReach = eligible.length > 0;

        const topGroup = canReach || (!!single && !!showPrint);
        const editGroup = (!!single && !!onEdit) || (!!onDelete && contacts.length > 0 && !hasSelf);

        const labelIds = labels.map((l) => l.id);
        const assignedToAll = labelIds.filter((id) => contacts.every((c) => (c.labels ?? []).includes(id)));
        const assignedToSome = labelIds.filter(
            (id) => !assignedToAll.includes(id) && contacts.some((c) => (c.labels ?? []).includes(id)),
        );

        return (
            <>
                {canReach && (
                    <>
                        <DropdownMenuItem
                            onClick={() => {
                                openWriteEmailTo(eligiblePeople.map((p) => p.email));
                                close();
                            }}
                        >
                            <Mail className="h-4 w-4 mr-2" />
                            {eligible.length === 1 ? 'Send email' : `Send email to ${eligible.length} contacts`}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onClick={() => {
                                // One eligible contact keeps the direct-open probe (its full address
                                // list lets startChatWith prefer the registered account); several open
                                // the wizard directly, pre-filled with every eligible person.
                                if (eligible.length === 1) {
                                    void startChat(
                                        (eligible[0].email ?? []).filter((e) => e.trim().length > 0),
                                        eligiblePeople[0].name,
                                    );
                                } else {
                                    setChatWith(eligiblePeople);
                                }
                                close();
                            }}
                        >
                            <MessageSquare className="h-4 w-4 mr-2" />
                            {eligible.length === 1 ? 'Start chat' : `Start chat with ${eligible.length} contacts`}
                        </DropdownMenuItem>
                    </>
                )}
                {single && showPrint && (
                    <DropdownMenuItem
                        onClick={() => {
                            printDocument();
                            close();
                        }}
                    >
                        <Printer className="h-4 w-4 mr-2" /> Print
                    </DropdownMenuItem>
                )}

                {topGroup && editGroup && <DropdownMenuSeparator />}

                {single && onEdit && (
                    <DropdownMenuItem
                        onClick={() => {
                            onEdit(single);
                            close();
                        }}
                    >
                        <Pencil className="h-4 w-4 mr-2" /> Edit
                    </DropdownMenuItem>
                )}
                {onDelete && contacts.length > 0 && !hasSelf && (
                    <DropdownMenuItem
                        onClick={() => {
                            onDelete(contacts);
                            close();
                        }}
                    >
                        <Trash2 className="h-4 w-4 mr-2" />
                        {contacts.length === 1 ? 'Delete' : `Delete ${contacts.length} contacts`}
                    </DropdownMenuItem>
                )}

                {onToggleLabel && labels.length > 0 && contacts.length > 0 && (
                    <>
                        {(topGroup || editGroup) && <DropdownMenuSeparator />}
                        <LabelAssignSubMenu
                            labels={labels}
                            assignedLabelIds={assignedToAll}
                            partialLabelIds={assignedToSome}
                            onToggleLabel={(labelId) => {
                                onToggleLabel(contacts, labelId);
                                close();
                            }}
                        />
                    </>
                )}
            </>
        );
    };

    const chatWizard = (
        <ChatCreateWizard
            open={!!chatWith}
            onOpenChange={(open) => {
                if (!open) setChatWith(null);
            }}
            initialPeople={chatWith ?? undefined}
        />
    );

    return { renderItems, chatWizard };
}
