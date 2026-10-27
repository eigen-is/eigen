// The personal preferences that belong to no single app, such as the theme every app is drawn in and
// whether finishing something now and then celebrates. Each control saves to the personal settings as
// soon as it changes.

import { useSpaceSettings, useUpdateSpaceSettings } from '@workspace/lib/space';
import { celebrationsOn, isUserTheme, THEMES, themeOf } from '@workspace/lib/types/settings';
import { LoadingState } from '@workspace/ui';
import { Label } from '@workspace/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Switch } from '@workspace/ui/components/switch';

export function PreferencesSection() {
    const { data, isLoading } = useSpaceSettings();
    const update = useUpdateSpaceSettings();

    if (isLoading) return <LoadingState />;

    return (
        <div className="space-y-6">
            <h2 className="text-lg font-medium">Appearance</h2>

            <div className="space-y-1.5">
                <Label htmlFor="theme">Theme</Label>
                <Select
                    value={themeOf(data)}
                    onValueChange={(v) => {
                        if (isUserTheme(v)) update.mutate({ theme: v });
                    }}
                >
                    <SelectTrigger id="theme" className="w-full sm:w-96">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {THEMES.map(({ value, label }) => (
                            <SelectItem key={value} value={value}>
                                {label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">System follows your computer's light or dark setting.</p>
            </div>

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
