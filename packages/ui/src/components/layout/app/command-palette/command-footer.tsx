export function CommandFooter() {
    return (
        <div className="flex items-center gap-3 px-3 py-2 text-xs text-muted-foreground border-t">
            <span>↑↓ navigate</span>
            <span>↵ open</span>
            <span>Tab scope</span>
            <span className="ml-auto">esc close</span>
        </div>
    );
}
