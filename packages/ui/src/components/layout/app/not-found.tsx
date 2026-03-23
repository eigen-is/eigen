type NotFoundProps = {
    message?: string;
};

export function NotFound({
    message = "Encountering the null vector: a rendezvous with nothing at all.",
}: NotFoundProps) {
    return (
        <div className="flex flex-col items-center justify-center h-full w-full gap-4 p-8 text-center">
            <p className="text-muted-foreground">{message}</p>
        </div>
    );
}
