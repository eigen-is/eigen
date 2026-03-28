type AccessDeniedProps = {
    message?: string;
};

export function AccessDenied({
                                 message = 'Encountering the null vector: a rendezvous with nothing at all.',
}: AccessDeniedProps) {
    return (
        <div className="flex flex-col items-center justify-center h-full w-full gap-4 p-8 text-center">
            <p className="text-muted-foreground">{message}</p>
        </div>
    );
}
