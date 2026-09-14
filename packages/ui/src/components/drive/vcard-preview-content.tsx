import { IMPORT_MAX_BYTES } from '@workspace/lib/constants/contact';
import { droppedLine, remainingLine } from '@workspace/lib/contacts';
import { useVCardPreview } from '@workspace/lib/drive';
import { formatFileSize } from '@workspace/lib/format';
import type { DrivePath } from '@workspace/lib/types/drive';
import { EmptyState } from '../layout/app/empty-state';
import { ErrorState } from '../layout/app/error-state';
import { LoadingState } from '../layout/app/loading-state';
import { ContactDetailCard } from '../user/contact-detail-card';

export function VCardPreviewContent({ path }: { path: DrivePath }) {
    const { data, isLoading } = useVCardPreview(path.ownerId, path.mountId, path.id, path.updatedAt, path.size);

    // The cards the file holds that this preview shows no card for — the unreadable ones get their own line.
    const remaining = data ? data.total - data.dropped - data.cards.length : 0;
    // Both counts, for the empty state: a file whose every readable card failed still says how many it
    // never opened.
    const counts = [
        ...(remaining > 0 ? [remainingLine(remaining)] : []),
        ...(data && data.dropped > 0 ? [droppedLine(data.dropped)] : []),
    ];

    return (
        <div className="w-[80vw] h-[calc(100vh-7rem)] overflow-auto rounded bg-background">
            {path.size > IMPORT_MAX_BYTES ? (
                <EmptyState
                    message="File too large to preview"
                    hint={`A file over ${formatFileSize(IMPORT_MAX_BYTES)} can’t be imported either.`}
                />
            ) : isLoading ? (
                <LoadingState />
            ) : !data ? (
                <ErrorState message="Could not read this file" />
            ) : data.cards.length === 0 ? (
                <EmptyState message="No contacts in this file" hint={counts.join(' · ') || undefined} />
            ) : (
                <div className="max-w-3xl mx-auto flex flex-col gap-8 p-8">
                    {data.cards.map(({ contact, categories }, index) => (
                        <ContactDetailCard
                            key={index}
                            contact={contact}
                            labels={categories.map((name) => ({ name }))}
                            className="border-b pb-8 last:border-b-0 last:pb-0"
                        />
                    ))}
                    {remaining > 0 && <p className="text-sm text-muted-foreground">{remainingLine(remaining)}</p>}
                    {data.dropped > 0 && <p className="text-sm text-muted-foreground">{droppedLine(data.dropped)}</p>}
                </div>
            )}
        </div>
    );
}
