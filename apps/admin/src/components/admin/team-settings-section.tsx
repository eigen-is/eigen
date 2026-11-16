// The settings section of a team's admin page: its name and avatar, whether it has a calendar, and the quota
// overrides that raise its members' storage limits above the server's defaults. Each part saves through its own
// hook, such as the team settings or the calendar, and a refused save is toasted there.

import { useUpdateTeam } from '@workspace/lib/admin';
import { useCalendars, useUpdateCalendar } from '@workspace/lib/calendar';
import { QUOTA_MIN_MB } from '@workspace/lib/constants/settings';
import { useHomeDataLabel } from '@workspace/lib/public';
import { useRemoveTeamAvatar, useTeamSettings, useUpdateTeamSettings, useUploadTeamAvatar } from '@workspace/lib/team';
import type { OrgTeam } from '@workspace/lib/types/admin';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { AvatarEditor } from '@workspace/ui/components/avatar-editor';
import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { SettingsSection } from '@workspace/ui/components/layout/app';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Separator } from '@workspace/ui/components/separator';
import { Switch } from '@workspace/ui/components/switch';
import { UserAvatar } from '@workspace/ui/components/user';
import { Pencil } from 'lucide-react';
import { useState } from 'react';

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

export function TeamSettingsSection({ team, organizationId }: TeamSettingsSectionProps) {
    const ownerId = teamOwnerId(team.id);
    const [showSettingsForm, setShowSettingsForm] = useState(false);
    // A fresh ?v= on each mount and after each change, so the editor never shows the browser's cached copy of the
    // avatar, which other pages accept for up to a day.
    const [avatarUrl, setAvatarUrl] = useState(() => `p/avatar/${ownerId}?v=${Date.now()}`);

    const [draftName, setDraftName] = useState(team.name);
    const [draftCalEnabled, setDraftCalEnabled] = useState(true);
    const [draftCalPermission, setDraftCalPermission] = useState<CalendarAccess>('read');
    const [draftNotifyMembers, setDraftNotifyMembers] = useState(true);
    const [draftHomeDataMax, setDraftHomeDataMax] = useState('');
    const [draftMountMax, setDraftMountMax] = useState('');

    const updateTeam = useUpdateTeam(organizationId);

    const { data: settings } = useTeamSettings(team.id);
    const calendarEnabled = settings?.calendar?.enabled !== false;
    // A team with its calendar off has no calendar list to fetch: the route answers 404.
    const { data: calendars = [] } = useCalendars(ownerId, !!settings && calendarEnabled);
    const updateCalendar = useUpdateCalendar(ownerId);
    const updateSettings = useUpdateTeamSettings(team.id);
    const homeDataLabel = useHomeDataLabel();
    const uploadAvatar = useUploadTeamAvatar(team.id);
    const removeAvatar = useRemoveTeamAvatar(team.id);

    const defaultCal = calendars.find((c) => c.isDefault);
    const notifyMembers = settings?.notifyMembers !== false;
    const overrides = settings?.memberOverrides;
    const overridesText = [
        overrides?.homeDataMaxMB && `${homeDataLabel}: ${overrides.homeDataMaxMB} MB`,
        overrides?.defaultMountMaxSizeMB && `Mount: ${overrides.defaultMountMaxSizeMB} MB`,
    ]
        .filter(Boolean)
        .join(' · ');

    const calendarPermission = defaultCal?.shares?.find((s) => s.targetId === ownerId)?.permission ?? 'read';
    const homeDataTooSmall = draftHomeDataMax !== '' && Number(draftHomeDataMax) < QUOTA_MIN_MB;
    const mountTooSmall = draftMountMax !== '' && Number(draftMountMax) < QUOTA_MIN_MB;

    const openSettingsForm = () => {
        setDraftName(team.name);
        setDraftCalEnabled(calendarEnabled);
        setDraftCalPermission(calendarPermission);
        setDraftNotifyMembers(notifyMembers);
        setDraftHomeDataMax(overrides?.homeDataMaxMB?.toString() ?? '');
        setDraftMountMax(overrides?.defaultMountMaxSizeMB?.toString() ?? '');
        setShowSettingsForm(true);
    };

    const handleSaveSettings = () => {
        const name = draftName.trim();
        if (name && name !== team.name) updateTeam.mutate({ teamId: team.id, name });
        if (defaultCal && draftCalEnabled) {
            const existingShares = (defaultCal.shares ?? []).filter((s) => s.targetId !== ownerId);
            const shares =
                draftCalPermission === 'read'
                    ? existingShares.length > 0
                        ? existingShares
                        : null
                    : [...existingShares, { targetId: ownerId, permission: draftCalPermission }];
            updateCalendar.mutate({ id: defaultCal.id, shares });
        }
        updateSettings.mutate(
            {
                calendar: { enabled: draftCalEnabled },
                notifyMembers: draftNotifyMembers,
                memberOverrides: {
                    homeDataMaxMB: draftHomeDataMax ? Number(draftHomeDataMax) : undefined,
                    defaultMountMaxSizeMB: draftMountMax ? Number(draftMountMax) : undefined,
                },
            },
            { onSuccess: () => setShowSettingsForm(false) },
        );
    };

    const refreshAvatar = () => setAvatarUrl(`p/avatar/${ownerId}?v=${Date.now()}`);

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
                            onUpload={(file) => uploadAvatar.mutate(file, { onSuccess: refreshAvatar })}
                            onRemove={() => removeAvatar.mutate(undefined, { onSuccess: refreshAvatar })}
                        />
                    </div>

                    <div className="space-y-1.5">
                        <Label>Team name</Label>
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

                    <div className="flex items-center justify-between">
                        <Label>Notify members</Label>
                        <Switch checked={draftNotifyMembers} onCheckedChange={setDraftNotifyMembers} />
                    </div>

                    <Separator />

                    <SettingsSection
                        title="Quota overrides"
                        description="Override server defaults for members of this team. Leave empty to inherit."
                    >
                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                                <Label>{homeDataLabel} (MB)</Label>
                                <Input
                                    type="number"
                                    min={QUOTA_MIN_MB}
                                    placeholder="Inherit"
                                    value={draftHomeDataMax}
                                    onChange={(e) => setDraftHomeDataMax(e.target.value)}
                                />
                                {homeDataTooSmall && (
                                    <p className="text-xs text-destructive">At least {QUOTA_MIN_MB} MB</p>
                                )}
                            </div>
                            <div className="space-y-1.5">
                                <Label>Default mount (MB)</Label>
                                <Input
                                    type="number"
                                    min={QUOTA_MIN_MB}
                                    placeholder="Inherit"
                                    value={draftMountMax}
                                    onChange={(e) => setDraftMountMax(e.target.value)}
                                />
                                {mountTooSmall && (
                                    <p className="text-xs text-destructive">At least {QUOTA_MIN_MB} MB</p>
                                )}
                            </div>
                        </div>
                    </SettingsSection>

                    <div className="flex items-center justify-end gap-2 pt-2">
                        <Button variant="outline" onClick={() => setShowSettingsForm(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleSaveSettings} disabled={homeDataTooSmall || mountTooSmall}>
                            Save settings
                        </Button>
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
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Notify members</span>
                        <span className="text-sm">{notifyMembers ? 'Enabled' : 'Disabled'}</span>
                    </div>
                    {overridesText && (
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-muted-foreground">Quota overrides</span>
                            <span className="text-sm">{overridesText}</span>
                        </div>
                    )}
                </div>
            )}
        </>
    );
}
