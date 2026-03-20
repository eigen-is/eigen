export function formatTime(date: Date | string | number): string {
    return new Date(date).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

export function formatDate(date: Date | string | number): string {
    return new Date(date).toLocaleDateString([], {month: 'short', day: 'numeric'});
}

export function formatDateTime(date: Date | string | number): string {
    const d = new Date(date);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();

    if (isToday) {
        return formatTime(date);
    }

    return formatDate(date);
}
