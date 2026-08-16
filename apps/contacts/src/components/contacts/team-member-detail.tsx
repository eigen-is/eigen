import { ContactDetail } from './contact-detail';
import { PersonDetailToolbar } from './person-detail-toolbar';
import type { TeamMember } from './team-member-list';

// Team members aren't editable contact rows — the shared toolbar hides Edit/Delete.
export function TeamMemberDetailToolbar({ member }: { member: TeamMember }) {
    return <PersonDetailToolbar name={member.name} emails={[member.email]} />;
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
