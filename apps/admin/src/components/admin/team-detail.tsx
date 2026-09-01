import { useNavigate } from '@tanstack/react-router';
import { useAddTeamMember, useMembers, useRemoveTeam, useRemoveTeamMember, useUpdateTeam } from '@workspace/lib/admin';
import { useCalendars, useUpdateCalendar } from '@workspace/lib/calendar';
import { useCheckS3Connection, useHardenS3Bucket, useServerSettings } from '@workspace/lib/settings';
import {
    useAddTeamMount,
    useRemoveTeamAvatar,
    useTeamMembers,
    useTeamMounts,
    useTeamSettings,
    useUpdateTeamMount,
    useUpdateTeamSettings,
    useUploadTeamAvatar,
} from '@workspace/lib/team';
import { teamOwnerId } from '@workspace/lib/types';
import type { OrgTeam } from '@workspace/lib/types/admin';
import type { S3Config } from '@workspace/lib/types/mount';
import { type MountSettings, mapStorageType } from '@workspace/lib/types/settings';
import { AvatarEditor, DeleteDialog, TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import type { MountFormValues } from '@workspace/ui/components/mount/mount-form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Separator } from '@workspace/ui/components/separator';
import { Switch } from '@workspace/ui/components/switch';
import { UserAvatar, UserItem } from '@workspace/ui/components/user';
import { HardDrive, Pencil, Settings, Trash2, UserRoundPlus, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AddMemberDialog } from './add-member-dialog';
import { MountDialog } from './mount-dialog';

type TeamDetailToolbarProps = {
    team: OrgTeam;
    organizationId?: string;
};

export function TeamDetailToolbar({ team, organizationId }: TeamDetailToolbarProps) {
    const [showDelete, setShowDelete] = useState(false);
    const removeTeam = useRemoveTeam(organizationId);
    const navigate = useNavigate();

    const handleRemove = async () => {
        await removeTeam.mutateAsync(team.id);
        navigate({ to: '/teams', search: {} });
    };

    return (
        <div className="flex items-center gap-1 ml-auto">
            <TooltipButton icon={Trash2} tooltipText="Delete team" onClick={() => setShowDelete(true)} />
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

type TeamDetailProps = {
    team: OrgTeam;
    organizationId?: string;
};

export function TeamDetail({ team, organizationId }: TeamDetailProps) {
    const [showAddDialog, setShowAddDialog] = useState(false);
    const [showAddMount, setShowAddMount] = useState(false);
    const [editingMount, setEditingMount] = useState<{ id: string; mount: MountSettings } | null>(null);
    const [showSettingsForm, setShowSettingsForm] = useState(false);
    // This page always requests the avatar with a fresh ?v=timestamp (stamped per mount and after
    // upload/remove): the editing surface must never show the up-to-24h browser-cached copy of the
    // team's stable /p/avatar URL. Other surfaces accept that TTL. The route mounts this component
    // with key={team.id}, so switching teams remounts and re-stamps naturally.
    const [avatarUrl, setAvatarUrl] = useState(() => `p/avatar/${teamOwnerId(team.id)}?v=${Date.now()}`);

    const [draftName, setDraftName] = useState(team.name);
    const [draftCalEnabled, setDraftCalEnabled] = useState(true);
    const [draftCalPermission, setDraftCalPermission] = useState('read');
    const [draftMailMax, setDraftMailMax] = useState('');
    const [draftMountMax, setDraftMountMax] = useState('');

    const updateTeam = useUpdateTeam(organizationId);
    const { data: teamMembers = [] } = useTeamMembers(team.id);
    const { data: allMembers = [] } = useMembers(organizationId);
    const addMember = useAddTeamMember();
    const removeMember = useRemoveTeamMember();

    const ownerId = teamOwnerId(team.id);
    const { data: calendars = [] } = useCalendars(ownerId);
    const updateCalendar = useUpdateCalendar(ownerId);
    const { data: settings } = useTeamSettings(team.id);
    const updateSettings = useUpdateTeamSettings(team.id);
    const { data: serverSettings } = useServerSettings();
    const s3Check = useCheckS3Connection();
    const s3Harden = useHardenS3Bucket();

    const { data: mounts = {} } = useTeamMounts(team.id);
    const addMount = useAddTeamMount(team.id);
    const updateMount = useUpdateTeamMount(team.id);
    const uploadAvatar = useUploadTeamAvatar(team.id);
    const removeAvatar = useRemoveTeamAvatar(team.id);

    const defaultCal = calendars.find((c) => c.isDefault);
    const teamTarget = teamOwnerId(team.id);
    const calendarEnabled = settings?.calendar?.enabled !== false;

    const calendarPermission = useMemo(() => {
        if (!defaultCal?.shares) return 'read';
        const share = defaultCal.shares.find((s) => s.targetId === teamTarget);
        return share?.permission || 'read';
    }, [defaultCal, teamTarget]);

    const teamMemberUserIds = new Set(teamMembers.map((m) => m.userId));
    const availableMembers = allMembers.filter((m) => !teamMemberUserIds.has(m.userId));

    const defaultMountStorageType = serverSettings
        ? mapStorageType(serverSettings.defaults.mount.storageType)
        : ('local' as const);

    const openSettingsForm = () => {
        setDraftName(team.name);
        setDraftCalEnabled(calendarEnabled);
        setDraftCalPermission(calendarPermission);
        setDraftMailMax(settings?.memberOverrides?.mailAndContactsMaxMB?.toString() ?? '');
        setDraftMountMax(settings?.memberOverrides?.defaultMountMaxSizeMB?.toString() ?? '');
        setShowSettingsForm(true);
    };

    const handleSaveSettings = async () => {
        if (draftName.trim() && draftName.trim() !== team.name) {
            await updateTeam.mutateAsync({ teamId: team.id, name: draftName.trim() });
        }
        await updateSettings.mutateAsync({
            calendar: { enabled: draftCalEnabled },
            memberOverrides: {
                mailAndContactsMaxMB: draftMailMax ? Number(draftMailMax) : undefined,
                defaultMountMaxSizeMB: draftMountMax ? Number(draftMountMax) : undefined,
            },
        });
        if (defaultCal && draftCalEnabled) {
            const existingShares = (defaultCal.shares || []).filter((s) => s.targetId !== teamTarget);
            const shares =
                draftCalPermission === 'read'
                    ? existingShares.length > 0
                        ? existingShares
                        : null
                    : [
                          ...existingShares,
                          { targetId: teamTarget, permission: draftCalPermission as 'free-busy' | 'write' },
                      ];
            await updateCalendar.mutateAsync({ id: defaultCal.id, shares });
        }
        setShowSettingsForm(false);
    };

    const handleAddMount = async (values: MountFormValues) => {
        await addMount.mutateAsync({
            name: values.name,
            storageType: values.storageType,
            maxSizeMB: values.maxSizeMB,
            s3Config: values.s3Config,
        });
    };

    const handleEditMount = async (values: MountFormValues) => {
        if (!editingMount) return;
        await updateMount.mutateAsync({
            mountId: editingMount.id,
            maxSizeMB: values.maxSizeMB,
            name: values.name,
            s3Config: values.s3Config,
        });
    };

    const handleAddMember = async (userId: string) => {
        await addMember.mutateAsync({ teamId: team.id, userId });
    };

    const handleRemoveMember = async (userId: string) => {
        await removeMember.mutateAsync({ teamId: team.id, userId });
    };

    const handleS3Check = (config: S3Config) => s3Check.mutateAsync(config);
    const handleS3Harden = (config: S3Config, noncurrentDays: number) =>
        s3Harden.mutateAsync({ ...config, noncurrentDays });

    const handleAvatarUpload = async (file: File) => {
        await uploadAvatar.mutateAsync(file);
        setAvatarUrl(`p/avatar/${ownerId}?v=${Date.now()}`);
    };

    const handleRemoveAvatar = async () => {
        await removeAvatar.mutateAsync();
        setAvatarUrl(`p/avatar/${ownerId}?v=${Date.now()}`);
    };

    return (
        <div className="app-gutter space-y-6 h-full overflow-y-auto">
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                    <UserAvatar size="lg" userId={ownerId} imageUrl={avatarUrl} />
                    <h2 className="text-xl font-medium truncate">{team.name}</h2>
                </div>
                {!showSettingsForm && (
                    <Button variant="ghost" size="sm" onClick={openSettingsForm}>
                        <Pencil className="h-4 w-4 mr-1" />
                        Edit
                    </Button>
                )}
            </div>

            {showSettingsForm ? (
                <div className="space-y-5 border rounded-lg p-4">
                    <div className="space-y-1.5">
                        <Label>Avatar</Label>
                        <AvatarEditor
                            className="h-24 w-24"
                            userId={ownerId}
                            imageUrl={avatarUrl}
                            onUpload={handleAvatarUpload}
                            onRemove={handleRemoveAvatar}
                        />
                    </div>

                    <div className="space-y-1.5">
                        <Label>Team Name</Label>
                        <Input value={draftName} onChange={(e) => setDraftName(e.target.value)} />
                    </div>

                    <Separator />

                    <div className="space-y-4">
                        <div className="flex items-center justify-between">
                            <Label>Calendar</Label>
                            <Switch checked={draftCalEnabled} onCheckedChange={setDraftCalEnabled} />
                        </div>
                        {draftCalEnabled && (
                            <div className="flex items-center justify-between">
                                <Label>Member access</Label>
                                <Select value={draftCalPermission} onValueChange={setDraftCalPermission}>
                                    <SelectTrigger className="w-32">
                                        <SelectValue />
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

                    <Separator />

                    <div className="space-y-3">
                        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                            Quota Overrides
                        </h3>
                        <p className="text-xs text-muted-foreground">
                            Override server defaults for members of this team. Leave empty to inherit.
                        </p>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                                <Label>Mail & Contacts (MB)</Label>
                                <Input
                                    type="number"
                                    min={10}
                                    placeholder="Inherit"
                                    value={draftMailMax}
                                    onChange={(e) => setDraftMailMax(e.target.value)}
                                />
                            </div>
                            <div className="space-y-1.5">
                                <Label>Default Mount (MB)</Label>
                                <Input
                                    type="number"
                                    min={10}
                                    placeholder="Inherit"
                                    value={draftMountMax}
                                    onChange={(e) => setDraftMountMax(e.target.value)}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center justify-end gap-2 pt-2">
                        <Button variant="outline" onClick={() => setShowSettingsForm(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleSaveSettings}>Save Settings</Button>
                    </div>
                </div>
            ) : (
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Calendar</span>
                        <span className="text-sm">
                            {calendarEnabled ? `Enabled (${calendarPermission})` : 'Disabled'}
                        </span>
                    </div>
                    {(settings?.memberOverrides?.mailAndContactsMaxMB ||
                        settings?.memberOverrides?.defaultMountMaxSizeMB) && (
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-muted-foreground">Quota overrides</span>
                            <span className="text-sm">
                                {settings?.memberOverrides?.mailAndContactsMaxMB &&
                                    `Mail: ${settings.memberOverrides.mailAndContactsMaxMB} MB`}
                                {settings?.memberOverrides?.mailAndContactsMaxMB &&
                                    settings?.memberOverrides?.defaultMountMaxSizeMB &&
                                    ' · '}
                                {settings?.memberOverrides?.defaultMountMaxSizeMB &&
                                    `Mount: ${settings.memberOverrides.defaultMountMaxSizeMB} MB`}
                            </span>
                        </div>
                    )}
                </div>
            )}

            <Separator />

            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">Mounts ({Object.keys(mounts).length})</h3>
                    <Button variant="ghost" size="sm" onClick={() => setShowAddMount(true)}>
                        <HardDrive className="h-4 w-4 mr-1" />
                        Add
                    </Button>
                </div>

                <MountDialog
                    open={showAddMount}
                    onOpenChange={setShowAddMount}
                    onSubmit={handleAddMount}
                    onS3Check={handleS3Check}
                    onS3Harden={handleS3Harden}
                    title="Add Mount"
                    submitLabel="Create Mount"
                    defaultStorageType={defaultMountStorageType}
                    defaultMaxSizeMB={serverSettings?.quotas.defaultMountMaxSizeMB}
                    defaultS3Config={serverSettings?.defaults.mount.s3Config}
                />

                <MountDialog
                    open={!!editingMount}
                    onOpenChange={(open) => {
                        if (!open) setEditingMount(null);
                    }}
                    onSubmit={handleEditMount}
                    onS3Check={handleS3Check}
                    onS3Harden={handleS3Harden}
                    initialValues={
                        editingMount
                            ? {
                                  name: editingMount.mount.name ?? editingMount.id,
                                  storageType: editingMount.mount.storageType,
                                  maxSizeMB: editingMount.mount.maxSizeMB ?? 500,
                                  s3Config: editingMount.mount.s3Config,
                              }
                            : undefined
                    }
                    title="Edit Mount"
                    submitLabel="Save Changes"
                    isEdit
                />

                {Object.keys(mounts).length === 0 ? (
                    <p className="text-sm text-muted-foreground py-2 text-center">
                        No mounts. Add one to enable team drive.
                    </p>
                ) : (
                    <div className="space-y-2">
                        {Object.entries(mounts).map(([id, mount]: [string, MountSettings]) => (
                            <div key={id} className="flex items-center gap-3 p-3 border rounded-lg">
                                <HardDrive className="h-4 w-4 text-muted-foreground shrink-0" />
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-medium truncate">{mount.name || id}</div>
                                    <div className="text-xs text-muted-foreground">
                                        {mount.storageType} · {mount.maxSizeMB ?? '∞'} MB
                                    </div>
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 shrink-0"
                                    onClick={() => setEditingMount({ id, mount })}
                                >
                                    <Settings className="h-3.5 w-3.5" />
                                </Button>
                                <Switch
                                    checked={mount.enabled}
                                    onCheckedChange={async (enabled) => {
                                        await updateMount.mutateAsync({ mountId: id, enabled });
                                    }}
                                />
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <Separator />

            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">Members ({teamMembers.length})</h3>
                    <Button variant="ghost" size="sm" onClick={() => setShowAddDialog(true)}>
                        <UserRoundPlus className="h-4 w-4 mr-1" />
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
                        {[...teamMembers]
                            .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
                            .map((tm) => (
                                <div key={tm.userId} className="flex items-center gap-3 py-2">
                                    <UserItem
                                        name={tm.name ?? 'Unknown'}
                                        email={tm.email ?? ''}
                                        userId={tm.userId}
                                        className="flex-1 min-w-0"
                                    />
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                                        onClick={() => handleRemoveMember(tm.userId)}
                                    >
                                        <X className="h-3.5 w-3.5" />
                                    </Button>
                                </div>
                            ))}
                    </div>
                )}
            </div>
        </div>
    );
}
