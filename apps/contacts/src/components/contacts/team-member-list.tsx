import { EmptyState } from '@workspace/ui';
import { AlphabeticalList, alphaGroupKey } from '@workspace/ui/components/layout/alphabetical-list';
import { UserItem } from '@workspace/ui/components/layout/user-item';
import { useKeyboardListNavigation } from '@workspace/ui/hooks/use-keyboard-list-navigation';
import { cn } from '@workspace/ui/lib/utils';
import { useMemo, useRef } from 'react';

export type TeamMember = { email: string; name: string };

type TeamMemberListProps = {
    members: TeamMember[];
    activeMemberEmail?: string;
    searchQuery: string;
    onRowClick: (email: string) => void;
};

export function TeamMemberList({ members, activeMemberEmail, searchQuery, onRowClick }: TeamMemberListProps) {
    const listRef = useRef<HTMLDivElement>(null);

    const filtered = useMemo(() => {
        let result = [...members].sort((a, b) => a.name.localeCompare(b.name));
        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            result = result.filter((m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q));
        }
        return result;
    }, [members, searchQuery]);

    const { selectedIndex, handleKeyDown } = useKeyboardListNavigation({
        items: filtered,
        activeId: activeMemberEmail,
        getId: (m) => m.email,
        onSelect: onRowClick,
        containerRef: listRef,
    });

    if (members.length === 0) {
        return <EmptyState message="No members in this team" />;
    }

    if (filtered.length === 0) {
        return <EmptyState message="No members found" />;
    }

    return (
        <div className="w-full flex flex-col flex-1 overflow-hidden">
            <div className="flex-1 overflow-y-auto outline-none" tabIndex={0} ref={listRef} onKeyDown={handleKeyDown}>
                <AlphabeticalList
                    items={filtered}
                    getKey={(m) => m.email}
                    getGroupKey={(m) => alphaGroupKey(m.name || m.email)}
                    renderItem={(member, flatIndex) => (
                        <div
                            className={cn(
                                'flex items-center gap-3 px-6 py-3 eigen-list-item',
                                (activeMemberEmail === member.email || selectedIndex === flatIndex) &&
                                    'eigen-list-item-active',
                            )}
                            onClick={() => onRowClick(member.email)}
                        >
                            <UserItem name={member.name} email={member.email} className="flex-1" />
                        </div>
                    )}
                />
            </div>
        </div>
    );
}
