import {useState} from 'react';
import {ArrowLeft, Building, Calendar, Edit, Mail, MapPin, MoreVertical, Phone, Trash2} from 'lucide-react';
import {type Contact} from "@apps/api-server/types/contact";
import {Button} from "@workspace/ui/components/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {Badge} from "@workspace/ui/components/badge";
import {Link} from '@tanstack/react-router';
import {DeleteDialog} from "@workspace/ui/components/layout/delete/delete-dialog";
import {useLabels} from '@/hooks/use-labels.ts';
import {TooltipButton, UserAvatar} from "@workspace/ui";
import {EigenLoader} from '@workspace/ui/components/layout/eigen-loader';

interface ContactDetailProps {
    contact: Contact;
    onDelete: (id: string) => void;
    onBack?: () => void;
    filterType?: string;
    filterId?: string;
    isMobile?: boolean;
}

export function ContactDetail({contact, onDelete, onBack, filterType, filterId, isMobile}: ContactDetailProps) {
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

    // Use TanStack Query hook only for fetching labels
    const {
        data: labels = [],
        isLoading: labelsLoading,
        error: labelsError
    } = useLabels();

    const handleDelete = () => {
        onDelete(contact.id);
        setDeleteDialogOpen(false);
    };

    const formatPhoneNumber = (phone: string) => {
        return phone; // You might want to add formatting logic here
    };

    const formatAddress = (address: any) => {
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

    // Get contact's label objects
    const contactLabels = contact.labels
        ? labels.filter(label => contact.labels?.includes(label.id))
        : [];

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="flex items-center justify-between h-12 px-4 border-b">
                <div className="flex items-center">
                    {isMobile && onBack && (
                        <>
                            <Button variant="ghost" size="icon" className="h-8 w-8 mr-1" onClick={onBack}
                                    title="Back">
                                <ArrowLeft className="h-4 w-4"/>
                            </Button>
                            <div className="h-6 w-[1px] bg-border mx-1"></div>
                        </>
                    )}
                </div>
                <div className="flex items-center">
                    <div className="flex items-center gap-1 mr-2">
                        <Link
                            to="/edit/$filterType/$filterId"
                            params={{
                                filterType: filterType || 'filter',
                                filterId: filterId || 'all'
                            }}
                            search={{
                                contactId: contact.id
                            }}
                        >
                            <TooltipButton
                                icon={Edit}
                                tooltipText="Edit"
                                className="h-8 w-8"
                            />
                        </Link>
                        <TooltipButton
                            icon={Trash2}
                            tooltipText="Delete"
                            onClick={() => setDeleteDialogOpen(true)}
                        />
                    </div>

                    <div className="h-6 w-[1px] bg-border mx-1"></div>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreVertical className="h-4 w-4"/>
                                <span className="sr-only">More</span>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem>Send email</DropdownMenuItem>
                            <DropdownMenuItem>Schedule meeting</DropdownMenuItem>
                            <DropdownMenuSeparator/>
                            <DropdownMenuItem>Print</DropdownMenuItem>
                            <DropdownMenuItem>Export as vCard</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            <div className="flex-1 overflow-auto p-6">
                <div className="flex flex-col md:flex-row gap-8">
                    <div className="flex flex-col items-center gap-4 w-50">
                        <div className="h-40 w-40">
                            <UserAvatar
                                name={`${contact.firstName} ${contact.lastName}`}
                                email={contact.email?.[0]}
                                imageUrl={contact.avatar}
                                className="h-full w-full"
                                size="lg"
                            />
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
                            {contactLabels && contactLabels.length > 0 && !labelsLoading && !labelsError ? (
                                contactLabels.map((label: any) => (
                                    <Badge
                                        key={label.id}
                                        style={{backgroundColor: label.color, color: '#fff'}}
                                        className="px-2 py-1"
                                    >
                                        {label.name}
                                    </Badge>
                                ))
                            ) : labelsLoading ? (<EigenLoader />) : labelsError ? (
                                <p className="text-sm text-destructive">Error loading labels</p>
                            ) : null}
                        </div>
                    </div>

                    <div className="flex-1 space-y-6">
                        {/* Contact Information */}
                        <div className="space-y-4">
                            <h3 className="text-lg font-semibold border-b pb-2">Contact Information</h3>

                            {contact.email && contact.email.length > 0 && (
                                <div className="space-y-2">
                                    <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                        <Mail className="h-4 w-4"/>
                                        Email
                                    </h4>
                                    {contact.email.map((email: string, index: number) => (
                                        <div key={index} className="pl-6">
                                            <a href={`mailto:${email}`} className="text-blue-600 hover:underline">
                                                {email}
                                            </a>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {contact.phone && contact.phone.length > 0 && contact.phone[0].length > 0&& (
                                <div className="space-y-2">
                                    <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                        <Phone className="h-4 w-4"/>
                                        Phone
                                    </h4>
                                    {contact.phone.map((phone: string, index: number) => (
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
                                        <Building className="h-4 w-4"/>
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
                                        <Calendar className="h-4 w-4"/>
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

                                {contact.address.map((address: any, index: number) => (
                                    <div key={index} className="space-y-2">
                                        <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                            <MapPin className="h-4 w-4"/>
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
            <DeleteDialog
                open={deleteDialogOpen}
                onOpenChange={setDeleteDialogOpen}
                title="Delete Contact"
                description="Are you sure you want to delete"
                itemName={`${contact.firstName} ${contact.lastName}`}
                onDelete={handleDelete}
            />
        </div>
    );
}
