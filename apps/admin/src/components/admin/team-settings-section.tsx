import { useUpdateTeam } from '@workspace/lib/admin';
import { useCalendars, useUpdateCalendar } from '@workspace/lib/calendar';
import { useHomeDataLabel } from '@workspace/lib/public';
import { useRemoveTeamAvatar, useTeamSettings, useUpdateTeamSettings, useUploadTeamAvatar } from '@workspace/lib/team';
import type { OrgTeam } from '@workspace/lib/types/admin';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { AvatarEditor, SettingsSection } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Separator } from '@workspace/ui/components/separator';
import { Switch } from '@workspace/ui/components/switch';
import { UserAvatar } from '@workspace/ui/components/user';
import { Pencil } from 'lucide-react';
import { useMemo, useState } from 'react';

// What a team's members may do with the team calendar. 'read' is the absence of a share row rather
// than one of the two permissions the API takes, so it lives only here.
const CALENDAR_ACCESS = [
    { value: 'free-busy', label: 'Free/Busy' },
    { value: 'read', label: 'Read' },
    { value: 'write', label: 'Write' },
] as const;
type CalendarAccess = (typeof CALENDAR_ACCESS)[number]['value'];

type TeamSettingsSectionProps = {
    team: OrgTeam;
    organizationId?: string;
};

// The team's header with its avatar and name, and the settings it shows or edits below it.
export function TeamSettingsSection({ team, organizationId }: TeamSettingsSectionProps) {
    const [showSettingsForm, setShowSettingsForm] = useState(false);
    // This page always requests the avatar with a fresh ?v=timestamp (stamped per mount and after
    // upload/remove): the editing surface must never show the up-to-24h browser-cached copy of the
    // team's stable /p/avatar URL. Other surfaces accept that TTL. The route mounts the team detail
    // with key={team.id}, so switching teams remounts and re-stamps naturally.
    const [avatarUrl, setAvatarUrl] = useState(() => `p/avatar/${teamOwnerId(team.id)}?v=${Date.now()}`);

    const [draftName, setDraftName] = useState(team.name);
    const [draftCalEnabled, setDraftCalEnabled] = useState(true);
    const [draftCalPermission, setDraftCalPermission] = useState<CalendarAccess>('read');
    const [draftMailMax, setDraftMailMax] = useState('');
    const [draftMountMax, setDraftMountMax] = useState('');

    const updateTeam = useUpdateTeam(organizationId);

    const ownerId = teamOwnerId(team.id);
    const { data: calendars = [] } = useCalendars(ownerId);
    const updateCalendar = useUpdateCalendar(ownerId);
    const { data: settings } = useTeamSettings(team.id);
    const updateSettings = useUpdateTeamSettings(team.id);
    const homeDataLabel = useHomeDataLabel();
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
                    : [...existingShares, { targetId: teamTarget, permission: draftCalPermission }];
            await updateCalendar.mutateAsync({ id: defaultCal.id, shares });
        }
        setShowSettingsForm(false);
    };

    const handleAvatarUpload = async (file: File) => {
        await uploadAvatar.mutateAsync(file);
        setAvatarUrl(`p/avatar/${ownerId}?v=${Date.now()}`);
    };

    const handleRemoveAvatar = async () => {
        await removeAvatar.mutateAsync();
        setAvatarUrl(`p/avatar/${ownerId}?v=${Date.now()}`);
    };

    return (
        <>
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
                                <Select
                                    value={draftCalPermission}
                                    onValueChange={(value) =>
                                        setDraftCalPermission(
                                            CALENDAR_ACCESS.find((option) => option.value === value)?.value ?? 'read',
                                        )
                                    }
                                >
                                    <SelectTrigger className="w-32">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {CALENDAR_ACCESS.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>
                                                {option.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        )}
                    </div>

                    <Separator />

                    <SettingsSection
                        title="Quota Overrides"
                        description="Override server defaults for members of this team. Leave empty to inherit."
                    >
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                                <Label>{homeDataLabel} (MB)</Label>
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
                    </SettingsSection>

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
                                    `${homeDataLabel}: ${settings.memberOverrides.mailAndContactsMaxMB} MB`}
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
        </>
    );
}
