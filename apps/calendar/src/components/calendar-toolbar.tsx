// The toolbar above Calendar's views: Today, previous and next, the title with the view's days, and the view choice.
// On a phone, Today folds into a kebab menu and the sidebar picks the view. The URL holds the view and its focused
// day, so each control navigates to a new one, and switching the view keeps the day.

import { useNavigate } from '@tanstack/react-router';
import type { CalendarViewMode } from '@workspace/lib/calendar';
import {
    CALENDAR_VIEW_LABELS,
    CALENDAR_VIEW_MODES,
    isCalendarViewMode,
    stepFocus,
    toLocalDateString,
    viewTitle,
} from '@workspace/lib/calendar';
import { Button } from '@workspace/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { useLayout } from '@workspace/ui/components/layout/app';
import { KebabTrigger, Toolbar, ToolbarTitle, TooltipButton } from '@workspace/ui/components/layout/toolbar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const VIEW_OPTIONS = CALENDAR_VIEW_MODES.map((value) => ({ value, label: CALENDAR_VIEW_LABELS[value] }));

type CalendarToolbarProps = {
    mode: CalendarViewMode;
    focus: Date;
};

export function CalendarToolbar({ mode, focus }: CalendarToolbarProps) {
    const { isMobile } = useLayout();
    const navigate = useNavigate();
    const show = (nextMode: CalendarViewMode, day: Date) =>
        navigate({ to: '/view/$mode/$date', params: { mode: nextMode, date: toLocalDateString(day) } });
    // Today is read at the click, so a tab left open past midnight doesn't go to yesterday.
    const showToday = () => show(mode, new Date());
    const step = CALENDAR_VIEW_LABELS[mode].toLowerCase();

    return (
        <Toolbar>
            <div className="flex items-center gap-2">
                {!isMobile && (
                    <Button variant="outline" size="sm" onClick={showToday}>
                        Today
                    </Button>
                )}
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
                <ToolbarTitle className="text-lg">{viewTitle(mode, focus)}</ToolbarTitle>
            </div>

            {isMobile ? (
                <DropdownMenu>
                    <KebabTrigger title="View options" />
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={showToday}>Today</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
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
