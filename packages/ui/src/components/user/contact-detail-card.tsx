import { getMailComposeUrl } from '@workspace/lib/api';
import { formatContactAddress, formatContactCompany, formatContactRole } from '@workspace/lib/contacts';
import { formatDateOnly } from '@workspace/lib/date';
import type { Contact } from '@workspace/lib/types/contact';
import { cn } from '@workspace/ui/lib/utils';
import { Building, Calendar, Mail, MapPin, Phone } from 'lucide-react';
import { Badge } from '../badge';
import { UserDetailHero } from './user-detail-hero';

export type ContactDetailCardProps = {
    contact: Contact;
    labels: { name: string; color?: string }[];
    className?: string;
};

// Shows the same fields as the server-rendered vCard preview (apps/api/src/lib/preview/vcard-render.ts):
// a stored contact and a previewed card must read alike, so the two stay in sync.
export function ContactDetailCard({ contact, labels, className }: ContactDetailCardProps) {
    const addresses = contact.address ?? [];

    return (
        <div className={cn('flex flex-col md:flex-row gap-8', className)}>
            <UserDetailHero
                layout="profile"
                name={`${contact.firstName} ${contact.lastName}`}
                email={contact.email[0]}
                imageUrl={contact.avatar}
                subtitle={formatContactRole(contact) || undefined}
                badges={
                    labels.length > 0
                        ? labels.map((label, index) => (
                              <Badge
                                  key={index}
                                  style={{ backgroundColor: label.color }}
                                  className="px-2 py-1 text-primary-foreground"
                              >
                                  {label.name}
                              </Badge>
                          ))
                        : null
                }
            />

            <div className="flex-1 space-y-6">
                <div className="space-y-4">
                    <h3 className="text-lg font-medium border-b pb-2">Contact Information</h3>

                    {contact.email.length > 0 && (
                        <div className="space-y-2">
                            <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                <Mail className="h-4 w-4" />
                                Email
                            </h4>
                            {contact.email.map((email, index) => (
                                <div key={index} className="pl-6">
                                    <a className="text-primary hover:underline" href={getMailComposeUrl(email)}>
                                        {email}
                                    </a>
                                </div>
                            ))}
                        </div>
                    )}

                    {contact.phone.length > 0 && contact.phone[0].length > 0 && (
                        <div className="space-y-2">
                            <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                <Phone className="h-4 w-4" />
                                Phone
                            </h4>
                            {contact.phone.map((phone, index) => (
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
                            <div className="pl-6">{formatContactCompany(contact)}</div>
                        </div>
                    )}

                    {contact.birthday && (
                        <div className="space-y-2">
                            <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                <Calendar className="h-4 w-4" />
                                Birthday
                            </h4>
                            <div className="pl-6">{formatDateOnly(contact.birthday)}</div>
                        </div>
                    )}
                </div>

                {addresses.length > 0 && Object.keys(addresses[0]).length > 0 && (
                    <div className="space-y-4">
                        <h3 className="text-lg font-medium border-b pb-2">Addresses</h3>

                        {addresses.map((address, index) => (
                            <div key={index} className="space-y-2">
                                <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                                    <MapPin className="h-4 w-4" />
                                    Address {addresses.length > 1 ? index + 1 : ''}
                                </h4>
                                <div className="pl-6">{formatContactAddress(address)}</div>
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
    );
}
