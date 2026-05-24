import { formatDate } from '@workspace/lib/date';
import type { PaletteResult } from '@workspace/lib/types/command-palette';
import { CommandItem } from '@workspace/ui/components/command';
import { cn } from '@workspace/ui/lib/utils';

type Props = {
    result: Extract<PaletteResult, { kind: 'mail' }>;
    onSelect: () => void;
};

// Match the mail app's email-list row (apps/mail/src/components/mail/email-list.tsx):
// sender + date on the first line, subject on the second, body snippet on the third.
// Same visual structure, same precedence; the palette icon sits to the left so the row
// still reads as a mail kind among other kinds in the merged list.
export function CommandRowMail({ result, onSelect }: Props) {
    const { payload, icon: Icon } = result;
    return (
        <CommandItem onSelect={onSelect} value={result.id} className="items-start">
            <Icon className="h-4 w-4 text-muted-foreground mt-1 shrink-0" />
            <div className="flex-1 min-w-0">
                <div className="flex justify-between items-baseline">
                    <div className={cn('text-sm font-medium text-foreground', !payload.isRead && 'font-semibold')}>
                        {payload.fromShort || payload.fromAddress || 'Unknown'}
                    </div>
                    <div className="text-xs text-muted-foreground whitespace-nowrap ml-2">
                        {formatDate(payload.date)}
                    </div>
                </div>
                <div className={cn('text-sm truncate mt-0.5 text-foreground', !payload.isRead && 'font-medium')}>
                    {payload.subject || '(no subject)'}
                </div>
                <div className="text-xs truncate text-muted-foreground mt-0.5">{payload.textShort}</div>
            </div>
        </CommandItem>
    );
}
