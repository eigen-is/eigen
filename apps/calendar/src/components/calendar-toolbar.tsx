// The toolbar above Calendar's views: Today, previous and next, the title with the view's days, and the view choice.
// On a phone, Today folds into a kebab menu, the arrows sit beside it, away from the column's back, and the sidebar
// picks the view. The URL holds the view and its focused day, so each control navigates to a new one, and switching
// the view keeps the day. It also binds Google's keys for the same moves, and c for New event, while no dialog or menu
// is open and the focus is not in the event's column.

import type { CalendarViewMode } from '@workspace/lib/calendar';
import {
    CALENDAR_VIEW_LABELS,
    CALENDAR_VIEW_MODES,
    isCalendarViewMode,
    stepFocus,
    useCalendarShortcuts,
    viewTitle,
} from '@workspace/lib/calendar';
import { Button } from '@workspace/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { useLayout } from '@workspace/ui/components/layout/app';
import { KebabTrigger, Toolbar, ToolbarTitle, TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { useDialogOpen, useMenuOpen } from '@workspace/ui/hooks/use-dialog-open';
import { useFocusInDetail } from '@workspace/ui/hooks/use-focus-in-detail';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useShowView } from './hooks/use-show-view';

const VIEW_OPTIONS = CALENDAR_VIEW_MODES.map((value) => ({ value, label: CALENDAR_VIEW_LABELS[value] }));

type CalendarToolbarProps = {
    mode: CalendarViewMode;
    focus: Date;
    onCreateEvent: () => void;
};

export function CalendarToolbar({ mode, focus, onCreateEvent }: CalendarToolbarProps) {
    const { isMobile } = useLayout();
    const show = useShowView();
    // Today is read at the press, so a tab left open past midnight doesn't go to yesterday.
    const showToday = () => show(mode, new Date());
    const step = CALENDAR_VIEW_LABELS[mode].toLowerCase();
    const dialogOpen = useDialogOpen();
    const menuOpen = useMenuOpen();
    const focusInDetail = useFocusInDetail();
    useCalendarShortcuts({
        mode,
        focus,
        show,
        showToday,
        create: onCreateEvent,
        enabled: !dialogOpen && !menuOpen && !focusInDetail,
    });

    const arrows = (
        <div className="flex items-center">
            <TooltipButton
                icon={ChevronLeft}
                tooltipText={`Previous ${step}`}
                onClick={() => show(mode, stepFocus(mode, focus, -1))}
            />
            <TooltipButton
                icon={ChevronRight}
                tooltipText={`Next ${step}`}
                onClick={() => show(mode, stepFocus(mode, focus, 1))}
            />
        </div>
    );

    return (
        <Toolbar>
            <div className="flex items-center gap-2">
                {!isMobile && (
                    <Button variant="outline" size="sm" onClick={showToday}>
                        Today
                    </Button>
                )}
                {!isMobile && arrows}
                <ToolbarTitle className="text-lg">{viewTitle(mode, focus)}</ToolbarTitle>
            </div>

            {isMobile ? (
                <div className="flex items-center">
                    {arrows}
                    <DropdownMenu>
                        <KebabTrigger title="View options" />
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={showToday}>Today</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            ) : (
                <Select
                    value={mode}
                    onValueChange={(value) => {
                        if (isCalendarViewMode(value)) show(value, focus);
                    }}
                >
                    <SelectTrigger className="w-28 h-8">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {VIEW_OPTIONS.map(({ value, label }) => (
                            <SelectItem key={value} value={value}>
                                {label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}
        </Toolbar>
    );
}
