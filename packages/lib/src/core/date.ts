export function formatTime(date: Date | string | number): string {
    return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDate(date: Date | string | number): string {
    return new Date(date).toLocaleDateString([], { month: 'short', day: 'numeric' });
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

export function formatDateTime(date: Date | string | number): string {
    const d = new Date(date);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();

    if (isToday) {
        return formatTime(date);
    }

    return formatDate(date);
}
