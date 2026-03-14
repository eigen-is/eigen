import {useEffect, useMemo, useState} from 'react';
import {Input} from '@workspace/ui/components/input';
import {Button} from '@workspace/ui/components/button';
import {Label} from '@workspace/ui/components/label';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@workspace/ui/components/select';
import {Switch} from '@workspace/ui/components/switch';
import {Separator} from '@workspace/ui/components/separator';
import {Check, Pencil, Plus, Trash2, UserPlus, X} from 'lucide-react';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@workspace/ui/components/dialog';
import {DeleteDialog} from '@workspace/ui/components/layout/delete/delete-dialog';
import {TooltipButton} from '@workspace/ui/components/layout/toolbar/tooltip-button.tsx';
import {UserItem} from '@workspace/ui/components/layout/user-item';
import {
    useAddTeamMember,
    usePeopleMembers,
    useRemoveTeam,
    useRemoveTeamMember,
    useTeamMembers,
    useUpdateTeam
} from '@workspace/lib/people';
import {useCalendars, useUpdateCalendar} from '@workspace/lib/calendar';
import {teamOwnerId} from '@workspace/lib/types';
import {useNavigate} from '@tanstack/react-router';
import {toast} from 'sonner';
import type {OrgMember, OrgTeam} from '@workspace/lib/types/people';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {api} from '@workspace/lib/api';

function useTeamSettings(teamId: string) {
    return useQuery({
        queryKey: ['team-settings', teamId],
        queryFn: async () => {
            const res = await (api.calendar as any).team({teamId}).settings.get();
            return (res.data || {}) as {enabled?: boolean};
        },
        staleTime: 5 * 60 * 1000,
    });
}

function useUpdateTeamSettings(teamId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (body: {enabled?: boolean}) => {
            const res = await (api.calendar as any).team({teamId}).settings.put(body);
            if (res.error) throw new Error(String(res.error));
            return res.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: ['team-settings', teamId]});
            queryClient.invalidateQueries({queryKey: ['calendar', 'shared']});
        },
    });
}

interface TeamDetailToolbarProps {
    team: OrgTeam;
    organizationId?: string;
}

export function TeamDetailToolbar({team, organizationId}: TeamDetailToolbarProps) {
    const [showDelete, setShowDelete] = useState(false);
    const removeTeam = useRemoveTeam(organizationId);
    const navigate = useNavigate();

    const handleRemove = async () => {
        try {
            await removeTeam.mutateAsync(team.id);
            toast.success(`Team "${team.name}" deleted`);
            navigate({to: '/teams', search: {}});
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to delete team');
        }
    };

    return (
        <div className="flex items-center gap-1 ml-auto">
            <TooltipButton icon={Trash2} tooltipText="Delete team" onClick={() => setShowDelete(true)}/>
            <DeleteDialog
                open={showDelete}
                onOpenChange={setShowDelete}
                title="Delete Team"
                description={`Delete team "${team.name}"? This cannot be undone.`}
                onDelete={handleRemove}
            />
        </div>
    );
}

function AddMemberDialog({open, onOpenChange, availableMembers, onAdd}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    availableMembers: OrgMember[];
    onAdd: (userId: string) => void;
}) {
    const [search, setSearch] = useState('');

    const filtered = useMemo(() => {
        if (!search) return availableMembers;
        const q = search.toLowerCase();
        return availableMembers.filter(m =>
            m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)
        );
    }, [availableMembers, search]);

    return (
        <Dialog open={open} onOpenChange={(v) => {
            onOpenChange(v);
            if (!v) setSearch('');
        }}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>Add Member to Team</DialogTitle>
                </DialogHeader>
                <Input
                    placeholder="Search by name or email..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    autoFocus
                />
                <div className="max-h-64 overflow-y-auto -mx-2">
                    {filtered.length === 0 ? (
                        <p className="text-sm text-muted-foreground text-center py-4">
                            {availableMembers.length === 0 ? 'All members are already in this team.' : 'No members match your search.'}
                        </p>
                    ) : (
                        filtered.map(m => (
                            <div
                                key={m.userId}
                                className="flex items-center gap-3 px-2 py-2 rounded-md cursor-pointer hover:bg-accent"
                                onClick={() => {
                                    onAdd(m.userId);
                                    setSearch('');
                                }}
                            >
                                <UserItem
                                    name={m.name}
                                    email={m.email}
                                    imageUrl={m.image ?? undefined}
                                    className="flex-1 min-w-0"
                                />
                                <Plus className="h-4 w-4 text-muted-foreground shrink-0"/>
                            </div>
                        ))
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

interface TeamDetailProps {
    team: OrgTeam;
    organizationId?: string;
}

export function TeamDetail({team, organizationId}: TeamDetailProps) {
    const [isEditing, setIsEditing] = useState(false);
    const [editName, setEditName] = useState(team.name);
    const [showAddDialog, setShowAddDialog] = useState(false);

    const updateTeam = useUpdateTeam();
    const {data: teamMembers = []} = useTeamMembers(team.id);
    const {data: allMembers = []} = usePeopleMembers(organizationId);
    const addMember = useAddTeamMember();
    const removeMember = useRemoveTeamMember();

    // Calendar settings
    const ownerId = teamOwnerId(team.id);
    const {data: calendars = []} = useCalendars(ownerId);
    const updateCalendar = useUpdateCalendar(ownerId);
    const {data: settings} = useTeamSettings(team.id);
    const updateSettings = useUpdateTeamSettings(team.id);

    const defaultCal = calendars.find(c => c.isDefault);
    const teamTarget = `team_${team.id}`;
    const calendarEnabled = settings?.enabled !== false;

    const calendarPermission = useMemo(() => {
        if (!defaultCal?.shares) return 'read';
        const share = defaultCal.shares.find(s => s.targetId === teamTarget);
        return share?.permission || 'read';
    }, [defaultCal, teamTarget]);

    const teamMemberUserIds = new Set(teamMembers.map((m: {userId: string}) => m.userId));
    const availableMembers = allMembers.filter(m => !teamMemberUserIds.has(m.userId));

    useEffect(() => {
        setEditName(team.name);
        setIsEditing(false);
    }, [team.id, team.name]);

    const handleSaveName = async () => {
        if (!editName.trim() || editName.trim() === team.name) {
            setIsEditing(false);
            setEditName(team.name);
            return;
        }
        try {
            await updateTeam.mutateAsync({teamId: team.id, name: editName.trim()});
            toast.success('Team name updated');
            setIsEditing(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to update team name');
        }
    };

    const handleCalendarEnabledChange = async (enabled: boolean) => {
        try {
            await updateSettings.mutateAsync({enabled});
            toast.success(enabled ? 'Team calendar enabled' : 'Team calendar disabled');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to update settings');
        }
    };

    const handlePermissionChange = async (value: string) => {
        if (!defaultCal) return;
        const shares = value === 'read'
            ? null
            : [{targetId: teamTarget, permission: value as 'free-busy' | 'write'}];
        try {
            await updateCalendar.mutateAsync({id: defaultCal.id, shares});
            toast.success('Calendar permission updated');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to update permission');
        }
    };

    const handleAddMember = async (userId: string) => {
        try {
            await addMember.mutateAsync({teamId: team.id, userId});
            const member = allMembers.find(m => m.userId === userId);
            toast.success(`${member?.name ?? 'Member'} added to team`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to add member');
        }
    };

    const handleRemoveMember = async (userId: string) => {
        try {
            await removeMember.mutateAsync({teamId: team.id, userId});
            toast.success('Member removed from team');
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Failed to remove member');
        }
    };

    return (
        <div className="p-6 space-y-6">
            <div className="flex items-center gap-3">
                {isEditing ? (
                    <div className="flex items-center gap-2 flex-1">
                        <Input
                            value={editName}
                            onChange={e => setEditName(e.target.value)}
                            className="text-xl font-semibold"
                            autoFocus
                            onKeyDown={e => {
                                if (e.key === 'Enter') handleSaveName();
                                if (e.key === 'Escape') {
                                    setIsEditing(false);
                                    setEditName(team.name);
                                }
                            }}
                        />
                        <Button variant="ghost" size="icon" onClick={handleSaveName}>
                            <Check className="h-4 w-4"/>
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => {
                            setIsEditing(false);
                            setEditName(team.name);
                        }}>
                            <X className="h-4 w-4"/>
                        </Button>
                    </div>
                ) : (
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                        <h2 className="text-xl font-semibold truncate">{team.name}</h2>
                        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0"
                                onClick={() => setIsEditing(true)}>
                            <Pencil className="h-3.5 w-3.5"/>
                        </Button>
                    </div>
                )}
            </div>

            <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <Label>Calendar</Label>
                    <Switch checked={calendarEnabled} onCheckedChange={handleCalendarEnabledChange}/>
                </div>

                {calendarEnabled && defaultCal && (
                    <div className="flex items-center justify-between">
                        <Label>Member access</Label>
                        <Select value={calendarPermission} onValueChange={handlePermissionChange}>
                            <SelectTrigger className="w-32">
                                <SelectValue/>
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="free-busy">Free/Busy</SelectItem>
                                <SelectItem value="read">Read</SelectItem>
                                <SelectItem value="write">Write</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                )}
            </div>

            <Separator/>

            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">Members ({teamMembers.length})</h3>
                    <Button variant="ghost" size="sm" onClick={() => setShowAddDialog(true)}>
                        <UserPlus className="h-4 w-4 mr-1"/>
                        Add
                    </Button>
                </div>

                <AddMemberDialog
                    open={showAddDialog}
                    onOpenChange={setShowAddDialog}
                    availableMembers={availableMembers}
                    onAdd={handleAddMember}
                />

                {teamMembers.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">No members in this team yet.</p>
                ) : (
                    <div className="divide-y">
                        {teamMembers.map((tm: {userId: string}) => {
                            const member = allMembers.find(m => m.userId === tm.userId);
                            return (
                                <div key={tm.userId} className="flex items-center gap-3 py-2">
                                    <UserItem
                                        name={member?.name ?? 'Unknown'}
                                        email={member?.email ?? ''}
                                        imageUrl={member?.image ?? undefined}
                                        className="flex-1 min-w-0"
                                    />
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                                        onClick={() => handleRemoveMember(tm.userId)}
                                    >
                                        <X className="h-3.5 w-3.5"/>
                                    </Button>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
