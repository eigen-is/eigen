import { useCreateTeam } from '@workspace/lib/admin';
import { usePublicConfig } from '@workspace/lib/public';
import { teamOwnerId } from '@workspace/lib/types';
import type { OrgTeam } from '@workspace/lib/types/admin';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { DroppableSidebarItem } from '@workspace/ui/components/layout/sidebar/droppable-sidebar-item';
import { SidebarBody } from '@workspace/ui/components/layout/sidebar/sidebar-body';
import { SidebarItem } from '@workspace/ui/components/layout/sidebar/sidebar-item';
import { SidebarSection } from '@workspace/ui/components/layout/sidebar/sidebar-section';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button.tsx';
import { UserAvatar } from '@workspace/ui/components/user/user-avatar';
import {
    ClipboardList,
    KeyRound,
    Plus,
    Settings,
    UserMinus,
    UserPlus,
    UserRoundCheck,
    Users,
    UsersRound,
} from 'lucide-react';
import { useState } from 'react';

type AdminSidebarProps = {
    condensed?: boolean;
    teams?: OrgTeam[];
    isOwner?: boolean;
    waitlistEnabled?: boolean;
    onAddMembersToTeam?: (memberIds: string[], teamId: string) => void;
};

export function AdminSidebar({
    condensed = false,
    teams = [],
    isOwner = false,
    waitlistEnabled = false,
    onAddMembersToTeam,
}: AdminSidebarProps) {
    const { data: config } = usePublicConfig();
    const [showCreate, setShowCreate] = useState(false);
    const [newTeamName, setNewTeamName] = useState('');
    const createTeam = useCreateTeam(config?.orgId);

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newTeamName.trim()) return;
        await createTeam.mutateAsync(newTeamName.trim());
        setNewTeamName('');
        setShowCreate(false);
    };

    return (
        <>
            <SidebarBody>
                <SidebarSection condensed={condensed}>
                    {isOwner && (
                        <>
                            <SidebarItem
                                icon={<Settings className="h-4 w-4" />}
                                label="Settings"
                                to="/settings"
                                condensed={condensed}
                            />
                            <SidebarItem
                                icon={<ClipboardList className="h-4 w-4" />}
                                label="Onboarding"
                                to="/onboarding"
                                condensed={condensed}
                            />
                            <SidebarItem
                                icon={<KeyRound className="h-4 w-4" />}
                                label="Guest access"
                                to="/guest-settings"
                                condensed={condensed}
                            />
                        </>
                    )}
                    {isOwner && waitlistEnabled && (
                        <SidebarItem
                            icon={<UserPlus className="h-4 w-4" />}
                            label="Waitlist"
                            to="/waitlist"
                            condensed={condensed}
                        />
                    )}
                    <SidebarItem
                        icon={<Users className="h-4 w-4" />}
                        label="Members"
                        to="/members"
                        condensed={condensed}
                    />
                    <SidebarItem
                        icon={<UsersRound className="h-4 w-4" />}
                        label="Teams"
                        to="/teams"
                        condensed={condensed}
                    />
                    <SidebarItem
                        icon={<UserRoundCheck className="h-4 w-4" />}
                        label="Guests"
                        to="/guests"
                        condensed={condensed}
                    />
                    <SidebarItem
                        icon={<UserMinus className="h-4 w-4" />}
                        label="Orphans"
                        to="/orphans"
                        condensed={condensed}
                    />
                </SidebarSection>

                <SidebarSection
                    condensed={condensed}
                    title="Teams"
                    action={<TooltipButton icon={Plus} tooltipText="Create Team" onClick={() => setShowCreate(true)} />}
                >
                    {[...teams]
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((team) => (
                            <DroppableSidebarItem
                                key={team.id}
                                icon={<UserAvatar userId={teamOwnerId(team.id)} />}
                                label={team.name}
                                to={`/teams?teamId=${team.id}`}
                                condensed={condensed}
                                acceptTypes={['member']}
                                onDrop={(data) => onAddMembersToTeam?.(data.ids, team.id)}
                            />
                        ))}
                </SidebarSection>

                {/* No StorageUsage: Admin is a server-admin surface, not a personal-storage context. */}
            </SidebarBody>

            <Dialog open={showCreate} onOpenChange={setShowCreate}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Create Team</DialogTitle>
                    </DialogHeader>
                    <form onSubmit={handleCreate} className="space-y-4">
                        <Input
                            placeholder="Team name"
                            value={newTeamName}
                            onChange={(e) => setNewTeamName(e.target.value)}
                            autoFocus
                            required
                        />
                        <DialogFooter>
                            <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
                                Cancel
                            </Button>
                            <Button type="submit" disabled={createTeam.isPending}>
                                {createTeam.isPending ? 'Creating...' : 'Create'}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </>
    );
}
