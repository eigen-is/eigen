import { Link } from '@tanstack/react-router';
import { useLabels } from '@workspace/lib/contacts';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import type { Label } from '@workspace/lib/types/label';
import { SidebarItem, StorageUsage, UserAvatar } from '@workspace/ui';
import { LabelManager } from '@workspace/ui/components/labels/label-manager';
import { SidebarBody } from '@workspace/ui/components/layout/sidebar/sidebar-body';
import { SidebarPrimaryButton } from '@workspace/ui/components/layout/sidebar/sidebar-primary-button';
import { SidebarSection } from '@workspace/ui/components/layout/sidebar/sidebar-section';
import { UserRoundPlus, UsersRound } from 'lucide-react';

type ContactsSidebarProps = {
    condensed?: boolean;
    onAssignLabel?: (contactIds: string[], labelId: string) => void;
};

export function ContactsSidebar({ condensed = false, onAssignLabel }: ContactsSidebarProps) {
    const { data: labels = [], isLoading: loading, error } = useLabels();
    const { data: myTeams = [] } = useMyTeams();

    const getLabelPath = (label: Label) => `/label/${label.id.toLowerCase()}`;

    return (
        <SidebarBody>
            <SidebarPrimaryButton
                icon={UserRoundPlus}
                label="Create contact"
                condensed={condensed}
                renderTrigger={(content) => <Link to="/new">{content}</Link>}
            />

            <div className="overflow-auto flex-1">
                <SidebarSection condensed={condensed}>
                    <SidebarItem
                        icon={<UsersRound className="h-4 w-4" />}
                        label="My Contacts"
                        to="/$filterType/$filterId"
                        params={{ filterType: 'book', filterId: 'all' }}
                        condensed={condensed}
                    />
                    {myTeams.map((team) => (
                        <SidebarItem
                            key={team.id}
                            icon={<UserAvatar email={teamOwnerId(team.id)} className="h-4 w-4" />}
                            label={team.name}
                            to="/$filterType/$filterId"
                            params={{ filterType: 'team', filterId: team.id }}
                            condensed={condensed}
                        />
                    ))}
                </SidebarSection>

                {loading ? (
                    <SidebarSection condensed={condensed} loading />
                ) : error ? (
                    <SidebarSection condensed={condensed} error="An error occurred while loading labels." />
                ) : labels.length === 0 ? (
                    <SidebarSection condensed={condensed} empty="No labels found. Add one with the + button." />
                ) : (
                    <LabelManager
                        labels={labels}
                        getLabelPath={getLabelPath}
                        condensed={condensed}
                        dropAcceptTypes={onAssignLabel ? ['contact'] : undefined}
                        onItemDrop={onAssignLabel}
                    />
                )}
            </div>

            <StorageUsage className="mt-auto" condensed={condensed} />
        </SidebarBody>
    );
}
