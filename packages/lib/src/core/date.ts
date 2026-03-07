export function formatTime(date: Date): string {
    return new Date(date).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

export function formatDate(date: Date): string {
    return new Date(date).toLocaleDateString([], {month: 'short', day: 'numeric'});
}

export function formatDateTime(date: Date): string {
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
        return formatTime(date);
    }

    return formatDate(date);
}
