import { useNavigate } from '@tanstack/react-router';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import {
    getMonthRange,
    getWeekRange,
    useCalendars,
    useExportCalendar,
    useImportCalendar,
    useImportCalendarFromDevice,
    useSharedCalendarLabel,
    useSharedCalendars,
    useUpdateCalendar,
    useUpdateSharedCalendar,
} from '@workspace/lib/calendar';
import { parseOwnerId } from '@workspace/lib/types';
import type { CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { ICS_ACCEPT, isIcsFile } from '@workspace/lib/types/drive';
import { KebabTrigger, SidebarBody, SidebarItem, SidebarSection, TooltipButton } from '@workspace/ui';
import { FileImportPicker } from '@workspace/ui/components/drive/file-import-picker';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { StorageUsage } from '@workspace/ui/components/home';
import { SidebarPrimaryButton } from '@workspace/ui/components/layout/sidebar/sidebar-primary-button';
import { cn } from '@workspace/ui/lib/utils';
import { CalendarDays, CalendarPlus, CalendarRange, Check, Download, Pencil, Plus, Upload } from 'lucide-react';
import { type MouseEvent, useMemo, useState } from 'react';
import { CalendarConfigDialog } from './calendar-config-dialog';
import { CreateEventDialog } from './create-event-dialog';
import { SharedCalendarConfigDialog } from './shared-calendar-config-dialog';

type CalendarSidebarProps = {
    condensed?: boolean;
};

function CalendarCheckbox({ color, checked, onChange }: { color: string; checked: boolean; onChange: () => void }) {
    return (
        <button
            type="button"
            className={cn(
                'h-4 w-4 rounded-sm border-2 flex items-center justify-center shrink-0 transition-colors',
                checked ? 'border-transparent' : 'border-muted-foreground/40',
            )}
            style={{ backgroundColor: checked ? color : 'transparent' }}
            onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onChange();
            }}
        >
            {checked && <Check className="h-3 w-3 text-white" />}
        </button>
    );
}

// No onExport means the calendar cannot be downloaded here: it lives in another user's home, or the viewer is a guest.
// No onImport means nothing can be brought in either: the same two cases, plus a team calendar the viewer may only read.
function CalendarRow({
    color,
    label,
    checked,
    condensed,
    onToggle,
    onEdit,
    onImport,
    onExport,
}: {
    color: string;
    label: string;
    checked: boolean;
    condensed: boolean;
    onToggle: () => void;
    onEdit: () => void;
    onImport?: () => void;
    onExport?: () => void;
}) {
    return (
        <div
            className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-md group relative',
                !condensed && 'pr-8 hover:bg-accent',
            )}
        >
            <CalendarCheckbox color={color} checked={checked} onChange={onToggle} />
            {!condensed && (
                <>
                    <span className="text-sm truncate flex-1">{label}</span>
                    {/* focus-within holds the trigger visible while its own menu is open. */}
                    <div className="absolute right-2 opacity-0 group-hover:opacity-80 hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-80">
                        <DropdownMenu>
                            <KebabTrigger title="Calendar options" />
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={onEdit}>
                                    <Pencil className="h-4 w-4 mr-2" /> Edit calendar
                                </DropdownMenuItem>
                                {onImport && (
                                    <DropdownMenuItem onClick={onImport}>
                                        <Upload className="h-4 w-4 mr-2" /> Import events…
                                    </DropdownMenuItem>
                                )}
                                {onExport && (
                                    <DropdownMenuItem onClick={onExport}>
                                        <Download className="h-4 w-4 mr-2" /> Export calendar
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </>
            )}
        </div>
    );
}

export function CalendarSidebar({ condensed = false }: CalendarSidebarProps) {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const { data: calendars = [], isLoading: calendarsLoading } = useCalendars(ownerId);
    const { data: sharedCalendars = [], isLoading: sharedLoading } = useSharedCalendars(ownerId);
    const updateCalendar = useUpdateCalendar(ownerId);
    const updateSharedCalendar = useUpdateSharedCalendar(ownerId);
    const { exportCalendar } = useExportCalendar();
    const importCalendar = useImportCalendar();
    const importFromDevice = useImportCalendarFromDevice();
    const isGuest = useIsGuest();
    const navigate = useNavigate();

    const [configCalendar, setConfigCalendar] = useState<CalendarItem | null>(null);
    const [configDialogOpen, setConfigDialogOpen] = useState(false);
    const [createCalendarOpen, setCreateCalendarOpen] = useState(false);

    const [configSharedCalendar, setConfigSharedCalendar] = useState<SharedCalendar | null>(null);
    const [sharedConfigDialogOpen, setSharedConfigDialogOpen] = useState(false);
    const [createEventOpen, setCreateEventOpen] = useState(false);
    // The calendar the picked file goes into; null while no import dialog is open.
    const [importTarget, setImportTarget] = useState<{ ownerId: string; calendarId: string } | null>(null);

    const { personalShared, teamShared } = useMemo(() => {
        const personal: SharedCalendar[] = [];
        const team: SharedCalendar[] = [];
        for (const sc of sharedCalendars) {
            const parsed = parseOwnerId(sc.ownerUserId);
            if (parsed.type === 'team') {
                team.push(sc);
            } else {
                personal.push(sc);
            }
        }
        return { personalShared: personal, teamShared: team };
    }, [sharedCalendars]);

    const sharedCalendarLabel = useSharedCalendarLabel(teamShared);

    const handleEditCalendar = (cal: CalendarItem) => {
        setConfigCalendar(cal);
        setConfigDialogOpen(true);
    };

    const handleCreateCalendar = () => {
        setConfigCalendar(null);
        setCreateCalendarOpen(true);
    };

    const handleEditSharedCalendar = (sc: SharedCalendar) => {
        setConfigSharedCalendar(sc);
        setSharedConfigDialogOpen(true);
    };

    // Recomputed at click time: a tab left open across midnight would navigate to yesterday's period.
    const navigateToCurrentPeriod = (e: MouseEvent, mode: 'month' | 'week') => {
        e.preventDefault();
        const range = mode === 'month' ? getMonthRange(new Date()) : getWeekRange(new Date());
        navigate({
            to: '/view/$mode/$from/$to',
            params: { mode, from: String(range.from), to: String(range.to) },
            search: { eventId: undefined },
        });
    };
    const monthRange = getMonthRange(new Date());
    const weekRange = getWeekRange(new Date());

    return (
        <>
            <SidebarBody>
                <SidebarPrimaryButton
                    icon={CalendarPlus}
                    label="Create event"
                    condensed={condensed}
                    onClick={() => setCreateEventOpen(true)}
                />

                <SidebarSection condensed={condensed}>
                    <SidebarItem
                        icon={<CalendarDays className="h-4 w-4" />}
                        label="View Month"
                        to="/view/$mode/$from/$to"
                        params={{ mode: 'month', from: String(monthRange.from), to: String(monthRange.to) }}
                        onClick={(e) => navigateToCurrentPeriod(e, 'month')}
                        condensed={condensed}
                    />
                    <SidebarItem
                        icon={<CalendarRange className="h-4 w-4" />}
                        label="View Week"
                        to="/view/$mode/$from/$to"
                        params={{ mode: 'week', from: String(weekRange.from), to: String(weekRange.to) }}
                        onClick={(e) => navigateToCurrentPeriod(e, 'week')}
                        condensed={condensed}
                    />
                </SidebarSection>

                <div className="overflow-auto flex-1">
                    <SidebarSection
                        condensed={condensed}
                        title="My Calendars"
                        loading={calendarsLoading}
                        action={
                            <TooltipButton icon={Plus} tooltipText="Add new calendar" onClick={handleCreateCalendar} />
                        }
                    >
                        {calendars.map((cal) => (
                            <CalendarRow
                                key={cal.id}
                                color={cal.color}
                                label={cal.name}
                                checked={cal.visible}
                                condensed={condensed}
                                onToggle={() => updateCalendar.mutate({ id: cal.id, visible: !cal.visible })}
                                onEdit={() => handleEditCalendar(cal)}
                                onImport={isGuest ? undefined : () => setImportTarget({ ownerId, calendarId: cal.id })}
                                onExport={isGuest ? undefined : () => void exportCalendar(ownerId, cal.id)}
                            />
                        ))}
                    </SidebarSection>

                    {personalShared.length > 0 && (
                        <SidebarSection condensed={condensed} title="Shared with me" loading={sharedLoading}>
                            {personalShared.map((sc) => (
                                <CalendarRow
                                    key={sc.id}
                                    color={sc.color || sc.calendarColor}
                                    label={sc.calendarName}
                                    checked={sc.visible}
                                    condensed={condensed}
                                    onToggle={() => updateSharedCalendar.mutate({ id: sc.id, visible: !sc.visible })}
                                    onEdit={() => handleEditSharedCalendar(sc)}
                                />
                            ))}
                        </SidebarSection>
                    )}

                    {teamShared.length > 0 && (
                        <SidebarSection condensed={condensed} title="Team Calendars" loading={sharedLoading}>
                            {teamShared.map((sc) => {
                                const display = {
                                    ...sc,
                                    calendarName: sharedCalendarLabel(sc),
                                };
                                return (
                                    <CalendarRow
                                        key={sc.id}
                                        color={display.color || display.calendarColor}
                                        label={display.calendarName}
                                        checked={display.visible}
                                        condensed={condensed}
                                        onToggle={() =>
                                            updateSharedCalendar.mutate({ id: sc.id, visible: !sc.visible })
                                        }
                                        onEdit={() => handleEditSharedCalendar(display)}
                                        onImport={
                                            isGuest || sc.permission !== 'write'
                                                ? undefined
                                                : () =>
                                                      setImportTarget({
                                                          ownerId: sc.ownerUserId,
                                                          calendarId: sc.calendarId,
                                                      })
                                        }
                                        onExport={
                                            isGuest
                                                ? undefined
                                                : () => void exportCalendar(sc.ownerUserId, sc.calendarId)
                                        }
                                    />
                                );
                            })}
                        </SidebarSection>
                    )}
                </div>

                <StorageUsage className="mt-auto" condensed={condensed} />
            </SidebarBody>

            <CalendarConfigDialog
                open={configDialogOpen}
                onOpenChange={setConfigDialogOpen}
                calendar={configCalendar}
            />

            <CalendarConfigDialog
                open={createCalendarOpen}
                onOpenChange={setCreateCalendarOpen}
                calendar={null}
                calendarCount={calendars.length + sharedCalendars.length}
            />

            <SharedCalendarConfigDialog
                open={sharedConfigDialogOpen}
                onOpenChange={setSharedConfigDialogOpen}
                sharedCalendar={configSharedCalendar}
            />

            <CreateEventDialog open={createEventOpen} onOpenChange={setCreateEventOpen} />

            {importTarget && (
                <FileImportPicker
                    open
                    onOpenChange={(open) => {
                        if (!open) setImportTarget(null);
                    }}
                    title="Import events"
                    accept={ICS_ACCEPT}
                    canPick={(item) => isIcsFile(item.mimeType, item.name)}
                    onDeviceFile={(file) => importFromDevice.mutate({ file, ...importTarget })}
                    onDrivePick={(item) =>
                        importCalendar.mutate({
                            drive: { sourceOwnerId: item.ownerId, sourceMountId: item.mountId, sourcePathId: item.id },
                            ...importTarget,
                        })
                    }
                />
            )}
        </>
    );
}
