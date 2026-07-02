export function formatTime(date: Date | string | number): string {
    const d = new Date(date);
    const h = d.getHours();
    const m = d.getMinutes();
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 || 12;
    if (m === 0) return `${hour} ${ampm}`;
    return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}

export function formatDate(date: Date | string | number): string {
    return new Date(date).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

// "Jun 8, 2026" for a bare YYYY-MM-DD calendar date. Parses the parts as a *local* date —
// `new Date("2026-06-08")` reads the string as UTC midnight, which renders the day before for
// viewers west of UTC and mismatches between prerender (build TZ) and hydration (viewer TZ).
export function formatDateOnly(isoDate: string): string {
    const [year, month, day] = isoDate.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(date: Date | string | number): string {
    const d = new Date(date);
    const isToday = d.toDateString() === new Date().toDateString();
    const isSameYear = d.getFullYear() === new Date().getFullYear();

    if (isToday) {
        return `Today, ${formatTime(d)}`;
    }
    if (isSameYear) {
        return `${d.toLocaleDateString('en', { month: 'short', day: 'numeric' })}, ${formatTime(d)}`;
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

// Calendar rows stored before TZID ingestion-normalization can hold a non-IANA zone that makes Intl
// throw RangeError; this shared FE+BE code can't import the api-side normalizeTimezone, so it
// degrades to UTC locally using the same Intl-construction oracle.
function safeTimeZone(timezone?: string | null): string {
    if (!timezone) return 'UTC';
    try {
        new Intl.DateTimeFormat('en', { timeZone: timezone });
        return timezone;
    } catch {
        return 'UTC';
    }
}

export function formatEventWhen(start: Date, end: Date, allDay: boolean, timezone?: string | null): string {
    const tz = safeTimeZone(timezone);
    const dateOpts: Intl.DateTimeFormatOptions = {
        weekday: 'long',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: tz,
    };
    const timeOpts: Intl.DateTimeFormatOptions = {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: tz,
    };

    if (allDay) {
        // All-day endTime is exclusive (midnight after the last day), so the displayed
        // end date is one day earlier than the stored value.
        const displayEnd = new Date(end.getTime() - 86400_000);
        const startStr = start.toLocaleDateString('en', dateOpts);
        if (
            start.toLocaleDateString('en', { timeZone: tz }) === displayEnd.toLocaleDateString('en', { timeZone: tz })
        ) {
            return startStr;
        }
        return `${startStr} – ${displayEnd.toLocaleDateString('en', dateOpts)}`;
    }

    const sameDay = start.toLocaleDateString('en', { timeZone: tz }) === end.toLocaleDateString('en', { timeZone: tz });
    if (sameDay) {
        return `${start.toLocaleDateString('en', dateOpts)} · ${start.toLocaleTimeString('en', timeOpts)} – ${end.toLocaleTimeString('en', timeOpts)}`;
    }
    return `${start.toLocaleString('en', { ...dateOpts, ...timeOpts })} – ${end.toLocaleString('en', { ...dateOpts, ...timeOpts })}`;
}
