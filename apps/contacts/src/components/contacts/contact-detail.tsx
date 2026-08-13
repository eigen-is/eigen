import { getMailComposeUrl } from '@workspace/lib/api';
import { useLabels } from '@workspace/lib/contacts';
import { formatDate } from '@workspace/lib/date';
import type { Address, Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { Badge } from '@workspace/ui/components/badge';
import { EigenLoader } from '@workspace/ui/components/braket/eigen-loader.tsx';
import { UserDetailHero } from '@workspace/ui/components/user/user-detail-hero';
import { Building, Calendar, Mail, MapPin, Phone } from 'lucide-react';
import { PersonDetailToolbar } from './person-detail-toolbar';

type ContactDetailToolbarProps = {
    contact: Contact;
    filterType?: string;
    filterId?: string;
    onDeleteClick: () => void;
};

export function ContactDetailToolbar({ contact, filterType, filterId, onDeleteClick }: ContactDetailToolbarProps) {
    return (
        <PersonDetailToolbar
            name={`${contact.firstName} ${contact.lastName}`.trim()}
            emails={contact.email ?? []}
            editSearch={{ filterType: filterType || 'filter', filterId: filterId || 'all', contactId: contact.id }}
            onDeleteClick={onDeleteClick}
        />
    );
}

type ContactDetailProps = {
    contact: Contact;
};

export function ContactDetail({ contact }: ContactDetailProps) {
    const { data: labels = [], isLoading: labelsLoading, error: labelsError } = useLabels();

    const formatAddress = (address: Address) => {
        if (!address) return '';

        const parts = [address.street, address.city, address.state, address.zipCode, address.country].filter(Boolean);

        return parts.join(', ');
    };

    const contactLabels = contact.labels ? labels.filter((label) => contact.labels?.includes(label.id)) : [];

    return (
        <div className="h-full flex flex-col overflow-hidden" data-document="contact-detail">
            <div className="flex-1 overflow-auto app-gutter">
                <div className="flex flex-col md:flex-row gap-8">
                    <UserDetailHero
                        layout="profile"
                        name={`${contact.firstName} ${contact.lastName}`}
                        email={contact.email?.[0]}
                        imageUrl={contact.avatar}
                        subtitle={
                            contact.jobTitle && contact.company
                                ? `${contact.jobTitle} at ${contact.company}`
                                : undefined
                        }
                        badges={
                            contactLabels && contactLabels.length > 0 && !labelsLoading && !labelsError ? (
                                contactLabels.map((label: Label) => (
                                    <Badge
                                        key={label.id}
                                        style={{ backgroundColor: label.color }}
                                        className="px-2 py-1 text-primary-foreground"
                                    >
                                        {label.name}
                                    </Badge>
                                ))
                            ) : labelsLoading ? (
                                <EigenLoader />
                            ) : labelsError ? (
                                <p className="text-sm text-destructive">Error loading labels</p>
                            ) : null
                        }
                    />

                    <div className="flex-1 space-y-6">
                        <div className="space-y-4">
                            <h3 className="text-lg font-medium border-b pb-2">Contact Information</h3>

                            {contact.email && contact.email.length > 0 && (
                                <div className="space-y-2">
                                    <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                        <Mail className="h-4 w-4" />
                                        Email
                                    </h4>
                                    {contact.email.map((email: string, index: number) => (
                                        <div key={index} className="pl-6">
                                            <a className="text-primary hover:underline" href={getMailComposeUrl(email)}>
                                                {email}
                                            </a>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {contact.phone && contact.phone.length > 0 && contact.phone[0].length > 0 && (
                                <div className="space-y-2">
                                    <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                        <Phone className="h-4 w-4" />
                                        Phone
                                    </h4>
                                    {contact.phone.map((phone: string, index: number) => (
                                        <div key={index} className="pl-6">
                                            <a href={`tel:${phone}`} className="text-primary hover:underline">
                                                {phone}
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

                            {Boolean(contact.birthday) && (
                                <div className="space-y-2">
                                    <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                        <Calendar className="h-4 w-4" />
                                        Birthday
                                    </h4>
                                    <div className="pl-6">{formatDate(contact.birthday!)}</div>
                                </div>
                            )}
                        </div>

                        {contact.address &&
                            contact.address.length > 0 &&
                            Object.keys(contact.address[0]).length > 0 && (
                                <div className="space-y-4">
                                    <h3 className="text-lg font-medium border-b pb-2">Addresses</h3>

                                    {contact.address.map((address: Address, index: number) => (
                                        <div key={index} className="space-y-2">
                                            <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                                <MapPin className="h-4 w-4" />
                                                Address {contact.address && contact.address.length > 1 ? index + 1 : ''}
                                            </h4>
                                            <div className="pl-6">{formatAddress(address)}</div>
                                        </div>
                                    ))}
                                </div>
                            )}

                        {contact.notes && (
                            <div className="space-y-4">
                                <h3 className="text-lg font-medium border-b pb-2">Notes</h3>
                                <div className="whitespace-pre-wrap">{contact.notes}</div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
