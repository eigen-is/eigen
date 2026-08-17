import { useContacts } from '@workspace/lib/contacts';
import type { Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { EmptyState, ErrorState, LoadingState, SearchBar, Toolbar } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { PersonList, UserItem } from '@workspace/ui/components/user';
import { ArrowUpDown } from 'lucide-react';
import { useMemo } from 'react';
import { useContactMenu } from './contact-menu';

type ContactsListToolbarProps = {
    searchQuery: string;
    onSearchChange: (query: string) => void;
    // Absent → no sort toggle (team members carry a single display name, nothing to sort by).
    onSortChange?: (sort: 'firstName' | 'lastName') => void;
};

export function ContactsListToolbar({ searchQuery, onSearchChange, onSortChange }: ContactsListToolbarProps) {
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
                getSearchFields={(c) => [c.firstName, c.lastName, ...(c.email ?? [])]}
                onRowClick={(id) => onRowClick?.(id)}
                selectable
                dragType="contact"
                emptyState={isLoading ? <LoadingState /> : <EmptyState message="No contacts found" />}
                renderPerson={(contact) => (
                    <UserItem
                        name={
                            sortBy === 'firstName'
                                ? `${contact.firstName} ${contact.lastName}`
                                : `${contact.lastName}, ${contact.firstName}`
                        }
                        email={contact.email && contact.email.length > 0 ? contact.email[0] : undefined}
                        imageUrl={contact.avatar}
                        className="flex-1"
                    />
                )}
                renderMenuItems={(contextItems, close) =>
                    // Print is detail-only (it clones the on-screen detail pane), so showPrint stays off here.
                    contactMenu.renderItems(contextItems, close, { labels, onEdit, onDelete, onToggleLabel })
                }
            />
            {contactMenu.chatWizard}
        </>
    );
}
