import {Users, UsersRound, X, PlusIcon} from 'lucide-react';
import {Button} from '@workspace/ui/components/button';
import {Separator} from '@workspace/ui/components/separator';
import {SidebarItem} from '@workspace/ui/components/layout/sidebar/sidebar-item';
import {DroppableSidebarItem} from '@workspace/ui/components/layout/sidebar/droppable-sidebar-item';
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {AppLogo} from '@workspace/ui/components/layout/app-logo';
import type {OrgTeam} from '@workspace/lib/types/people';
import {teamOwnerId} from "@workspace/lib/types";
import {UserAvatar} from "@workspace/ui/components/layout/user-avatar";
import {TooltipButton} from "@workspace/ui/components/layout/tooltip-button/tooltip-button";
import {useState} from 'react';
import {Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {Input} from '@workspace/ui/components/input';
import {useCreateTeam} from '@workspace/lib/people';
import {usePublicConfig} from '@workspace/lib/public';
import {toast} from 'sonner';

interface PeopleSidebarProps {
    condensed?: boolean;
    onClose?: () => void;
    isMobile?: boolean;
    teams?: OrgTeam[];
    onAddMembersToTeam?: (memberIds: string[], teamId: string) => void;
}

export function PeopleSidebar({
                                  condensed = false,
                                  onClose,
                                  isMobile = false,
                                  teams = [],
                                  onAddMembersToTeam
                              }: PeopleSidebarProps) {
    const {data: config} = usePublicConfig();
    const [showCreate, setShowCreate] = useState(false);
    const [newTeamName, setNewTeamName] = useState('');
    const createTeam = useCreateTeam(config?.orgId);

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newTeamName.trim()) return;
        try {
            await createTeam.mutateAsync(newTeamName.trim());
            toast.success(`Team "${newTeamName.trim()}" created`);
            setNewTeamName('');
            setShowCreate(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to create team');
        }
    };

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

                <Separator className="my-2"/>
                <div className="px-3 py-2">
                    <div className={`flex items-center mb-2 ${condensed ? "justify-center" : "justify-between"}`}>
                        {!condensed && <h3 className="text-sm font-semibold text-foreground px-3 select-none">Teams</h3>}
                        <div className="flex items-center gap-1">
                            <TooltipButton
                                icon={PlusIcon}
                                tooltipText="Create Team"
                                onClick={() => setShowCreate(true)}
                            />
                        </div>
                    </div>
                    {teams.length > 0 && (
                        <div className="space-y-1">
                            {teams.map(team => (
                                <DroppableSidebarItem
                                    key={team.id}
                                    icon={<UserAvatar userId={teamOwnerId(team.id)}/>}
                                    label={team.name}
                                    to={`/teams?teamId=${team.id}`}
                                    condensed={condensed}
                                    acceptTypes={['member']}
                                    onDrop={(data) => onAddMembersToTeam?.(data.ids, team.id)}
                                />
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <Dialog open={showCreate} onOpenChange={setShowCreate}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Create Team</DialogTitle>
                    </DialogHeader>
                    <form onSubmit={handleCreate} className="space-y-4">
                        <Input
                            placeholder="Team name"
                            value={newTeamName}
                            onChange={e => setNewTeamName(e.target.value)}
                            autoFocus
                            required
                        />
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
                            <Button type="submit" disabled={createTeam.isPending}>
                                {createTeam.isPending ? 'Creating...' : 'Create'}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </div>
    );
}
