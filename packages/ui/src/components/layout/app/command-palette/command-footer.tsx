export function CommandFooter() {
    return (
        <div className="flex items-center gap-3 app-gutter-x py-2 text-xs text-muted-foreground border-t">
            <span>↑↓ navigate</span>
            <span>↵ open</span>
            <span>Tab scope</span>
            <span className="ml-auto">esc close</span>
        </div>
    );
}
