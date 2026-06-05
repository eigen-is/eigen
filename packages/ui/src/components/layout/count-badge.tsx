export function CountBadge({ count }: { count: number }) {
    if (count <= 0) return null;
    return (
        <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-0.5 text-[9px] font-medium text-white pointer-events-none"
        >
            {count > 99 ? '99+' : count}
        </span>
    );
}
