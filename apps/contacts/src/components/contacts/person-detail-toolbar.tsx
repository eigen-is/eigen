// The toolbar above a person's detail in Contacts, a stored contact's or a team member's: the Edit and Delete
// buttons where they apply, and the kebab with the shared contact menu. A team member's card is built on the fly,
// so it has no Edit, Delete or Export, and nobody deletes their own card.

import { Link, useNavigate } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import type { Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { DropdownMenu, DropdownMenuContent } from '@workspace/ui/components/dropdown-menu';
import { KebabTrigger, Toolbar, TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { Separator } from '@workspace/ui/components/separator';
import { Pencil, Trash2 } from 'lucide-react';
import { isSelfContact, useContactMenu } from './contact-menu';

type PersonDetailToolbarProps = {
    // A team member's card is built for the menu, not stored.
    contact: Contact;
    // Absent for team members, who can't be edited. Delete also hides on your own card.
    editSearch?: { filterType: string; filterId: string; contactId: string };
    onDeleteClick?: () => void;
    // Absent for team members, who have no labels.
    labels?: Label[];
    onToggleLabel?: (contacts: Contact[], labelId: string) => void;
};

export function PersonDetailToolbar({
    contact,
    editSearch,
    onDeleteClick,
    labels,
    onToggleLabel,
}: PersonDetailToolbarProps) {
    const navigate = useNavigate();
    const { user } = useAuth();
    const contactMenu = useContactMenu();

    const showEdit = !!editSearch;
    const showDelete = !!onDeleteClick && !isSelfContact(contact, user);

    const onEdit = editSearch
        ? () =>
              navigate({
                  to: '/edit/$filterType/$filterId',
                  params: { filterType: editSearch.filterType, filterId: editSearch.filterId },
                  search: { contactId: editSearch.contactId },
              })
        : undefined;

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
                            {contactMenu.renderItems([contact], () => {}, {
                                showPrint: true,
                                // A team member's card is not stored, so there is nothing to export by id.
                                showExport: !!editSearch,
                                labels,
                                onEdit,
                                onDelete: onDeleteClick,
                                onToggleLabel,
                            })}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </Toolbar>
            {contactMenu.dialogs}
        </>
    );
}
