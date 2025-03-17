import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpDown, Search } from 'lucide-react';
import { mockContacts, groupContactsByLetter, type Contact } from '../../src/data/mockData';
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";

export function ContactsList() {
  const [sortBy, setSortBy] = useState<'firstName' | 'lastName'>('firstName');
  const [searchQuery, setSearchQuery] = useState('');
  
  // Group contacts by first letter
  const groupedContacts = groupContactsByLetter(sortBy);
  
  // Filter grouped contacts based on search query
  const filteredGroups = searchQuery.length === 0
    ? groupedContacts
    : groupedContacts.map(([letter, contacts]) => {
        const filteredContacts = contacts.filter(contact => 
          contact.firstName.toLowerCase().includes(searchQuery.toLowerCase()) ||
          contact.lastName.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (contact.email && contact.email.some(email => email.toLowerCase().includes(searchQuery.toLowerCase())))
        );
        return [letter, filteredContacts] as [string, Contact[]];
      }).filter(([_, contacts]) => contacts.length > 0);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex items-center justify-between p-4 border-b">
        <div className="relative w-full max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder="Search contacts..."
            className="pl-8 w-full"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="ml-2 gap-1">
                Sort by: {sortBy === 'firstName' ? 'First name' : 'Last name'}
                <ArrowUpDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setSortBy('firstName')}>
                First name
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSortBy('lastName')}>
                Last name
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {filteredGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <p>No contacts found.</p>
          </div>
        ) : (
          <div>
            {filteredGroups.map(([letter, contacts]) => (
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
                      to={`/c/all/$contactId`}
                      params={{ contactId: contact.id }}
                      className="flex items-center gap-3 px-6 py-3 hover:bg-muted transition-colors"
                      activeProps={{
                        className: "bg-primary/10",
                      }}
                    >
                      <div className="h-8 w-8 rounded-full overflow-hidden bg-muted">
                        {contact.avatar ? (
                          <img 
                            src={contact.avatar} 
                            alt={`${contact.firstName} ${contact.lastName}`}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="h-full w-full flex items-center justify-center bg-primary/10 text-primary font-medium">
                            {contact.firstName.charAt(0)}
                            {contact.lastName.charAt(0)}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col">
                        <span className="font-medium">
                          {sortBy === 'firstName' 
                            ? `${contact.firstName} ${contact.lastName}` 
                            : `${contact.lastName}, ${contact.firstName}`}
                        </span>
                        {contact.email && contact.email.length > 0 && (
                          <span className="text-sm text-muted-foreground">{contact.email[0]}</span>
                        )}
                      </div>
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
