// One contact shown as a card: name, job title, company, emails, phone numbers, addresses, birthday and
// notes. Views such as Contacts' detail and the .vcf preview show it.

import { getMailComposeUrl } from '@workspace/lib/api';
import { readableTextColor } from '@workspace/lib/constants/colors';
import { formatDateOnly } from '@workspace/lib/date';
import { useMailEnabled } from '@workspace/lib/public';
import type { Address, Contact } from '@workspace/lib/types/contact';
import { contactFullName } from '@workspace/lib/types/contact';
import { cn } from '@workspace/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';
import { Building, Calendar, Mail, MapPin, Phone } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '../badge';
import { DetailSection } from '../layout/app/detail-item';
import { UserDetailHero } from './user-detail-hero';

export type ContactDetailCardProps = {
    contact: Contact;
    labels: { name: string; color?: string }[];
    className?: string;
};

export function ContactDetailCard({ contact, labels, className }: ContactDetailCardProps) {
    const addresses = contact.address ?? [];
    const mailEnabled = useMailEnabled();

    return (
        <div className={cn('flex flex-col md:flex-row gap-8', className)}>
            <UserDetailHero
                layout="profile"
                name={contactFullName(contact)}
                email={contact.email[0]}
                imageUrl={contact.avatar}
                subtitle={
                    contact.company && contact.jobTitle ? `${contact.jobTitle} at ${contact.company}` : contact.jobTitle
                }
                badges={
                    labels.length > 0
                        ? labels.map((label, index) => (
                              <Badge
                                  key={index}
                                  style={
                                      label.color
                                          ? { backgroundColor: label.color, color: readableTextColor(label.color) }
                                          : undefined
                                  }
                                  className="px-2 py-1"
                              >
                                  {label.name}
                              </Badge>
                          ))
                        : null
                }
            />

            <div className="flex-1">
                <DetailSection label="Contact information">
                    <div className="space-y-4">
                        {contact.email.length > 0 && (
                            <Field icon={Mail} label="Email">
                                {contact.email.map((email, index) => (
                                    <div key={index}>
                                        {mailEnabled ? (
                                            <a className="text-primary hover:underline" href={getMailComposeUrl(email)}>
                                                {email}
                                            </a>
                                        ) : (
                                            email
                                        )}
                                    </div>
                                ))}
                            </Field>
                        )}

                        {contact.phone.length > 0 && contact.phone[0].length > 0 && (
                            <Field icon={Phone} label="Phone">
                                {contact.phone.map((phone, index) => (
                                    <div key={index}>
                                        <a href={`tel:${phone}`} className="text-primary hover:underline">
                                            {phone}
                                        </a>
                                    </div>
                                ))}
                            </Field>
                        )}

                        {contact.company && (
                            <Field icon={Building} label="Company">
                                {contact.company}
                                {contact.jobTitle && ` - ${contact.jobTitle}`}
                            </Field>
                        )}

                        {contact.birthday && (
                            <Field icon={Calendar} label="Birthday">
                                {formatDateOnly(contact.birthday)}
                            </Field>
                        )}
                    </div>
                </DetailSection>

                {addresses.length > 0 && Object.keys(addresses[0]).length > 0 && (
                    <DetailSection label="Addresses">
                        <div className="space-y-4">
                            {addresses.map((address, index) => (
                                <Field
                                    key={index}
                                    icon={MapPin}
                                    label={addresses.length > 1 ? `Address ${index + 1}` : 'Address'}
                                >
                                    {formatAddress(address)}
                                </Field>
                            ))}
                        </div>
                    </DetailSection>
                )}

                {contact.notes && (
                    <DetailSection label="Notes">
                        <div className="whitespace-pre-wrap">{contact.notes}</div>
                    </DetailSection>
                )}
            </div>
        </div>
    );
}

function Field({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
    return (
        <div className="space-y-2">
            <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <Icon className="h-4 w-4" />
                {label}
            </h4>
            <div className="space-y-2 pl-6">{children}</div>
        </div>
    );
}

function formatAddress(address: Address) {
    return [address.street, address.city, address.state, address.zipCode, address.country].filter(Boolean).join(', ');
}
