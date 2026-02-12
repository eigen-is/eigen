import {useMemo} from 'react';
import {Link} from '@tanstack/react-router';
import {Search, ArrowUpDown} from 'lucide-react';
import {Button} from "@workspace/ui/components/button";
import {Input} from "@workspace/ui/components/input";
import {UserItem} from "@workspace/ui/components/layout/user-item";
import {type Contact} from "@workspace/lib/types/contact";
import {useContacts} from '@workspace/lib/contacts';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {EigenLoader} from '@workspace/ui';

interface ContactsListToolbarProps {
    searchQuery: string;
    onSearchChange: (query: string) => void;
    sortBy: 'firstName' | 'lastName';
    onSortChange: (sort: 'firstName' | 'lastName') => void;
}

export function ContactsListToolbar({searchQuery, onSearchChange, sortBy, onSortChange}: ContactsListToolbarProps) {
    return (
        <div className="flex items-center justify-between w-full gap-2">
            <div className="relative flex-1 min-w-0">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"/>
                <Input
                    type="text"
                    placeholder="Search contacts..."
                    className="pl-8 w-full h-8 bg-white"
                    value={searchQuery}
                    onChange={(e) => onSearchChange(e.target.value)}
                />
            </div>
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
}

export function ContactsList({filterType = 'filter', filterId = 'all', searchQuery, sortBy}: ContactsListProps) {

    // Gebruik de useContacts hook om contacten op te halen
    const {data: contacts = [], isLoading, error} = useContacts();

    // Filter contacten op basis van filterType en filterId
    const applyFilters = (contacts: Contact[]) => {
        if (!contacts.length) return [];

        // Eerste stap: filterType en filterId toepassen
        let filtered = [...contacts];

        // Als filterType 'label' is, filter op label ID
        if (filterType === 'label' && filterId !== 'all') {
            filtered = filtered.filter(contact =>
                contact.labels && contact.labels.includes(filterId)
            );
        }
        // Als filterType 'filter' is, pas speciale filters toe
        else if (filterType === 'filter') {
            if (filterId === 'frequent') {
                // Hier zou je een frequentie-logica kunnen implementeren
                // Voor nu tonen we gewoon alle contacten
            } else if (filterId === 'recent') {
                // Hier zou je recent toegevoegde/gewijzigde contacten kunnen filteren
                // Voor nu tonen we gewoon alle contacten
            }
        }

        return filtered;
    };

    // Use memoization to prevent unnecessary recalculations
    // Only recalculate when contacts, filterType, or filterId changes
    const filteredContacts = useMemo(() => applyFilters(contacts), [contacts, filterType, filterId]);

    // Sorteer contacten op de geselecteerde sorteermethode
    // Use memoization to prevent unnecessary sorting operations
    const sortedContacts = useMemo(() => {
        return [...filteredContacts].sort((a, b) => {
            if (sortBy === 'firstName') {
                return a.firstName.localeCompare(b.firstName);
            } else {
                return a.lastName.localeCompare(b.lastName);
            }
        });
    }, [filteredContacts, sortBy]);

    // Filter contacten op basis van zoekopdracht
    // Use memoization to prevent unnecessary filtering on each render
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

    // Groepeer contacten op eerste letter
    const groupContactsByLetter = (contacts: Contact[]) => {
        const groups: Record<string, Contact[]> = {};

        for(const contact of contacts) {
            // Gebruik de eerste letter van firstname of lastname, afhankelijk van sorteermethode
            const firstChar = sortBy === 'firstName'
                ? contact.firstName.charAt(0).toUpperCase()
                : contact.lastName.charAt(0).toUpperCase();

            if (!groups[firstChar]) {
                groups[firstChar] = [];
            }

            groups[firstChar].push(contact);
        }

        // Converteer het object naar een array van tuples [letter, contacts] en sorteer op letter
        return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
    };

    // Use memoization for grouping to prevent unnecessary recalculations
    // This intensive operation should only run when the sorted and filtered contacts change
    const groupedContacts = useMemo(() =>
            groupContactsByLetter(searchedContacts),
        [searchedContacts, sortBy]
    );

    if (error) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center text-destructive">
                <p>Er is een fout opgetreden bij het laden van contacten.</p>
                <p className="text-sm">{error instanceof Error ? error.message : 'Onbekende fout'}</p>
            </div>
        );
    }

    return (
        <div className="w-full flex flex-col flex-1 overflow-hidden">
            <div className="flex-1  overflow-y-auto">
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
            </div>
        </div>
    );
}
