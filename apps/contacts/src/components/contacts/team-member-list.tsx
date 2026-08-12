import { EmptyState } from '@workspace/ui';
import { PersonList } from '@workspace/ui/components/layout/person-list';
import { UserItem } from '@workspace/ui/components/layout/user-item';

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
