// The settings section of a team's admin page: its name and avatar, whether it has a calendar, and the quota
// overrides that raise its members' storage limits above the server's defaults. Edit opens them on a PageForm. The
// avatar saves as it changes; the rest saves through one Save, which toasts once, and a refused save is toasted there
// and keeps the form open with what was typed. Save with nothing changed goes back like Cancel.

import { useCalendars } from '@workspace/lib/calendar';
import { CALENDAR_PERMISSION_LABELS } from '@workspace/lib/constants/calendar';
import { QUOTA_MIN_MB } from '@workspace/lib/constants/settings';
import { useHomeDataLabel } from '@workspace/lib/public';
import { useRemoveTeamAvatar, useSaveTeamSettings, useTeamSettings, useUploadTeamAvatar } from '@workspace/lib/team';
import type { OrgTeam } from '@workspace/lib/types/admin';
import type { CalendarItem, CalendarShare } from '@workspace/lib/types/calendar';
import { CALENDAR_SHARE_PERMISSIONS } from '@workspace/lib/types/calendar';
import { teamOwnerId } from '@workspace/lib/types/owner';
import { FIELD_MESSAGES } from '@workspace/lib/validation';
import { AvatarEditor } from '@workspace/ui/components/avatar-editor';
import { Button } from '@workspace/ui/components/button';
import { FieldError } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { PageForm, SettingsSection } from '@workspace/ui/components/layout/app';
import { RequiredTextField } from '@workspace/ui/components/required-text-field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Separator } from '@workspace/ui/components/separator';
import { Switch } from '@workspace/ui/components/switch';
import { UserAvatar } from '@workspace/ui/components/user';
import { Pencil } from 'lucide-react';
import { useId, useState } from 'react';

type TeamSettingsSectionProps = {
    team: OrgTeam;
    organizationId: string;
};

// What the form edits, as text where the admin types it.
type TeamSettingsDraft = {
    name: string;
    calendarEnabled: boolean;
    calendarPermission: CalendarShare['permission'];
    notifyMembers: boolean;
    homeDataMaxMB: string;
    mountMaxMB: string;
};

export function TeamSettingsSection({ team, organizationId }: TeamSettingsSectionProps) {
    const ownerId = teamOwnerId(team.id);
    const [editing, setEditing] = useState(false);
    // A fresh ?v= on each mount and after each change, so the editor never shows the browser's cached copy of the
    // avatar, which other pages accept for up to a day.
    const [avatarUrl, setAvatarUrl] = useState(() => `p/avatar/${ownerId}?v=${Date.now()}`);

    const { data: settings } = useTeamSettings(team.id);
    const calendarEnabled = settings?.calendar?.enabled !== false;
    // A team with its calendar off has no calendar list to fetch: the route answers 404.
    const { data: calendars = [] } = useCalendars(ownerId, !!settings && calendarEnabled);
    const homeDataLabel = useHomeDataLabel();

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

    return (
        <>
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                    <UserAvatar size="lg" userId={ownerId} imageUrl={avatarUrl} />
                    <h2 className="text-xl font-medium truncate">{team.name}</h2>
                </div>
                {!editing && (
                    <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                        <Pencil className="h-4 w-4 mr-1" />
                        Edit
                    </Button>
                )}
            </div>

            {editing ? (
                <TeamSettingsForm
                    team={team}
                    organizationId={organizationId}
                    saved={{
                        name: team.name,
                        calendarEnabled,
                        calendarPermission,
                        notifyMembers,
                        homeDataMaxMB: overrides?.homeDataMaxMB?.toString() ?? '',
                        mountMaxMB: overrides?.defaultMountMaxSizeMB?.toString() ?? '',
                    }}
                    defaultCalendar={defaultCal}
                    avatarUrl={avatarUrl}
                    onAvatarChange={() => setAvatarUrl(`p/avatar/${ownerId}?v=${Date.now()}`)}
                    onDone={() => setEditing(false)}
                />
            ) : (
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Calendar</span>
                        <span className="text-sm">
                            {calendarEnabled
                                ? `Enabled (${CALENDAR_PERMISSION_LABELS[calendarPermission]})`
                                : 'Disabled'}
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

type TeamSettingsFormProps = {
    team: OrgTeam;
    organizationId: string;
    saved: TeamSettingsDraft;
    defaultCalendar: CalendarItem | undefined;
    avatarUrl: string;
    onAvatarChange: () => void;
    onDone: () => void;
};

// Mounted with Edit, so each opening starts from the team as it is saved.
function TeamSettingsForm({
    team,
    organizationId,
    saved,
    defaultCalendar,
    avatarUrl,
    onAvatarChange,
    onDone,
}: TeamSettingsFormProps) {
    const ownerId = teamOwnerId(team.id);
    const [initial] = useState(saved);
    const [draft, setDraft] = useState(saved);
    const save = useSaveTeamSettings(team.id, organizationId);
    const uploadAvatar = useUploadTeamAvatar(team.id);
    const removeAvatar = useRemoveTeamAvatar(team.id);
    const homeDataLabel = useHomeDataLabel();
    const id = useId();

    const update = (patch: Partial<TeamSettingsDraft>) => setDraft((prev) => ({ ...prev, ...patch }));
    const name = draft.name.trim();
    const homeDataTooSmall = draft.homeDataMaxMB !== '' && Number(draft.homeDataMaxMB) < QUOTA_MIN_MB;
    const mountTooSmall = draft.mountMaxMB !== '' && Number(draft.mountMaxMB) < QUOTA_MIN_MB;

    const changed = JSON.stringify(draft) !== JSON.stringify(initial);

    const handleSave = async () => {
        if (!changed) {
            onDone();
            return;
        }
        if (!name || homeDataTooSmall || mountTooSmall) return false;
        const existingShares = (defaultCalendar?.shares ?? []).filter((s) => s.targetId !== ownerId);
        // Members read their team's calendar without a share row, so Can view drops the team's row.
        const shares =
            draft.calendarPermission === 'read'
                ? existingShares.length > 0
                    ? existingShares
                    : null
                : [...existingShares, { targetId: ownerId, permission: draft.calendarPermission }];
        await save.mutateAsync({
            name: name !== team.name ? name : undefined,
            calendar: defaultCalendar && draft.calendarEnabled ? { id: defaultCalendar.id, shares } : undefined,
            settings: {
                calendar: { enabled: draft.calendarEnabled },
                notifyMembers: draft.notifyMembers,
                memberOverrides: {
                    homeDataMaxMB: draft.homeDataMaxMB ? Number(draft.homeDataMaxMB) : undefined,
                    defaultMountMaxSizeMB: draft.mountMaxMB ? Number(draft.mountMaxMB) : undefined,
                },
            },
        });
        onDone();
    };

    return (
        <div className="border rounded-lg p-4">
            <PageForm changed={changed} onSubmit={handleSave} onCancel={onDone} submitLabel="Save">
                <div className="space-y-1.5">
                    <Label>Avatar</Label>
                    <AvatarEditor
                        className="h-24 w-24"
                        userId={ownerId}
                        imageUrl={avatarUrl}
                        onUpload={(file) => uploadAvatar.mutate(file, { onSuccess: onAvatarChange })}
                        onRemove={() => removeAvatar.mutate(undefined, { onSuccess: onAvatarChange })}
                    />
                </div>

                <RequiredTextField
                    label="Team name"
                    value={draft.name}
                    onChange={(name) => update({ name })}
                    message={FIELD_MESSAGES.nameMissing}
                />

                <Separator />

                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <Label htmlFor={`${id}-calendar`}>Calendar</Label>
                        <Switch
                            id={`${id}-calendar`}
                            checked={draft.calendarEnabled}
                            onCheckedChange={(calendarEnabled) => update({ calendarEnabled })}
                        />
                    </div>
                    {draft.calendarEnabled && (
                        <div className="flex items-center justify-between">
                            <Label htmlFor={`${id}-member-access`}>Member access</Label>
                            <Select
                                value={draft.calendarPermission}
                                onValueChange={(value) =>
                                    update({
                                        calendarPermission:
                                            CALENDAR_SHARE_PERMISSIONS.find((permission) => permission === value) ??
                                            'read',
                                    })
                                }
                            >
                                <SelectTrigger id={`${id}-member-access`} className="w-32">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {Object.entries(CALENDAR_PERMISSION_LABELS).map(([permission, label]) => (
                                        <SelectItem key={permission} value={permission}>
                                            {label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                    <Label htmlFor={`${id}-notify`}>Notify members</Label>
                    <Switch
                        id={`${id}-notify`}
                        checked={draft.notifyMembers}
                        onCheckedChange={(notifyMembers) => update({ notifyMembers })}
                    />
                </div>

                <Separator />

                <SettingsSection
                    title="Quota overrides"
                    description="Override server defaults for members of this team. Leave empty to inherit."
                >
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1.5">
                            <Label htmlFor={`${id}-home-data`}>{homeDataLabel} (MB)</Label>
                            <Input
                                id={`${id}-home-data`}
                                type="number"
                                min={QUOTA_MIN_MB}
                                placeholder="Inherit"
                                value={draft.homeDataMaxMB}
                                onChange={(e) => update({ homeDataMaxMB: e.target.value })}
                                aria-invalid={homeDataTooSmall || undefined}
                                aria-describedby={homeDataTooSmall ? `${id}-home-data-error` : undefined}
                            />
                            {homeDataTooSmall && (
                                <FieldError id={`${id}-home-data-error`}>At least {QUOTA_MIN_MB} MB</FieldError>
                            )}
                        </div>
                        <div className="space-y-1.5">
                            <Label htmlFor={`${id}-mount`}>Default mount (MB)</Label>
                            <Input
                                id={`${id}-mount`}
                                type="number"
                                min={QUOTA_MIN_MB}
                                placeholder="Inherit"
                                value={draft.mountMaxMB}
                                onChange={(e) => update({ mountMaxMB: e.target.value })}
                                aria-invalid={mountTooSmall || undefined}
                                aria-describedby={mountTooSmall ? `${id}-mount-error` : undefined}
                            />
                            {mountTooSmall && (
                                <FieldError id={`${id}-mount-error`}>At least {QUOTA_MIN_MB} MB</FieldError>
                            )}
                        </div>
                    </div>
                </SettingsSection>
            </PageForm>
        </div>
    );
}
