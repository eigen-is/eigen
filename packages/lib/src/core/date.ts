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
