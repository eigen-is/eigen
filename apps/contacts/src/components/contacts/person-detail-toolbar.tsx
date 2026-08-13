import { Link } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import { useStartChatWith } from '@workspace/lib/chat';
import { useOpenWriteEmailTo } from '@workspace/lib/mail';
import { KebabTrigger, Toolbar, TooltipButton } from '@workspace/ui';
import { ChatCreateWizard } from '@workspace/ui/components/chat/chat-create-wizard';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
} from '@workspace/ui/components/dropdown-menu';
import { Separator } from '@workspace/ui/components/separator';
import { printDocument } from '@workspace/ui/lib/printElement';
import { Mail, MessageSquare, Pencil, Printer, Trash2 } from 'lucide-react';
import { useState } from 'react';

type PersonDetailToolbarProps = {
    name: string;
    emails: string[];
    // Contact rows are editable; team members aren't — absent editSearch/onDeleteClick hides
    // Edit/Delete. Delete also hides on your own card (same guard as the list's context menu).
    editSearch?: { filterType: string; filterId: string; contactId: string };
    onDeleteClick?: () => void;
};

// One toolbar for every person-detail surface (contact + team member): direct Edit/Delete
// buttons and the actions menu (Send email / Start chat / Print / Edit / Delete).
export function PersonDetailToolbar({ name, emails: allEmails, editSearch, onDeleteClick }: PersonDetailToolbarProps) {
    const openWriteEmailTo = useOpenWriteEmailTo();
    const startChatWith = useStartChatWith();
    const { user } = useAuth();
    const [chatWith, setChatWith] = useState<{ email: string; name: string } | null>(null);

    const emails = allEmails.filter((e) => e.trim().length > 0);
    const email = emails[0];
    // Any address can start a chat — one without an account becomes an ACL invite. Only the
    // caller's own card is excluded: a chat is always with someone else.
    const isSelf = emails.some((e) => e.toLowerCase() === (user?.email ?? '').toLowerCase());
    const canStartChat = emails.length > 0 && !isSelf;
    const showEdit = !!editSearch;
    const showDelete = !!onDeleteClick && !isSelf;

    const handleStartChat = async () => {
        // startChatWith prefers the registered account address among the person's emails; an
        // existing writable 1:1 opens directly, otherwise the wizard opens pre-filled.
        const result = await startChatWith(emails);
        if (result !== 'opened') setChatWith({ email: result.email, name });
    };

    return (
        <>
            <Toolbar>
                <div className="flex items-center gap-1 ml-auto">
                    {editSearch && (
                        <Link
                            to="/edit/$filterType/$filterId"
                            params={{ filterType: editSearch.filterType, filterId: editSearch.filterId }}
                            search={{ contactId: editSearch.contactId }}
                        >
                            <TooltipButton icon={Pencil} tooltipText="Edit" className="h-8 w-8" />
                        </Link>
                    )}
                    {showDelete && <TooltipButton icon={Trash2} tooltipText="Delete" onClick={onDeleteClick} />}

                    {(showEdit || showDelete) && <Separator orientation="vertical" className="h-6 mx-1" />}

                    <DropdownMenu>
                        <KebabTrigger />
                        <DropdownMenuContent align="end">
                            {email && (
                                <DropdownMenuItem onClick={() => openWriteEmailTo(email)}>
                                    <Mail className="mr-2" />
                                    Send email
                                </DropdownMenuItem>
                            )}
                            {canStartChat && (
                                <DropdownMenuItem onClick={() => void handleStartChat()}>
                                    <MessageSquare className="mr-2" />
                                    Start chat
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={printDocument}>
                                <Printer className="mr-2" />
                                Print
                            </DropdownMenuItem>
                            {(showEdit || showDelete) && <DropdownMenuSeparator />}
                            {editSearch && (
                                <DropdownMenuItem asChild className="cursor-pointer">
                                    <Link
                                        to="/edit/$filterType/$filterId"
                                        params={{ filterType: editSearch.filterType, filterId: editSearch.filterId }}
                                        search={{ contactId: editSearch.contactId }}
                                    >
                                        <Pencil className="mr-2" />
                                        Edit
                                    </Link>
                                </DropdownMenuItem>
                            )}
                            {showDelete && (
                                <DropdownMenuItem onClick={onDeleteClick}>
                                    <Trash2 className="mr-2" />
                                    Delete
                                </DropdownMenuItem>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </Toolbar>
            <ChatCreateWizard
                open={!!chatWith}
                onOpenChange={(open) => {
                    if (!open) setChatWith(null);
                }}
                initialPeople={chatWith ? [chatWith] : undefined}
            />
        </>
    );
}
