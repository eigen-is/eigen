import { ContactDetail } from './contact-detail';
import { PersonDetailToolbar } from './person-detail-toolbar';
import type { TeamMember } from './team-member-list';

// Team members aren't editable contact rows — no editSearch/onDeleteClick/labels, so the shared
// toolbar keeps only Send email / Start chat / Print. A member is not a stored card, so id/etag
// are stand-ins the menu never reads (same synthetic card TeamMemberDetail renders).
export function TeamMemberDetailToolbar({ member }: { member: TeamMember }) {
    return (
        <PersonDetailToolbar
            contact={{
                id: member.email,
                etag: '',
                firstName: member.name,
                lastName: '',
                email: [member.email],
                phone: [],
            }}
        />
    );
}

type TeamMemberDetailProps = {
    member: TeamMember;
};

export function TeamMemberDetail({ member }: TeamMemberDetailProps) {
    // A team member is a person with one known address — render the shared contact detail
    // instead of duplicating its sections. A member is not a stored card, so the id and etag
    // are stand-ins — this pane reads neither.
    return (
        <ContactDetail
            contact={{
                id: member.email,
                etag: '',
                firstName: member.name,
                lastName: '',
                email: [member.email],
                phone: [],
            }}
        />
    );
}
