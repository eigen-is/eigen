import { EmptyState } from '@workspace/ui';
import { UserItem } from '@workspace/ui/components/layout/user-item';
import { cn } from '@workspace/ui/lib/utils';
import { useMemo } from 'react';

export type TeamMember = { email: string; name: string };

type TeamMemberListProps = {
    members: TeamMember[];
    activeMemberEmail?: string;
    searchQuery: string;
    sortBy: 'firstName' | 'lastName';
    onRowClick: (email: string) => void;
};

export function TeamMemberList({ members, activeMemberEmail, searchQuery, sortBy, onRowClick }: TeamMemberListProps) {
    const filtered = useMemo(() => {
        let result = [...members].sort((a, b) => a.name.localeCompare(b.name));
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            result = result.filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
        }
        return result;
    }, [members, searchQuery]);

    const grouped = useMemo(() => {
        const groups: Record<string, TeamMember[]> = {};
        for (const member of filtered) {
            const firstChar = (member.name || member.email).charAt(0).toUpperCase();
            const key = /[A-Z]/.test(firstChar) ? firstChar : '#';
            if (!groups[key]) groups[key] = [];
            groups[key].push(member);
        }
        return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));
    }, [filtered]);

    if (members.length === 0) {
        return <EmptyState message="No members in this team" />;
    }

    if (filtered.length === 0) {
        return <EmptyState message="No members found" />;
    }

    return (
        <div className="w-full flex flex-col flex-1 overflow-hidden">
            <div className="flex-1 overflow-y-auto">
                {grouped.map(([letter, group]) => (
                    <div key={letter} className="border-b last:border-b-0">
                        <div className="flex items-center px-6 py-2 bg-muted/50">
                            <h2 className="text-sm font-semibold">{letter}</h2>
                        </div>
                        <div>
                            {group.map((member) => (
                                <div
                                    key={member.email}
                                    className={cn(
                                        'flex items-center gap-3 px-6 py-3 eigen-list-item',
                                        activeMemberEmail === member.email && 'eigen-list-item-active',
                                    )}
                                    onClick={() => onRowClick(member.email)}
                                >
                                    <UserItem name={member.name} email={member.email} className="flex-1" />
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
