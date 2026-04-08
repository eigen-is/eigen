import { EmptyState } from '@workspace/ui';
import { UserItem } from '@workspace/ui/components/layout/user-item';
import { Toolbar } from '@workspace/ui/index';
import { cn } from '@workspace/ui/lib/utils';
import { useMemo } from 'react';

type TeamMember = { email: string; name: string };

type TeamMemberListToolbarProps = {
    teamName: string;
};

export function TeamMemberListToolbar({ teamName }: TeamMemberListToolbarProps) {
    return (
        <Toolbar>
            <span className="text-sm text-foreground font-normal truncate">{teamName}</span>
        </Toolbar>
    );
}

type TeamMemberListProps = {
    members: TeamMember[];
    activeMemberEmail?: string;
    onRowClick: (email: string) => void;
};

export function TeamMemberList({ members, activeMemberEmail, onRowClick }: TeamMemberListProps) {
    const grouped = useMemo(() => {
        const groups: Record<string, TeamMember[]> = {};
        for (const member of members) {
            const firstChar = (member.name || member.email).charAt(0).toUpperCase();
            const key = /[A-Z]/.test(firstChar) ? firstChar : '#';
            if (!groups[key]) groups[key] = [];
            groups[key].push(member);
        }
        return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
    }, [members]);

    if (members.length === 0) {
        return <EmptyState message="No members in this team" />;
    }

    return (
        <div className="flex flex-col">
            {grouped.map(([letter, group]) => (
                <div key={letter}>
                    <div className="px-4 py-1 text-xs font-semibold text-muted-foreground sticky top-0 bg-background z-10">
                        {letter}
                    </div>
                    {group.map((member) => (
                        <div
                            key={member.email}
                            className={cn(
                                'px-2 py-1 cursor-pointer rounded-md mx-1',
                                activeMemberEmail === member.email && 'bg-accent',
                            )}
                            onClick={() => onRowClick(member.email)}
                        >
                            <UserItem name={member.name} email={member.email} />
                        </div>
                    ))}
                </div>
            ))}
        </div>
    );
}
