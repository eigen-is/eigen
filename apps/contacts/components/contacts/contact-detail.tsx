import { useState } from 'react';
import { 
  Mail, Phone, Building, MapPin, Calendar, Edit, Trash, Plus, MoreHorizontal 
} from 'lucide-react';
import { Contact, mockLabels } from '../../src/data/mockData';
import { Button } from "@workspace/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@workspace/ui/components/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import { Badge } from "@workspace/ui/components/badge";
import { Link } from '@tanstack/react-router';

interface ContactDetailProps {
  contact: Contact;
  onDelete: (id: string) => void;
}

export function ContactDetail({ contact, onDelete }: ContactDetailProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const handleDelete = () => {
    onDelete(contact.id);
    setDeleteDialogOpen(false);
  };

  const formatPhoneNumber = (phone: string) => {
    return phone; // You might want to add formatting logic here
  };

  const formatAddress = (address: Contact['address'][0]) => {
    if (!address) return '';
    
    const parts = [
      address.street,
      address.city,
      address.state,
      address.zipCode,
      address.country
    ].filter(Boolean);
    
    return parts.join(', ');
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return '';
    
    const date = new Date(dateString);
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    }).format(date);
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex justify-between items-center p-4 border-b">
        <h1 className="text-2xl font-semibold">Contact Details</h1>
        <div className="flex items-center gap-2">
          <Link to={`/all/edit/$contactId`} params={{ contactId: contact.id }}>
            <Button variant="outline" size="sm" className="gap-1">
              <Edit className="h-4 w-4" />
              Edit
            </Button>
          </Link>
          <Button 
            variant="outline" 
            size="sm" 
            className="gap-1 text-destructive"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash className="h-4 w-4" />
            Delete
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem>Send email</DropdownMenuItem>
              <DropdownMenuItem>Schedule meeting</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem>Print</DropdownMenuItem>
              <DropdownMenuItem>Export as vCard</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="flex flex-col md:flex-row gap-8">
          <div className="flex flex-col items-center gap-4">
            <div className="h-40 w-40 rounded-full overflow-hidden bg-muted">
              {contact.avatar ? (
                <img 
                  src={contact.avatar} 
                  alt={`${contact.firstName} ${contact.lastName}`}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="h-full w-full flex items-center justify-center bg-primary/10 text-primary text-4xl font-medium">
                  {contact.firstName.charAt(0)}
                  {contact.lastName.charAt(0)}
                </div>
              )}
            </div>
            
            <div className="text-center">
              <h2 className="text-2xl font-bold">
                {contact.firstName} {contact.lastName}
              </h2>
              {contact.jobTitle && contact.company && (
                <p className="text-muted-foreground">
                  {contact.jobTitle} at {contact.company}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-2 justify-center">
              {contact.labels.map(labelId => {
                const label = mockLabels.find(l => l.id === labelId);
                if (!label) return null;
                
                return (
                  <Badge 
                    key={label.id} 
                    style={{ backgroundColor: label.color, color: '#fff' }}
                    className="px-2 py-1"
                  >
                    {label.name}
                  </Badge>
                );
              })}
              <Button variant="outline" size="sm" className="h-6 px-2">
                <Plus className="h-3 w-3 mr-1" />
                Add label
              </Button>
            </div>
          </div>
          
          <div className="flex-1 space-y-6">
            {/* Contact Information */}
            <div className="space-y-4">
              <h3 className="text-lg font-semibold border-b pb-2">Contact Information</h3>
              
              {contact.email && contact.email.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Mail className="h-4 w-4" />
                    Email
                  </h4>
                  {contact.email.map((email, index) => (
                    <div key={index} className="pl-6">
                      <a href={`mailto:${email}`} className="text-blue-600 hover:underline">
                        {email}
                      </a>
                    </div>
                  ))}
                </div>
              )}
              
              {contact.phone && contact.phone.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Phone className="h-4 w-4" />
                    Phone
                  </h4>
                  {contact.phone.map((phone, index) => (
                    <div key={index} className="pl-6">
                      <a href={`tel:${phone}`} className="text-blue-600 hover:underline">
                        {formatPhoneNumber(phone)}
                      </a>
                    </div>
                  ))}
                </div>
              )}
              
              {contact.company && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Building className="h-4 w-4" />
                    Company
                  </h4>
                  <div className="pl-6">
                    {contact.company}
                    {contact.jobTitle && ` - ${contact.jobTitle}`}
                  </div>
                </div>
              )}
              
              {contact.birthday && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Calendar className="h-4 w-4" />
                    Birthday
                  </h4>
                  <div className="pl-6">
                    {formatDate(contact.birthday)}
                  </div>
                </div>
              )}
            </div>
            
            {/* Addresses */}
            {contact.address && contact.address.length > 0 && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold border-b pb-2">Addresses</h3>
                
                {contact.address.map((address, index) => (
                  <div key={index} className="space-y-2">
                    <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                      <MapPin className="h-4 w-4" />
                      Address {contact.address && contact.address.length > 1 ? index + 1 : ''}
                    </h4>
                    <div className="pl-6">
                      {formatAddress(address)}
                    </div>
                  </div>
                ))}
              </div>
            )}
            
            {/* Notes */}
            {contact.notes && (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold border-b pb-2">Notes</h3>
                <div className="whitespace-pre-wrap">
                  {contact.notes}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Contact</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete {contact.firstName} {contact.lastName}? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
