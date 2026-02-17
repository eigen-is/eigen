import {useMemo} from 'react';
import {Link} from '@tanstack/react-router';
import {SearchBar} from '@workspace/ui/components/layout/search-bar/search-bar';
import {useContacts} from '@workspace/lib/contacts';
import {Contact} from '@workspace/lib/types/contact';
import {DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator} from '@workspace/ui/components/dropdown-menu';
import {ArrowUpDown, Edit, Trash2} from 'lucide-react';
import {Button} from '@workspace/ui/components/button';
import {EigenLoader} from '@workspace/ui/components/layout/eigen-loader';
import {UserItem} from '@workspace/ui/components/layout/user-item';
import {useContextMenu} from '@workspace/ui/components/layout/context-menu/use-context-menu';
import {ContextMenuAnchor} from '@workspace/ui/components/layout/context-menu/context-menu-anchor';
import {LabelAssignSubMenu} from '@workspace/ui/components/layout/labels/label-assign-sub-menu';
import type {Label} from '@workspace/lib/types/label';

interface ContactsListToolbarProps {
    searchQuery: string;
    onSearchChange: (query: string) => void;
    sortBy: 'firstName' | 'lastName';
    onSortChange: (sort: 'firstName' | 'lastName') => void;
}

export function ContactsListToolbar({searchQuery, onSearchChange, sortBy, onSortChange}: ContactsListToolbarProps) {
    return (
        <div className="flex items-center justify-between w-full gap-2">
            <SearchBar
                placeholder="Search contacts..."
                value={searchQuery}
                onChange={onSearchChange}
                maxWidth="full"
                inputClassName="h-8 bg-white"
            />
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                        <ArrowUpDown className="h-4 w-4"/>
                    </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onSortChange('firstName')}>
                        First name
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onSortChange('lastName')}>
                        Last name
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </div>
    );
}

interface ContactsListProps {
    filterType?: string;
    filterId?: string;
    searchQuery: string;
    sortBy: 'firstName' | 'lastName';
    labels?: Label[];
    onEdit?: (contact: Contact) => void;
    onDelete?: (contact: Contact) => void;
    onToggleLabel?: (contact: Contact, labelId: string) => void;
}

export function ContactsList({filterType = 'filter', filterId = 'all', searchQuery, sortBy, labels = [], onEdit, onDelete, onToggleLabel}: ContactsListProps) {
    const contextMenu = useContextMenu<Contact>();

    const {data: contacts = [], isLoading, error} = useContacts();

    const applyFilters = (contacts: Contact[]) => {
        if (!contacts.length) return [];

        let filtered = [...contacts];

        if (filterType === 'label' && filterId !== 'all') {
            filtered = filtered.filter(contact =>
                contact.labels && contact.labels.includes(filterId)
            );
        }
        else if (filterType === 'filter') {
            // TODO: implement frequency/recency logic
        }

        return filtered;
    };

    const filteredContacts = useMemo(() => applyFilters(contacts), [contacts, filterType, filterId]);

    const sortedContacts = useMemo(() => {
        return [...filteredContacts].sort((a, b) => {
            if (sortBy === 'firstName') {
                return a.firstName.localeCompare(b.firstName);
            } else {
                return a.lastName.localeCompare(b.lastName);
            }
        });
    }, [filteredContacts, sortBy]);

    const searchedContacts = useMemo(() => {
        return searchQuery.length === 0
            ? sortedContacts
            : sortedContacts.filter(contact =>
                contact.firstName.toLowerCase().includes(searchQuery.toLowerCase()) ||
                contact.lastName.toLowerCase().includes(searchQuery.toLowerCase()) ||
                (contact.email && contact.email.some((email: string) =>
                    email.toLowerCase().includes(searchQuery.toLowerCase())
                ))
            );
    }, [sortedContacts, searchQuery]);

    const groupContactsByLetter = (contacts: Contact[]) => {
        const groups: Record<string, Contact[]> = {};

        for(const contact of contacts) {
            const firstChar = sortBy === 'firstName'
                ? contact.firstName.charAt(0).toUpperCase()
                : contact.lastName.charAt(0).toUpperCase();

            if (!groups[firstChar]) {
                groups[firstChar] = [];
            }

            groups[firstChar].push(contact);
        }

        return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
    };

    const groupedContacts = useMemo(() =>
            groupContactsByLetter(searchedContacts),
        [searchedContacts, sortBy]
    );

    if (error) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center text-destructive">
                <p>An error occurred while loading contacts.</p>
                <p className="text-sm">{error instanceof Error ? error.message : 'Unknown error'}</p>
            </div>
        );
    }

    return (
        <div className="w-full flex flex-col flex-1 overflow-hidden">
            <div className="flex-1 overflow-y-auto">
                {isLoading ? (
                    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                        <EigenLoader/>
                    </div>
                ) : groupedContacts.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                        <p>No contacts found.</p>
                    </div>
                ) : (
                    <div>
                        {groupedContacts.map(([letter, contacts]) => (
                            <div key={letter} className="border-b last:border-b-0">
                                <div
                                    className="flex items-center px-6 py-2 bg-muted/50"
                                >
                                    <h2 className="text-sm font-semibold">{letter}</h2>
                                </div>
                                <div>
                                    {contacts.map((contact) => (
                                        <Link
                                            key={contact.id}
                                            to="/$filterType/$filterId"
                                            params={{filterType, filterId}}
                                            search={{contactId: contact.id}}
                                            className="flex items-center gap-3 px-6 py-3 eigen-list-item"
                                            activeProps={{
                                                className: "eigen-list-item-active",
                                            }}
                                            onContextMenu={(e) => contextMenu.handleContextMenu(e, contact)}
                                        >
                                            <UserItem
                                                name={sortBy === 'firstName'
                                                    ? `${contact.firstName} ${contact.lastName}`
                                                    : `${contact.lastName}, ${contact.firstName}`}
                                                email={contact.email && contact.email.length > 0 ? contact.email[0] : undefined}
                                                imageUrl={contact.avatar}
                                                className="flex-1"
                                            />
                                        </Link>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                <ContextMenuAnchor isOpen={contextMenu.isOpen} onClose={contextMenu.close}>
                    <DropdownMenuContent
                        style={{position: 'fixed', left: contextMenu.position.x, top: contextMenu.position.y}}
                    >
                        {onEdit && contextMenu.item && (
                            <DropdownMenuItem onClick={() => { onEdit(contextMenu.item!); contextMenu.close(); }}>
                                <Edit className="w-4 h-4 mr-2"/> Edit
                            </DropdownMenuItem>
                        )}
                        {onDelete && contextMenu.item && (
                            <DropdownMenuItem onClick={() => { onDelete(contextMenu.item!); contextMenu.close(); }}>
                                <Trash2 className="w-4 h-4 mr-2"/> Delete
                            </DropdownMenuItem>
                        )}
                        {onToggleLabel && contextMenu.item && labels.length > 0 && (
                            <>
                                <DropdownMenuSeparator/>
                                <LabelAssignSubMenu
                                    labels={labels}
                                    assignedLabelIds={contextMenu.item.labels || []}
                                    onToggleLabel={(labelId) => {
                                        onToggleLabel(contextMenu.item!, labelId);
                                    }}
                                />
                            </>
                        )}
                    </DropdownMenuContent>
                </ContextMenuAnchor>
            </div>
        </div>
    );
}
