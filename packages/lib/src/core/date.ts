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
    return new Date(date).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function formatDateTime(date: Date | string | number): string {
    const d = new Date(date);
    const isToday = d.toDateString() === new Date().toDateString();

    if (isToday) {
        return formatTime(d);
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
    const datePart = d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
    return `${datePart} at ${formatTime(d)}`;
}

export function formatInputDate(date: Date | string | number): string {
    return new Date(date).toISOString().slice(0, 10);
}

export function formatEventWhen(
    startEpoch: number,
    endEpoch: number,
    allDay: boolean,
    timezone?: string | null,
): string {
    const tz = timezone || 'UTC';
    const dateOpts: Intl.DateTimeFormatOptions = {
        weekday: 'long',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: tz,
    };
    const timeOpts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', timeZone: tz };
    const start = new Date(startEpoch * 1000);
    const end = new Date(endEpoch * 1000);
    const sameDay =
        start.toLocaleDateString('en-GB', { timeZone: tz }) === end.toLocaleDateString('en-GB', { timeZone: tz });

    if (allDay) {
        const startStr = start.toLocaleDateString('en-GB', dateOpts);
        if (sameDay) return startStr;
        return `${startStr} – ${end.toLocaleDateString('en-GB', dateOpts)}`;
    }
    if (sameDay) {
        return `${start.toLocaleDateString('en-GB', dateOpts)} · ${start.toLocaleTimeString('en-GB', timeOpts)} – ${end.toLocaleTimeString('en-GB', timeOpts)}`;
    }
    return `${start.toLocaleString('en-GB', { ...dateOpts, ...timeOpts })} – ${end.toLocaleString('en-GB', { ...dateOpts, ...timeOpts })}`;
}
