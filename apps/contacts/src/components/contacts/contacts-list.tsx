import { useAuth } from '@workspace/lib/auth';
import { useContacts } from '@workspace/lib/contacts';
import type { Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { EmptyState, ErrorState, LoadingState } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { AlphabeticalList, alphaGroupKey } from '@workspace/ui/components/layout/alphabetical-list';
import { ContextMenuAnchor, useContextMenu } from '@workspace/ui/components/layout/context-menu';
import { LabelAssignSubMenu } from '@workspace/ui/components/layout/labels/label-assign-sub-menu';
import { SearchBar } from '@workspace/ui/components/layout/search-bar/search-bar';
import { UserItem } from '@workspace/ui/components/layout/user-item';
import { useKeyboardListNavigation } from '@workspace/ui/hooks/use-keyboard-list-navigation';
import { useListDrag } from '@workspace/ui/hooks/use-list-drag';
import { useListSelection } from '@workspace/ui/hooks/use-list-selection';
import { useLongPress } from '@workspace/ui/hooks/use-long-press';
import { Toolbar } from '@workspace/ui/index';
import { cn } from '@workspace/ui/lib/utils';
import { ArrowUpDown, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useRef } from 'react';

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
    const { user } = useAuth();
    const listRef = useRef<HTMLDivElement>(null);
    const contextMenu = useContextMenu<Contact>();

    const { data: contacts = [], isLoading, error } = useContacts();

    const filteredContacts = useMemo(() => {
        if (!contacts.length) return [];
        let filtered = [...contacts];
        if (filterType === 'label' && filterId !== 'all') {
            filtered = filtered.filter((contact) => contact.labels?.includes(filterId));
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
        return sortedContacts.filter(
            (contact) =>
                contact.firstName.toLowerCase().includes(q) ||
                contact.lastName.toLowerCase().includes(q) ||
                contact.email?.some((email: string) => email.toLowerCase().includes(q)),
        );
    }, [sortedContacts, searchQuery]);

    const selection = useListSelection({ items: searchedContacts, getId: (c) => c.id });

    const { selectedIndex, handleKeyDown } = useKeyboardListNavigation({
        items: searchedContacts,
        activeId: activeContactId,
        getId: (c) => c.id,
        onSelect: (id) => onRowClick?.(id),
        containerRef: listRef,
        selection,
    });

    const drag = useListDrag({ selection, getId: (c) => c.id, dragType: 'contact' });

    const handleContextMenu = (e: React.MouseEvent, contact: Contact) => {
        if (!selection.isSelected(contact.id)) {
            selection.select(contact.id);
        }
        contextMenu.handleContextMenu(e, contact);
    };

    // Touch long-press and the coarse/hover ⋮ open the same singleton menu right-click does.
    const openMenuAt = contextMenu.openAt;
    const handleLongPress = useCallback(
        (contact: Contact, x: number, y: number) => {
            if (!selection.isSelected(contact.id)) selection.select(contact.id);
            openMenuAt(contact, x, y);
        },
        [selection, openMenuAt],
    );
    const longPress = useLongPress(handleLongPress);

    const openMenuFromButton = (el: HTMLElement, contact: Contact) => {
        if (!selection.isSelected(contact.id)) selection.select(contact.id);
        const rect = el.getBoundingClientRect();
        openMenuAt(contact, rect.left, rect.bottom);
    };

    const contextItems = contextMenu.item
        ? selection.selectedCount > 1
            ? selection.selectedItems
            : [contextMenu.item]
        : [];
    const isSingleSelect = contextItems.length === 1;
    const hasMe = contextItems.some((c) => c.eigenId === user?.id);

    if (error) {
        return <ErrorState message="An error occurred while loading contacts." detail={error.message} />;
    }

    return (
        <div className="w-full flex flex-col flex-1 overflow-hidden">
            <div className="flex-1 overflow-y-auto outline-none" tabIndex={0} ref={listRef} onKeyDown={handleKeyDown}>
                {isLoading ? (
                    <LoadingState />
                ) : searchedContacts.length === 0 ? (
                    <EmptyState message="No contacts found" />
                ) : (
                    <AlphabeticalList
                        items={searchedContacts}
                        getKey={(c) => c.id}
                        getGroupKey={(c) => alphaGroupKey(sortBy === 'firstName' ? c.firstName : c.lastName)}
                        renderItem={(contact, flatIndex) => (
                            <div
                                className={cn(
                                    'flex items-center gap-3 px-6 py-3 eigen-list-item group',
                                    (activeContactId === contact.id || selectedIndex === flatIndex) &&
                                        'eigen-list-item-active',
                                    selection.isSelected(contact.id) && 'eigen-list-item-selected',
                                )}
                                onClick={(e) => {
                                    selection.handleItemClick(contact.id, e);
                                    if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                                        onRowClick?.(contact.id);
                                    }
                                }}
                                onContextMenu={(e) => handleContextMenu(e, contact)}
                                {...drag.getDragProps(contact)}
                                {...longPress.bind(contact)}
                            >
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
                                <button
                                    type="button"
                                    aria-label="More actions"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        openMenuFromButton(e.currentTarget, contact);
                                    }}
                                    className="invisible flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground group-hover:visible pointer-coarse:visible hover:bg-accent"
                                >
                                    <MoreVertical className="h-4 w-4" />
                                </button>
                            </div>
                        )}
                    />
                )}

                <ContextMenuAnchor contextMenu={contextMenu} className="min-w-[200px]">
                    {isSingleSelect && onEdit && contextMenu.item && (
                        <DropdownMenuItem
                            onClick={() => {
                                onEdit(contextMenu.item!);
                                contextMenu.close();
                            }}
                        >
                            <Pencil className="h-4 w-4 mr-2" /> Edit
                        </DropdownMenuItem>
                    )}
                    {onDelete && !hasMe && contextItems.length > 0 && (
                        <DropdownMenuItem
                            onClick={() => {
                                onDelete(contextItems);
                                contextMenu.close();
                            }}
                        >
                            <Trash2 className="h-4 w-4 mr-2" />
                            {isSingleSelect ? 'Delete' : `Delete ${contextItems.length} contacts`}
                        </DropdownMenuItem>
                    )}
                    {onToggleLabel &&
                        contextItems.length > 0 &&
                        labels.length > 0 &&
                        (() => {
                            const allLabelIds = labels.map((l) => l.id);
                            const assignedToAll = allLabelIds.filter((lid) =>
                                contextItems.every((c) => (c.labels || []).includes(lid)),
                            );
                            const assignedToSome = allLabelIds.filter(
                                (lid) =>
                                    !assignedToAll.includes(lid) &&
                                    contextItems.some((c) => (c.labels || []).includes(lid)),
                            );
                            return (
                                <>
                                    <DropdownMenuSeparator />
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
                </ContextMenuAnchor>
            </div>
        </div>
    );
}
