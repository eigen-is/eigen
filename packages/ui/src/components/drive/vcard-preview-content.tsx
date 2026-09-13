import { IMPORT_MAX_BYTES } from '@workspace/lib/constants/contact';
import { useVCardFile } from '@workspace/lib/contacts';
import type { DrivePath } from '@workspace/lib/types/drive';
import { parsedCardToContact } from '@workspace/lib/vcard';
import { useMemo } from 'react';
import { EmptyState } from '../layout/app/empty-state';
import { ErrorState } from '../layout/app/error-state';
import { LoadingState } from '../layout/app/loading-state';
import { ContactDetailCard } from '../user/contact-detail-card';

// A quick look reads, it doesn't scroll a whole address book: the rest is a counted line.
const PREVIEW_CARD_LIMIT = 200;

function droppedLine(dropped: number): string {
    return `${dropped} contact${dropped === 1 ? '' : 's'} could not be read`;
}

export function VCardPreviewContent({ path }: { path: DrivePath }) {
    const { data, isLoading } = useVCardFile(path.ownerId, path.mountId, path.id, path.updatedAt, path.size);
    // Inline photos become data URIs, so this is real work per card — never per render.
    const contacts = useMemo(
        () => (data?.cards ?? []).slice(0, PREVIEW_CARD_LIMIT).map(parsedCardToContact),
        [data?.cards],
    );

    const remaining = data ? data.total - contacts.length : 0;

    return (
        <div className="w-[80vw] h-[calc(100vh-7rem)] overflow-auto rounded bg-background">
            {path.size > IMPORT_MAX_BYTES ? (
                <EmptyState message="File too large to preview" />
            ) : isLoading ? (
                <LoadingState />
            ) : !data ? (
                <ErrorState message="Could not read this file" />
            ) : contacts.length === 0 ? (
                <EmptyState
                    message="No contacts in this file"
                    hint={data.dropped > 0 ? droppedLine(data.dropped) : undefined}
                />
            ) : (
                <div className="max-w-3xl mx-auto flex flex-col gap-8 p-8">
                    {contacts.map(({ contact, categories }, index) => (
                        <ContactDetailCard
                            key={index}
                            contact={contact}
                            labels={categories.map((name) => ({ name }))}
                            className="border-b pb-8 last:border-b-0 last:pb-0"
                        />
                    ))}
                    {remaining > 0 && (
                        <p className="text-sm text-muted-foreground">
                            and {remaining} more contact{remaining === 1 ? '' : 's'}
                        </p>
                    )}
                    {data.dropped > 0 && <p className="text-sm text-muted-foreground">{droppedLine(data.dropped)}</p>}
                </div>
            )}
        </div>
    );
}
