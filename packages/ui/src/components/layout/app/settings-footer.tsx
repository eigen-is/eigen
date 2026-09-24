import { Button } from '../../button';
import { Separator } from '../../separator';

type SettingsFooterProps = {
    dirty: boolean;
    saving: boolean;
    disabled?: boolean;
    onSave: () => void;
    onReset: () => void;
};

// Save and Reset for a settings page's draft; hidden until something changed.
export function SettingsFooter({ dirty, saving, disabled = false, onSave, onReset }: SettingsFooterProps) {
    if (!dirty) return null;
    return (
        <>
            <Separator />
            <div className="flex items-center justify-end gap-2">
                <Button variant="outline" onClick={onReset}>
                    Reset
                </Button>
                <Button onClick={onSave} disabled={saving || disabled}>
                    {saving ? 'Saving...' : 'Save'}
                </Button>
            </div>
        </>
    );
}
