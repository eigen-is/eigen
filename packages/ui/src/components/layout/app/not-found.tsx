type NotFoundProps = {
    message?: string;
};

export function NotFound({
    message = "Encountering the null vector: a rendezvous with nothing at all.",
}: NotFoundProps) {
    return (
        <div className="flex items-center justify-center h-full w-full p-8 text-center">
            <p className="text-muted-foreground">{message}</p>
        </div>
    );
}
