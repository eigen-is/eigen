import { useContacts } from '@workspace/lib/contacts';
import { UserItem } from '@workspace/ui/components/user/user-item';

export function InspectCard({ target }: { target: string }) {
    const { data: contacts = [] } = useContacts();
    const contact = contacts.find((c) => c.email?.some((e) => e.toLowerCase() === target.toLowerCase()));

    return (
        <div className="flex gap-4 p-4 rounded-lg border bg-card max-w-sm">
            <div className="shrink-0">
                <UserItem email={target} mailLink={true} />
            </div>
            <div className="flex-1 min-w-0 space-y-1">
                {contact?.company && (
                    <p className="text-xs text-muted-foreground">
                        {contact.jobTitle ? `${contact.jobTitle} at ` : ''}
                        {contact.company}
                    </p>
                )}
                {contact?.phone && contact.phone.length > 0 && contact.phone[0] && (
                    <p className="text-xs text-muted-foreground">{contact.phone[0]}</p>
                )}
            </div>
        </div>
    );
}
