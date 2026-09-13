import { useLabels } from '@workspace/lib/contacts';
import type { Contact } from '@workspace/lib/types/contact';
import type { Label } from '@workspace/lib/types/label';
import { ContactDetailCard } from '@workspace/ui/components/user';
import { PersonDetailToolbar } from './person-detail-toolbar';

type ContactDetailToolbarProps = {
    contact: Contact;
    filterType?: string;
    filterId?: string;
    labels?: Label[];
    onToggleLabel?: (contacts: Contact[], labelId: string) => void;
    onDeleteClick: () => void;
};

export function ContactDetailToolbar({
    contact,
    filterType,
    filterId,
    labels,
    onToggleLabel,
    onDeleteClick,
}: ContactDetailToolbarProps) {
    return (
        <PersonDetailToolbar
            contact={contact}
            editSearch={{ filterType: filterType || 'filter', filterId: filterId || 'all', contactId: contact.id }}
            labels={labels}
            onToggleLabel={onToggleLabel}
            onDeleteClick={onDeleteClick}
        />
    );
}

type ContactDetailProps = {
    contact: Contact;
};

export function ContactDetail({ contact }: ContactDetailProps) {
    const { data: labels = [] } = useLabels();

    const contactLabels = contact.labels ? labels.filter((label) => contact.labels?.includes(label.id)) : [];

    return (
        <div className="h-full flex flex-col overflow-hidden" data-document="contact-detail">
            <div className="flex-1 overflow-auto app-gutter">
                <ContactDetailCard contact={contact} labels={contactLabels} />
            </div>
        </div>
    );
}
