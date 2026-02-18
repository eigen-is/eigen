import {useMemo, useRef} from 'react';
import {cn} from '@workspace/ui/lib/utils';
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
import {useKeyboardListNavigation} from '@workspace/ui/hooks/use-keyboard-list-navigation';
import {useListSelection} from '@workspace/ui/hooks/use-list-selection';
import {useListDrag} from '@workspace/ui/hooks/use-list-drag';
import type {Label} from '@workspace/lib/types/label';
import {useAuth} from '@workspace/lib/auth';

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
    activeContactId?: string;
    labels?: Label[];
    onEdit?: (contact: Contact) => void;
    onDelete?: (contacts: Contact[]) => void;
    onToggleLabel?: (contacts: Contact[], labelId: string) => void;
    onRowClick?: (contactId: string) => void;
}

export function ContactsList({filterType = 'filter', filterId = 'all', searchQuery, sortBy, activeContactId, labels = [], onEdit, onDelete, onToggleLabel, onRowClick}: ContactsListProps) {
    const {user} = useAuth();
    const listRef = useRef<HTMLDivElement>(null);
    const contextMenu = useContextMenu<Contact>();

    const {data: contacts = [], isLoading, error} = useContacts();

    const filteredContacts = useMemo(() => {
        if (!contacts.length) return [];
        let filtered = [...contacts];
        if (filterType === 'label' && filterId !== 'all') {
            filtered = filtered.filter(contact =>
                contact.labels && contact.labels.includes(filterId)
            );
        }
        return filtered;
    }, [contacts, filterType, filterId]);

    const sortedContacts = useMemo(() => {
        return [...filteredContacts].sort((a, b) => {
            if (sortBy === 'firstName') return a.firstName.localeCompare(b.firstName);
            return a.lastName.localeCompare(b.lastName);
        });
    }, [filteredContacts, sortBy]);

    const searchedContacts = useMemo(() => {
        if (searchQuery.length === 0) return sortedContacts;
        const q = searchQuery.toLowerCase();
        return sortedContacts.filter(contact =>
            contact.firstName.toLowerCase().includes(q) ||
            contact.lastName.toLowerCase().includes(q) ||
            (contact.email && contact.email.some((email: string) => email.toLowerCase().includes(q)))
        );
    }, [sortedContacts, searchQuery]);

    const selection = useListSelection({items: searchedContacts, getId: (c) => c.id});

    const {selectedIndex, handleKeyDown} = useKeyboardListNavigation({
        items: searchedContacts,
        activeId: activeContactId,
        getId: (c) => c.id,
        onSelect: (id) => onRowClick?.(id),
        containerRef: listRef,
        selection,
    });

    const drag = useListDrag({selection, getId: (c) => c.id, dragType: 'contact'});

    const handleContextMenu = (e: React.MouseEvent, contact: Contact) => {
        if (!selection.isSelected(contact.id)) {
            selection.select(contact.id);
        }
        contextMenu.handleContextMenu(e, contact);
    };

    const contextItems = contextMenu.item
        ? (selection.selectedCount > 1 ? selection.selectedItems : [contextMenu.item])
        : [];
    const isSingleSelect = contextItems.length === 1;
    const hasMe = contextItems.some(c => c.eigenId === user?.id);

    const groupedContacts = useMemo(() => {
        const groups: Record<string, Contact[]> = {};
        for (const contact of searchedContacts) {
            const firstChar = sortBy === 'firstName'
                ? contact.firstName.charAt(0).toUpperCase()
                : contact.lastName.charAt(0).toUpperCase();
            if (!groups[firstChar]) groups[firstChar] = [];
            groups[firstChar].push(contact);
        }
        return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
    }, [searchedContacts, sortBy]);

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
            <div
                className="flex-1 overflow-y-auto outline-none"
                ref={listRef}
                tabIndex={0}
                onKeyDown={handleKeyDown}
            >
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
                                <div className="flex items-center px-6 py-2 bg-muted/50">
                                    <h2 className="text-sm font-semibold">{letter}</h2>
                                </div>
                                <div>
                                    {contacts.map((contact) => {
                                        const flatIndex = searchedContacts.indexOf(contact);
                                        return (
                                            <div
                                                key={contact.id}
                                                className={cn(
                                                    "flex items-center gap-3 px-6 py-3 eigen-list-item",
                                                    (activeContactId === contact.id || selectedIndex === flatIndex) && "eigen-list-item-active",
                                                    selection.isSelected(contact.id) && "eigen-list-item-selected",
                                                )}
                                                onClick={(e) => {
                                                    selection.handleItemClick(contact.id, e);
                                                    if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                                                        onRowClick?.(contact.id);
                                                    }
                                                }}
                                                onContextMenu={(e) => handleContextMenu(e, contact)}
                                                {...drag.getDragProps(contact)}
                                            >
                                                <UserItem
                                                    name={sortBy === 'firstName'
                                                        ? `${contact.firstName} ${contact.lastName}`
                                                        : `${contact.lastName}, ${contact.firstName}`}
                                                    email={contact.email && contact.email.length > 0 ? contact.email[0] : undefined}
                                                    imageUrl={contact.avatar}
                                                    className="flex-1"
                                                />
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                <ContextMenuAnchor isOpen={contextMenu.isOpen} onClose={contextMenu.close}>
                    <DropdownMenuContent
                        style={{position: 'fixed', left: contextMenu.position.x, top: contextMenu.position.y}}
                        className="min-w-[200px]"
                    >
                        {isSingleSelect && onEdit && contextMenu.item && (
                            <DropdownMenuItem onClick={() => { onEdit(contextMenu.item!); contextMenu.close(); }}>
                                <Edit className="w-4 h-4 mr-2"/> Edit
                            </DropdownMenuItem>
                        )}
                        {onDelete && !hasMe && contextItems.length > 0 && (
                            <DropdownMenuItem onClick={() => { onDelete(contextItems); contextMenu.close(); }}>
                                <Trash2 className="w-4 h-4 mr-2"/>
                                {isSingleSelect ? 'Delete' : `Delete ${contextItems.length} contacts`}
                            </DropdownMenuItem>
                        )}
                        {onToggleLabel && contextItems.length > 0 && labels.length > 0 && (() => {
                            const allLabelIds = labels.map(l => l.id);
                            const assignedToAll = allLabelIds.filter(lid =>
                                contextItems.every(c => (c.labels || []).includes(lid))
                            );
                            const assignedToSome = allLabelIds.filter(lid =>
                                !assignedToAll.includes(lid) && contextItems.some(c => (c.labels || []).includes(lid))
                            );
                            return (
                                <>
                                    <DropdownMenuSeparator/>
                                    <LabelAssignSubMenu
                                        labels={labels}
                                        assignedLabelIds={assignedToAll}
                                        partialLabelIds={assignedToSome}
                                        onToggleLabel={(labelId) => {
                                            onToggleLabel(contextItems, labelId);
                                            contextMenu.close();
                                        }}
                                    />
                                </>
                            );
                        })()}
                    </DropdownMenuContent>
                </ContextMenuAnchor>
            </div>
        </div>
    );
}
