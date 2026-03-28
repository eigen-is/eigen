import { useAuth } from '@workspace/lib/auth';
import { useCalendars, useSharedCalendars, useUpdateCalendar, useUpdateSharedCalendar } from '@workspace/lib/calendar';
import { usePeopleTeams } from '@workspace/lib/people';
import { usePublicConfig } from '@workspace/lib/public';
import { parseOwnerId } from '@workspace/lib/types';
import type { CalendarItem, SharedCalendar } from '@workspace/lib/types/calendar';
import { EigenLoader, StorageUsage, TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { SidebarHeader } from '@workspace/ui/components/layout/sidebar/sidebar-header';
import { SidebarSection } from '@workspace/ui/components/layout/sidebar/sidebar-section';
import { Separator } from '@workspace/ui/components/separator';
import { cn } from '@workspace/ui/lib/utils';
import { CalendarPlus, Check, Pencil, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CalendarConfigDialog } from './calendar-config-dialog';
import { CreateEventDialog } from './create-event-dialog';
import { SharedCalendarConfigDialog } from './shared-calendar-config-dialog';

type CalendarSidebarProps = {
    condensed?: boolean;
    isMobile?: boolean;
    onClose?: () => void;
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

function SharedCalendarItem({
    sc,
    condensed,
    onToggle,
    onEdit,
}: {
    sc: SharedCalendar;
    condensed: boolean;
    onToggle: () => void;
    onEdit: () => void;
    label?: string;
}) {
    return (
        <div
            className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-md group relative',
                !condensed && 'pr-8 hover:bg-accent',
            )}
        >
            <CalendarCheckbox color={sc.color || sc.calendarColor} checked={sc.visible} onChange={onToggle} />
            {!condensed && (
                <>
                    <span className="text-sm truncate flex-1">{sc.calendarName}</span>
                    <div className="absolute right-2 opacity-0 group-hover:opacity-80 hover:opacity-100">
                        <TooltipButton
                            icon={Pencil}
                            tooltipText="Edit calendar"
                            variant="ghost"
                            size="icon"
                            onClick={onEdit}
                        />
                    </div>
                </>
            )}
        </div>
    );
}

export function CalendarSidebar({ condensed = false, isMobile = false, onClose }: CalendarSidebarProps) {
    const { user } = useAuth();
    const ownerId = user?.id || '';
    const { data: calendars = [], isLoading: calendarsLoading } = useCalendars(ownerId);
    const { data: sharedCalendars = [], isLoading: sharedLoading } = useSharedCalendars(ownerId);
    const { data: config } = usePublicConfig();
    const { data: teams } = usePeopleTeams(config?.orgId);
    const updateCalendar = useUpdateCalendar(ownerId);
    const updateSharedCalendar = useUpdateSharedCalendar(ownerId);

    const [configCalendar, setConfigCalendar] = useState<CalendarItem | null>(null);
    const [configDialogOpen, setConfigDialogOpen] = useState(false);
    const [createCalendarOpen, setCreateCalendarOpen] = useState(false);

    const [configSharedCalendar, setConfigSharedCalendar] = useState<SharedCalendar | null>(null);
    const [sharedConfigDialogOpen, setSharedConfigDialogOpen] = useState(false);
    const [createEventOpen, setCreateEventOpen] = useState(false);

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

    const getTeamName = (ownerUserId: string) => {
        const parsed = parseOwnerId(ownerUserId);
        return teams?.find((t) => t.id === parsed.id)?.name || ownerUserId;
    };

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

    return (
        <div className="h-full flex flex-col bg-background">
            {isMobile && <SidebarHeader appName="calendar" onClose={onClose} />}

            <div className="px-3 py-2">
                <Button
                    variant="default"
                    size={condensed ? 'icon' : 'default'}
                    className={cn(condensed ? 'w-10 p-0' : 'w-full justify-start gap-3')}
                    onClick={() => setCreateEventOpen(true)}
                >
                    <CalendarPlus className="h-4 w-4" />
                    {!condensed && <span>Create event</span>}
                </Button>
            </div>

            <div className="overflow-auto flex-1">
                <SidebarSection condensed={condensed}>
                    <div className={cn('flex items-center mb-1', condensed ? 'justify-center' : 'justify-between')}>
                        {!condensed && (
                            <h3 className="text-sm font-semibold text-foreground px-3 select-none">My Calendars</h3>
                        )}
                        <TooltipButton icon={Plus} tooltipText="Add new calendar" onClick={handleCreateCalendar} />
                    </div>

                    {calendarsLoading ? (
                        <EigenLoader />
                    ) : (
                        <div className="space-y-0.5">
                            {calendars.map((cal) => (
                                <div
                                    key={cal.id}
                                    className={cn(
                                        'flex items-center gap-2 px-3 py-1.5 rounded-md group relative',
                                        !condensed && 'pr-8 hover:bg-accent',
                                    )}
                                >
                                    <CalendarCheckbox
                                        color={cal.color}
                                        checked={cal.visible}
                                        onChange={() => updateCalendar.mutate({ id: cal.id, visible: !cal.visible })}
                                    />
                                    {!condensed && (
                                        <>
                                            <span className="text-sm truncate flex-1">{cal.name}</span>
                                            <div className="absolute right-2 opacity-0 group-hover:opacity-80 hover:opacity-100">
                                                <TooltipButton
                                                    icon={Pencil}
                                                    tooltipText="Edit calendar"
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => handleEditCalendar(cal)}
                                                />
                                            </div>
                                        </>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </SidebarSection>

                {personalShared.length > 0 && (
                    <>
                        <Separator />
                        <SidebarSection condensed={condensed}>
                            <div
                                className={cn(
                                    'flex items-center mb-1',
                                    condensed ? 'justify-center' : 'justify-between',
                                )}
                            >
                                {!condensed && (
                                    <h3 className="text-sm font-semibold text-foreground px-3 select-none">
                                        Shared with me
                                    </h3>
                                )}
                            </div>

                            {sharedLoading ? (
                                <EigenLoader />
                            ) : (
                                <div className="space-y-0.5">
                                    {personalShared.map((sc) => (
                                        <SharedCalendarItem
                                            key={sc.id}
                                            sc={sc}
                                            condensed={condensed}
                                            onToggle={() =>
                                                updateSharedCalendar.mutate({ id: sc.id, visible: !sc.visible })
                                            }
                                            onEdit={() => handleEditSharedCalendar(sc)}
                                        />
                                    ))}
                                </div>
                            )}
                        </SidebarSection>
                    </>
                )}

                {teamShared.length > 0 && (
                    <>
                        <Separator />
                        <SidebarSection condensed={condensed}>
                            <div
                                className={cn(
                                    'flex items-center mb-1',
                                    condensed ? 'justify-center' : 'justify-between',
                                )}
                            >
                                {!condensed && (
                                    <h3 className="text-sm font-semibold text-foreground px-3 select-none">
                                        Team Calendars
                                    </h3>
                                )}
                            </div>

                            {sharedLoading ? (
                                <EigenLoader />
                            ) : (
                                <div className="space-y-0.5">
                                    {teamShared.map((sc) => {
                                        const display = { ...sc, calendarName: getTeamName(sc.ownerUserId) };
                                        return (
                                            <SharedCalendarItem
                                                key={sc.id}
                                                sc={display}
                                                condensed={condensed}
                                                onToggle={() =>
                                                    updateSharedCalendar.mutate({ id: sc.id, visible: !sc.visible })
                                                }
                                                onEdit={() => handleEditSharedCalendar(display)}
                                            />
                                        );
                                    })}
                                </div>
                            )}
                        </SidebarSection>
                    </>
                )}
            </div>

            <StorageUsage className="mt-auto" condensed={condensed} />

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
        </div>
    );
}
