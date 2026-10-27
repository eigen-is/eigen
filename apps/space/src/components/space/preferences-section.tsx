// The personal preferences that belong to no single app, such as whether finishing something now and then
// celebrates. Each switch saves to the personal settings as soon as it flips.

import { useSpaceSettings, useUpdateSpaceSettings } from '@workspace/lib/space';
import { celebrationsOn } from '@workspace/lib/types/settings';
import { LoadingState } from '@workspace/ui';
import { Label } from '@workspace/ui/components/label';
import { Switch } from '@workspace/ui/components/switch';

export function PreferencesSection() {
    const { data, isLoading } = useSpaceSettings();
    const update = useUpdateSpaceSettings();

    if (isLoading) return <LoadingState />;

    return (
        <div className="space-y-6">
            <h2 className="text-lg font-medium">Preferences</h2>

            <div className="space-y-1.5">
                <div className="flex items-center gap-3">
                    <Switch
                        id="celebrations"
                        checked={celebrationsOn(data)}
                        onCheckedChange={(v) => update.mutate({ celebrations: v })}
                    />
                    <Label htmlFor="celebrations">Celebrations</Label>
                </div>
                <p className="text-sm text-muted-foreground">
                    A small surprise now and then when you finish something.
                </p>
            </div>
        </div>
    );
}
