export function CountBadge({ count }: { count: number }) {
    if (count <= 0) return null;
    return (
        <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground pointer-events-none">
            {count > 99 ? '99+' : count}
        </span>
    );
}
