// The Mail section of the account settings: single-key shortcuts on or off, and which conversation opens after
// one is archived, deleted or reported as spam. Each change saves at once through the space settings.

import { useSpaceSettings, useUpdateSpaceSettings } from '@workspace/lib/space';
import type { EmailSettings } from '@workspace/lib/types/settings';
import { Label } from '@workspace/ui/components/label';
import { LoadingState } from '@workspace/ui/components/layout/app';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Switch } from '@workspace/ui/components/switch';

const AUTO_ADVANCE_OPTIONS = [
    { value: 'older', label: 'Go to the mail below (older)' },
    { value: 'newer', label: 'Go to the mail above (newer)' },
    { value: 'list', label: 'Go back to the list' },
] as const satisfies readonly { value: NonNullable<EmailSettings['autoAdvance']>; label: string }[];

export function MailPrefsSection() {
    const { data, isLoading } = useSpaceSettings();
    const update = useUpdateSpaceSettings();

    if (isLoading) return <LoadingState />;

    const keyboardShortcuts = data?.email?.keyboardShortcuts ?? false;
    const autoAdvance = data?.email?.autoAdvance ?? 'older';

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-lg font-medium">Keyboard and navigation</h2>
                <p className="text-sm text-muted-foreground">
                    Speed up Mail with single-key shortcuts and choose where you land after acting on a conversation.
                </p>
            </div>

            <div className="space-y-1.5">
                <div className="flex items-center gap-3">
                    <Switch
                        checked={keyboardShortcuts}
                        onCheckedChange={(v) => update.mutate({ email: { keyboardShortcuts: v } })}
                    />
                    <Label>Keyboard shortcuts</Label>
                </div>
                <p className="text-sm text-muted-foreground">
                    Gmail-style single-key shortcuts in Mail: j/k navigate, e archives, and more. Press ? in Mail for
                    the full list.
                </p>
            </div>

            <div className="space-y-1.5">
                <Label>After archiving, deleting, or reporting spam</Label>
                <Select
                    value={autoAdvance}
                    onValueChange={(v) => {
                        const option = AUTO_ADVANCE_OPTIONS.find((o) => o.value === v);
                        if (option) update.mutate({ email: { autoAdvance: option.value } });
                    }}
                >
                    <SelectTrigger className="w-full sm:w-96">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {AUTO_ADVANCE_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>
        </div>
    );
}
