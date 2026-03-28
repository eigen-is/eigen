type ErrorStateProps = {
    message?: string;
    detail?: string;
};

export function ErrorState({message = 'Something went wrong.', detail}: ErrorStateProps) {
    return (
        <div className="flex flex-col items-center justify-center h-full w-full gap-2 p-8 text-center">
            <p className="text-destructive">{message}</p>
            {detail && <p className="text-muted-foreground text-sm">{detail}</p>}
        </div>
    );
}
