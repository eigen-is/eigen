// One team's members as the contacts page's list, by name and email. A member is the name and email the team
// holds, not a contact card, so the rows have no menu and can't be dragged. A click opens the member's detail.

import { EmptyState } from '@workspace/ui/components/layout/app';
import { PersonList, UserItem } from '@workspace/ui/components/user';

export type TeamMember = { email: string; name: string };

type TeamMemberListProps = {
    members: TeamMember[];
    activeMemberEmail?: string;
    searchQuery: string;
    onRowClick: (email: string) => void;
};

export function TeamMemberList({ members, activeMemberEmail, searchQuery, onRowClick }: TeamMemberListProps) {
    return (
        <PersonList
            items={members}
            searchQuery={searchQuery}
            activeId={activeMemberEmail}
            getId={(m) => m.email}
            getName={(m) => m.name || m.email}
            getSearchFields={(m) => [m.name, m.email]}
            onRowClick={onRowClick}
            emptyState={<EmptyState message={members.length === 0 ? 'No members in this team' : 'No members found'} />}
            renderPerson={(member) => <UserItem name={member.name} email={member.email} className="flex-1" />}
        />
    );
}
