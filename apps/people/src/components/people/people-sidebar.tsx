import {Users, UsersRound, X} from 'lucide-react';
import {Button} from '@workspace/ui/components/button';
import {Separator} from '@workspace/ui/components/separator';
import {SidebarItem} from '@workspace/ui/components/layout/sidebar/sidebar-item';
import {DroppableSidebarItem} from '@workspace/ui/components/layout/sidebar/droppable-sidebar-item';
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {AppLogo} from '@workspace/ui/components/layout/app-logo';
import type {OrgTeam} from '@workspace/lib/types/people';

interface PeopleSidebarProps {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
    teams?: OrgTeam[];
    onAddMembersToTeam?: (memberIds: string[], teamId: string) => void;
}

export function PeopleSidebar({condensed = false, onClose, isMobile = false, teams = [], onAddMembersToTeam}: PeopleSidebarProps) {
    return (
        <div className="h-full flex flex-col bg-background">
            {isMobile && (
                <div className="flex items-center h-12 bg-app px-4">
                    <Button variant="ghost" size="icon" onClick={onClose}
                            className="mr-2 text-white hover:bg-primary/20 hover:text-white">
                        <X className="h-5 w-5"/>
                        <span className="sr-only">Close menu</span>
                    </Button>
                    <AppLogo appName="people"/>
                </div>
            )}

            <div className="overflow-auto flex-1 pt-2">
                <SidebarSection condensed={condensed}>
                    <SidebarItem
                        icon={<Users className="h-4 w-4"/>}
                        label="Members"
                        to="/members"
                        condensed={condensed}
                    />
                    <SidebarItem
                        icon={<UsersRound className="h-4 w-4"/>}
                        label="Teams"
                        to="/teams"
                        condensed={condensed}
                    />
                </SidebarSection>

                {teams.length > 0 && (
                    <>
                        <Separator className="my-2"/>
                        <SidebarSection title="Teams" condensed={condensed}>
                            {teams.map(team => (
                                <DroppableSidebarItem
                                    key={team.id}
                                    icon={<UsersRound className="h-4 w-4"/>}
                                    label={team.name}
                                    to={`/teams?teamId=${team.id}`}
                                    condensed={condensed}
                                    acceptTypes={['member']}
                                    onDrop={(data) => onAddMembersToTeam?.(data.ids, team.id)}
                                />
                            ))}
                        </SidebarSection>
                    </>
                )}
            </div>
        </div>
    );
}
