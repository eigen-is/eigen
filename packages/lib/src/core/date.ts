export function formatTime(date: Date | string | number): string {
    const d = new Date(date);
    const h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 || 12;
    if (m === 0) return `${hour} ${ampm}`;
    return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Constructing an Intl.DateTimeFormat costs about as much as formatting a thousand dates, and a Drive
// listing or a month of cards formats one per row. Keyed by the options that make the formatter; the map
// is dropped whole past its cap, because a time zone is a string an .ics file chose.
const DATE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const MAX_DATE_FORMATTERS = 64;

export function dateFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    const key = JSON.stringify(options);
    const cached = DATE_FORMATTERS.get(key);
    if (cached) return cached;
    const formatter = new Intl.DateTimeFormat('en', options);
    if (DATE_FORMATTERS.size >= MAX_DATE_FORMATTERS) DATE_FORMATTERS.clear();
    DATE_FORMATTERS.set(key, formatter);
    return formatter;
}

// Day-month-year from the 'en' locale's parts: 'en-GB' would give the order for free, but its short
// September is "Sept" under full ICU (browsers) and "Sep" under Bun's, so the order is assembled here.
export function formatDayMonth(
    date: Date,
    options: { year?: boolean; weekday?: 'long' | 'short'; timeZone?: string } = {},
): string {
    const parts = dateFormatter({
        weekday: options.weekday,
        day: 'numeric',
        month: 'short',
        year: options.year ? 'numeric' : undefined,
        timeZone: options.timeZone,
    }).formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
    const dayMonth = `${part('day')} ${part('month')}${options.year ? ` ${part('year')}` : ''}`;
    return options.weekday ? `${part('weekday')}, ${dayMonth}` : dayMonth;
}

export function formatDate(date: Date | string | number): string {
    return formatDayMonth(new Date(date), { year: true });
}

// "8 Jun 2026" for a bare YYYY-MM-DD calendar date. Parses the parts as a *local* date —
// `new Date("2026-06-08")` reads the string as UTC midnight, which renders the day before for
// viewers west of UTC and mismatches between prerender (build TZ) and hydration (viewer TZ).
export function formatDateOnly(isoDate: string): string {
    const [year, month, day] = isoDate.split('-').map(Number);
    return formatDayMonth(new Date(year, month - 1, day), { year: true });
}

export function isSameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function isToday(date: Date): boolean {
    return isSameDay(date, new Date());
}

export function formatDateTime(date: Date | string | number): string {
    const d = new Date(date);
    const isSameYear = d.getFullYear() === new Date().getFullYear();

    if (isToday(d)) {
        return `Today, ${formatTime(d)}`;
    }
    if (isSameYear) {
        return `${formatDayMonth(d)}, ${formatTime(d)}`;
    }

    return `${formatDate(d)}, ${formatTime(d)}`;
}

export function formatTimeAgo(date: Date | string | number): string {
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

export function formatFullDateTime(date: Date | string | number): string {
    const d = new Date(date);
    return `${formatDate(d)} at ${formatTime(d)}`;
}

export function formatMonth(date: Date | string | number, style: 'long' | 'short' = 'long'): string {
    return new Date(date).toLocaleDateString('en', { month: style });
}

export function formatInputDate(date: Date | string | number): string {
    return new Date(date).toISOString().slice(0, 10);
}
