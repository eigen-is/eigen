import { Link } from '@tanstack/react-router';
import { useLabels } from '@workspace/lib/contacts';
import { useMyTeams } from '@workspace/lib/home';
import { teamOwnerId } from '@workspace/lib/types';
import type { Label } from '@workspace/lib/types/label';
import { EigenLoader, SidebarItem, StorageUsage, UserAvatar } from '@workspace/ui';
import { LabelManager } from '@workspace/ui/components/layout/labels/label-manager';
import { SidebarHeader } from '@workspace/ui/components/layout/sidebar/sidebar-header';
import { SidebarPrimaryButton } from '@workspace/ui/components/layout/sidebar/sidebar-primary-button';
import { SidebarSection } from '@workspace/ui/components/layout/sidebar/sidebar-section';
import { UserRoundPlus, UsersRound } from 'lucide-react';

type ContactsSidebarProps = {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
    onAssignLabel?: (contactIds: string[], labelId: string) => void;
};

export function ContactsSidebar({ condensed = false, onClose, isMobile = false, onAssignLabel }: ContactsSidebarProps) {
    const { data: labels = [], isLoading: loading, error } = useLabels();
    const { data: myTeams = [] } = useMyTeams();

    const getLabelPath = (label: Label) => `/label/${label.id.toLowerCase()}`;

    return (
        <div className="h-full flex flex-col">
            {isMobile && <SidebarHeader appName="contacts" onClose={onClose} />}

            <div className="flex flex-1 flex-col app-gutter">
                <SidebarPrimaryButton
                    icon={UserRoundPlus}
                    label="Create contact"
                    condensed={condensed}
                    renderTrigger={(content) => <Link to="/new">{content}</Link>}
                />

                <div className="overflow-auto flex-1">
                    <SidebarSection condensed={condensed} className="px-0">
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

                    {error ? (
                        <div className="py-2 text-sm text-destructive">An error occurred while loading labels.</div>
                    ) : loading ? (
                        <EigenLoader />
                    ) : labels.length === 0 ? (
                        <div className="py-2 text-sm text-muted-foreground">
                            No labels found. Add one with the + button.
                        </div>
                    ) : (
                        <LabelManager
                            labels={labels}
                            getLabelPath={getLabelPath}
                            className="px-0"
                            condensed={condensed}
                            dropAcceptTypes={onAssignLabel ? ['contact'] : undefined}
                            onItemDrop={onAssignLabel}
                        />
                    )}
                </div>

                <StorageUsage className="mt-auto px-0" condensed={condensed} />
            </div>
        </div>
    );
}
