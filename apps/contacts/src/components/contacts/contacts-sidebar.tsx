import { Link } from '@tanstack/react-router';
import { useLabels } from '@workspace/lib/contacts';
import { useMyTeams } from '@workspace/lib/home';
import type { Label } from '@workspace/lib/types/label';
import { EigenLoader, StorageUsage } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { LabelManager } from '@workspace/ui/components/layout/labels/label-manager';
import { SidebarHeader } from '@workspace/ui/components/layout/sidebar/sidebar-header';
import { SidebarItem } from '@workspace/ui/components/layout/sidebar/sidebar-item';
import { SidebarSection } from '@workspace/ui/components/layout/sidebar/sidebar-section';
import { Separator } from '@workspace/ui/components/separator';
import { UserRoundPlus, Users, UsersRound } from 'lucide-react';

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
        <div className="h-full flex flex-col bg-background">
            {isMobile && <SidebarHeader appName="contacts" onClose={onClose} />}

            <div className="px-3 py-2">
                <Button
                    variant="default"
                    size={condensed ? 'icon' : 'default'}
                    asChild
                    className={`${condensed ? 'w-10 p-0' : 'w-full justify-start gap-3'}`}
                >
                    <Link to="/new">
                        <UserRoundPlus className="h-4 w-4" />
                        {!condensed && <span>Create contact</span>}
                    </Link>
                </Button>
            </div>

            <div className="overflow-auto flex-1">
                <SidebarSection condensed={condensed}>
                    <SidebarItem
                        icon={<UsersRound className="h-4 w-4" />}
                        label="My Contacts"
                        to="/$filterType/$filterId"
                        params={{ filterType: 'book', filterId: 'all' }}
                        condensed={condensed}
                    />
                </SidebarSection>

                <Separator />

                {error ? (
                    <div className="px-3 py-2 text-sm text-destructive">An error occurred while loading labels.</div>
                ) : loading ? (
                    <EigenLoader />
                ) : labels.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-muted-foreground">
                        No labels found. Add one with the + button.
                    </div>
                ) : (
                    <LabelManager
                        labels={labels}
                        getLabelPath={getLabelPath}
                        className="px-3"
                        condensed={condensed}
                        dropAcceptTypes={onAssignLabel ? ['contact'] : undefined}
                        onItemDrop={onAssignLabel}
                    />
                )}

                {myTeams.length > 0 && (
                    <>
                        <Separator />
                        <SidebarSection title={condensed ? undefined : 'Teams'} condensed={condensed}>
                            {myTeams.map((team) => (
                                <SidebarItem
                                    key={team.id}
                                    icon={<Users className="h-4 w-4" />}
                                    label={team.name}
                                    to="/$filterType/$filterId"
                                    params={{ filterType: 'team', filterId: team.id }}
                                    condensed={condensed}
                                />
                            ))}
                        </SidebarSection>
                    </>
                )}
            </div>

            <StorageUsage className="mt-auto" condensed={condensed} />
        </div>
    );
}
