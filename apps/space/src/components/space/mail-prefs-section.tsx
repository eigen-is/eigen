import { useSpaceSettings, useUpdateSpaceSettings } from '@workspace/lib/space';
import type { EmailSettings } from '@workspace/lib/types/settings';
import { LoadingState } from '@workspace/ui';
import { Label } from '@workspace/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Switch } from '@workspace/ui/components/switch';

type AutoAdvance = NonNullable<EmailSettings['autoAdvance']>;

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
                    onValueChange={(v) => update.mutate({ email: { autoAdvance: v as AutoAdvance } })}
                >
                    <SelectTrigger className="w-full sm:w-96">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="older">Go to the mail below (older)</SelectItem>
                        <SelectItem value="newer">Go to the mail above (newer)</SelectItem>
                        <SelectItem value="list">Go back to the list</SelectItem>
                    </SelectContent>
                </Select>
            </div>
        </div>
    );
}
