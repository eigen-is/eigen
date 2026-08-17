import { Link, useNavigate } from '@tanstack/react-router';
import { useAuth } from '@workspace/lib/auth';
import type { Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { KebabTrigger, Toolbar, TooltipButton } from '@workspace/ui';
import { DropdownMenu, DropdownMenuContent } from '@workspace/ui/components/dropdown-menu';
import { Separator } from '@workspace/ui/components/separator';
import { Pencil, Trash2 } from 'lucide-react';
import { isSelfContact, useContactMenu } from './contact-menu';

type PersonDetailToolbarProps = {
    // The person as a card (synthetic for team members). Feeds the shared kebab menu.
    contact: Contact;
    // Contact rows are editable; team members aren't — absent editSearch/onDeleteClick hides
    // Edit/Delete. Delete also hides on your own card (same guard as the list's context menu).
    editSearch?: { filterType: string; filterId: string; contactId: string };
    onDeleteClick?: () => void;
    // Contacts-only label wiring; absent for team members.
    labels?: Label[];
    onToggleLabel?: (contacts: Contact[], labelId: string) => void;
};

// One toolbar for every person-detail surface (contact + team member): direct Edit/Delete buttons
// plus the kebab menu, whose items are the same definition the contact list renders.
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
                                labels,
                                onEdit,
                                onDelete: onDeleteClick ? () => onDeleteClick() : undefined,
                                onToggleLabel,
                            })}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </Toolbar>
            {contactMenu.chatWizard}
        </>
    );
}
