// The contacts page's list of the address book, or of one label's contacts, and the toolbar above it: search,
// sort by first or last name, and the import and export menu. A row opens its detail and has the shared contact
// menu on right-click. The user's own card can't be deleted. A team's member list reuses the toolbar without
// the sort and the menu.

import { useAuth } from '@workspace/lib/auth';
import { contactFullName, useContacts, useExportContacts } from '@workspace/lib/contacts';
import type { Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { Button } from '@workspace/ui/components/button';
import { EXPORTING_CONTACTS_TITLE } from '@workspace/ui/components/contacts';
import { ProgressDialog } from '@workspace/ui/components/drive';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { EmptyState, ErrorState, LoadingState } from '@workspace/ui/components/layout/app';
import { KebabTrigger, Toolbar } from '@workspace/ui/components/layout/toolbar';
import { SearchBar } from '@workspace/ui/components/search-bar/search-bar';
import { PersonList, UserItem } from '@workspace/ui/components/user';
import { ArrowUpDown, Download, Upload } from 'lucide-react';
import { useMemo } from 'react';
import { isSelfContact, useContactMenu } from './contact-menu';

type ContactsListToolbarProps = {
    searchQuery: string;
    onSearchChange: (query: string) => void;
    // Without it there is no sort toggle: a team member has one display name.
    onSortChange?: (sort: 'firstName' | 'lastName') => void;
    // Without it there is no import or export menu: team members are not cards this book owns.
    onImportClick?: () => void;
};

export function ContactsListToolbar({
    searchQuery,
    onSearchChange,
    onSortChange,
    onImportClick,
}: ContactsListToolbarProps) {
    const { exportContacts, isExporting } = useExportContacts();

    return (
        <Toolbar>
            <SearchBar
                placeholder="Search contacts..."
                value={searchQuery}
                onChange={onSearchChange}
                maxWidth="full"
                inputClassName="h-8 bg-background"
            />
            {onSortChange && (
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                            <ArrowUpDown className="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => onSortChange('firstName')}>First name</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onSortChange('lastName')}>Last name</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
            {onImportClick && (
                <DropdownMenu>
                    <KebabTrigger />
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={onImportClick}>
                            <Upload className="h-4 w-4" /> Import contacts…
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={isExporting} onClick={() => void exportContacts()}>
                            <Download className="h-4 w-4" /> Export all contacts
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
            <ProgressDialog open={isExporting} title={EXPORTING_CONTACTS_TITLE} />
        </Toolbar>
    );
}

type ContactsListProps = {
    filterType?: string;
    filterId?: string;
    searchQuery: string;
    sortBy: 'firstName' | 'lastName';
    activeContactId?: string;
    labels?: Label[];
    onEdit?: (contact: Contact) => void;
    onDelete?: (contacts: Contact[]) => void;
    onToggleLabel?: (contacts: Contact[], labelId: string) => void;
    onRowClick?: (contactId: string) => void;
};

export function ContactsList({
    filterType = 'filter',
    filterId = 'all',
    searchQuery,
    sortBy,
    activeContactId,
    labels = [],
    onEdit,
    onDelete,
    onToggleLabel,
    onRowClick,
}: ContactsListProps) {
    const { data: contacts = [], isLoading, error } = useContacts();
    const contactMenu = useContactMenu();
    const { user } = useAuth();

    const filteredContacts = useMemo(() => {
        if (filterType === 'label' && filterId !== 'all') {
            return contacts.filter((contact) => contact.labels?.includes(filterId));
        }
        return contacts;
    }, [contacts, filterType, filterId]);

    if (error) {
        return <ErrorState message="An error occurred while loading contacts." detail={error.message} />;
    }

    return (
        <>
            <PersonList
                items={filteredContacts}
                searchQuery={searchQuery}
                activeId={activeContactId}
                getId={(c) => c.id}
                getName={(c) => (sortBy === 'firstName' ? c.firstName : c.lastName)}
                getSearchFields={(c) => [c.firstName, c.lastName, ...c.email]}
                onRowClick={(id) => onRowClick?.(id)}
                selectable
                dragType="contact"
                emptyState={isLoading ? <LoadingState /> : <EmptyState message="No contacts found" />}
                renderPerson={(contact) => (
                    <UserItem
                        name={
                            sortBy === 'firstName'
                                ? contactFullName(contact)
                                : `${contact.lastName}, ${contact.firstName}`
                        }
                        email={contact.email.length > 0 ? contact.email[0] : undefined}
                        imageUrl={contact.avatar}
                        className="flex-1"
                    />
                )}
                // Delete and Backspace skip your own card, as the menu does.
                onDelete={
                    onDelete
                        ? (selected) => {
                              if (!selected.some((c) => isSelfContact(c, user))) onDelete(selected);
                          }
                        : undefined
                }
                renderMenuItems={(contextItems, close) =>
                    // Print copies the open detail pane, so the list has none.
                    contactMenu.renderItems(contextItems, close, {
                        labels,
                        onEdit,
                        onDelete,
                        onToggleLabel,
                        showExport: true,
                    })
                }
            />
            {contactMenu.dialogs}
        </>
    );
}
