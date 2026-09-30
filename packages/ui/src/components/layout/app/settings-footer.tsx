import { wasToasted } from '@workspace/lib/api-error';
import { Button } from '../../button';
import { Separator } from '../../separator';
import { LeaveGuard } from './leave-guard';

type SettingsFooterProps = {
    dirty: boolean;
    saving: boolean;
    disabled?: boolean;
    onSave: () => void | Promise<void>;
    onReset: () => void;
};

// Save and Reset for a settings page's draft; hidden until something changed.
export function SettingsFooter({ dirty, saving, disabled = false, onSave, onReset }: SettingsFooterProps) {
    if (!dirty) return null;
    // A save that failed was toasted by its mutation hook, and the draft stays for another try.
    const handleSave = async () => {
        try {
            await onSave();
        } catch (error) {
            if (!wasToasted(error)) throw error;
        }
    };
    return (
        <>
            <LeaveGuard
                active={!saving}
                title="Leave without saving?"
                description="Your changes have not been saved. If you leave now they are lost."
            />
            <Separator />
            <div className="flex items-center justify-end gap-2">
                <Button variant="outline" onClick={onReset}>
                    Reset
                </Button>
                <Button onClick={handleSave} disabled={saving || disabled}>
                    {saving ? 'Saving...' : 'Save'}
                </Button>
            </div>
        </>
    );
}
