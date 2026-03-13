import {useState} from 'react';
import {CalendarPlus, Check, Pencil, Plus, X} from 'lucide-react';
import {Button} from '@workspace/ui/components/button';
import {SidebarSection} from '@workspace/ui/components/layout/sidebar/sidebar-section';
import {Separator} from '@workspace/ui/components/separator';
import {AppLogo} from '@workspace/ui/components/layout/app/app-logo';
import {EigenLoader, StorageUsage, TooltipButton} from '@workspace/ui';
import {useCalendars, useSharedCalendars, useUpdateCalendar, useUpdateSharedCalendar} from '@workspace/lib/calendar';
import {useAuth} from '@workspace/lib/auth';
import type {CalendarItem, SharedCalendar} from '@workspace/lib/types/calendar';
import {CalendarConfigDialog} from './calendar-config-dialog';
import {SharedCalendarConfigDialog} from './shared-calendar-config-dialog';
import {CreateEventDialog} from './create-event-dialog';
import {cn} from '@workspace/ui/lib/utils';

type CalendarSidebarProps = {
    condensed?: boolean;
    isMobile?: boolean;
    onClose?: () => void;
}

function CalendarCheckbox({color, checked, onChange}: {color: string; checked: boolean; onChange: () => void}) {
    return (
        <button
            type="button"
            className={cn(
                'h-4 w-4 rounded-sm border-2 flex items-center justify-center shrink-0 transition-colors',
                checked ? 'border-transparent' : 'border-muted-foreground/40'
            )}
            style={{backgroundColor: checked ? color : 'transparent'}}
            onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onChange();
            }}
        >
            {checked && <Check className="h-3 w-3 text-white"/>}
        </button>
    );
}

export function CalendarSidebar({
    condensed = false,
    isMobile = false,
    onClose,
}: CalendarSidebarProps) {
    const {user} = useAuth();
    const ownerId = user?.id || '';
    const {data: calendars = [], isLoading: calendarsLoading} = useCalendars(ownerId);
    const {data: sharedCalendars = [], isLoading: sharedLoading} = useSharedCalendars(ownerId);
    const updateCalendar = useUpdateCalendar(ownerId);
    const updateSharedCalendar = useUpdateSharedCalendar(ownerId);

    const [configCalendar, setConfigCalendar] = useState<CalendarItem | null>(null);
    const [configDialogOpen, setConfigDialogOpen] = useState(false);
    const [createCalendarOpen, setCreateCalendarOpen] = useState(false);

    const [configSharedCalendar, setConfigSharedCalendar] = useState<SharedCalendar | null>(null);
    const [sharedConfigDialogOpen, setSharedConfigDialogOpen] = useState(false);
    const [createEventOpen, setCreateEventOpen] = useState(false);

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
            {isMobile && (
                <div className="flex items-center h-12 bg-app px-4">
                    <Button variant="ghost" size="icon" onClick={onClose}
                            className="mr-2 text-white hover:bg-primary/20 hover:text-white">
                        <X className="h-5 w-5"/>
                        <span className="sr-only">Close menu</span>
                    </Button>
                    <AppLogo appName="calendar"/>
                </div>
            )}

            <div className="px-3 py-2">
                <Button
                    variant="default"
                    size={condensed ? 'icon' : 'default'}
                    className={cn(condensed ? 'w-10 p-0' : 'w-full justify-start gap-3')}
                    onClick={() => setCreateEventOpen(true)}
                >
                    <CalendarPlus className="h-4 w-4"/>
                    {!condensed && <span>Create event</span>}
                </Button>
            </div>

            <div className="overflow-auto flex-1">
                <SidebarSection condensed={condensed}>
                    <div className={cn(
                        'flex items-center mb-1',
                        condensed ? 'justify-center' : 'justify-between'
                    )}>
                        {!condensed && <h3 className="text-sm font-semibold text-foreground px-3 select-none">My Calendars</h3>}
                        <TooltipButton
                            icon={Plus}
                            tooltipText="Add new calendar"
                            onClick={handleCreateCalendar}
                        />
                    </div>

                    {calendarsLoading ? (
                        <EigenLoader/>
                    ) : (
                        <div className="space-y-0.5">
                            {calendars.map((cal) => (
                                <div
                                    key={cal.id}
                                    className={cn(
                                        'flex items-center gap-2 px-3 py-1.5 rounded-md group relative',
                                        !condensed && 'pr-8 hover:bg-accent'
                                    )}
                                >
                                    <CalendarCheckbox
                                        color={cal.color}
                                        checked={cal.visible}
                                        onChange={() => updateCalendar.mutate({id: cal.id, visible: !cal.visible})}
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

                {sharedCalendars.length > 0 && (
                    <>
                        <Separator/>
                        <SidebarSection condensed={condensed}>
                            <div className={cn(
                                'flex items-center mb-1',
                                condensed ? 'justify-center' : 'justify-between'
                            )}>
                                {!condensed && <h3 className="text-sm font-semibold text-foreground px-3 select-none">Shared with me</h3>}
                            </div>

                            {sharedLoading ? (
                                <EigenLoader/>
                            ) : (
                                <div className="space-y-0.5">
                                    {sharedCalendars.map((sc) => (
                                        <div
                                            key={sc.id}
                                            className={cn(
                                                'flex items-center gap-2 px-3 py-1.5 rounded-md group relative',
                                                !condensed && 'pr-8 hover:bg-accent'
                                            )}
                                        >
                                            <CalendarCheckbox
                                                color={sc.color || sc.calendarColor}
                                                checked={sc.visible}
                                                onChange={() => updateSharedCalendar.mutate({id: sc.id, visible: !sc.visible})}
                                            />
                                            {!condensed && (
                                                <>
                                                    {/* <UserAvatar userId={sc.ownerUserId} size="sm" tooltip className="h-5 w-5 shrink-0"/> */}
                                                    <span className="text-sm truncate flex-1">{sc.calendarName}</span>
                                                    <div className="absolute right-2 opacity-0 group-hover:opacity-80 hover:opacity-100">
                                                        <TooltipButton
                                                            icon={Pencil}
                                                            tooltipText="Edit shared calendar"
                                                            variant="ghost"
                                                            size="icon"
                                                            onClick={() => handleEditSharedCalendar(sc)}
                                                        />
                                                    </div>
                                                </>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </SidebarSection>
                    </>
                )}
            </div>

            <StorageUsage className="mt-auto" condensed={condensed}/>

            <CalendarConfigDialog
                open={configDialogOpen}
                onOpenChange={setConfigDialogOpen}
                calendar={configCalendar}
            />

            <CalendarConfigDialog
                open={createCalendarOpen}
                onOpenChange={setCreateCalendarOpen}
                calendar={null}
            />

            <SharedCalendarConfigDialog
                open={sharedConfigDialogOpen}
                onOpenChange={setSharedConfigDialogOpen}
                sharedCalendar={configSharedCalendar}
            />

            <CreateEventDialog
                open={createEventOpen}
                onOpenChange={setCreateEventOpen}
            />
        </div>
    );
}
