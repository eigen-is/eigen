// The landing page's Join the waitlist card: an email and a note, sent through useJoinWaitlist from a page form, so
// an address that is none says so under its field and leaving with something typed asks first. The landing page shows
// it once a visitor clicks Join waitlist, when the server's admin turned the waitlist on; a join closes it, and Cancel
// closes it without asking.

import { useJoinWaitlist } from '@workspace/lib/public';
import { FIELD_MESSAGES, validateEmailAddress } from '@workspace/lib/validation';
import { Card, CardContent, CardHeader, CardTitle } from '@workspace/ui/components/card';
import { FieldError } from '@workspace/ui/components/field';
import { useFormSubmitted } from '@workspace/ui/components/form-shell';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { PageForm } from '@workspace/ui/components/layout/app';
import { Textarea } from '@workspace/ui/components/textarea';
import { useId, useState } from 'react';

export function WaitlistForm({ onClose }: { onClose: () => void }) {
    const [email, setEmail] = useState('');
    const [notes, setNotes] = useState('');
    const joinWaitlist = useJoinWaitlist();

    return (
        <Card className="w-full max-w-md text-left">
            <CardHeader>
                <CardTitle>Join the waitlist</CardTitle>
            </CardHeader>
            <CardContent>
                <PageForm
                    changed={email !== '' || notes !== ''}
                    onCancel={onClose}
                    submitLabel="Join waitlist"
                    onSubmit={async () => {
                        if (!validateEmailAddress(email)) return false;
                        await joinWaitlist.mutateAsync({ email: email.trim(), notes });
                        onClose();
                    }}
                >
                    <EmailField value={email} onChange={setEmail} />
                    <div className="space-y-2">
                        <Label htmlFor="notes">Notes (optional)</Label>
                        <Textarea
                            id="notes"
                            placeholder="What would you use Eigen for?"
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                        />
                    </div>
                </PageForm>
            </CardContent>
        </Card>
    );
}

// Once Join waitlist was pressed, an empty or broken address says so here.
function EmailField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
    const errorId = useId();
    const submitted = useFormSubmitted();
    const error = !submitted
        ? undefined
        : !value.trim()
          ? 'Enter your email address'
          : !validateEmailAddress(value)
            ? FIELD_MESSAGES.invalidEmail
            : undefined;

    return (
        <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                aria-invalid={!!error || undefined}
                aria-describedby={error ? errorId : undefined}
            />
            {error && <FieldError id={errorId}>{error}</FieldError>}
        </div>
    );
}
