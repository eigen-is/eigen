import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useChangePassword } from '@workspace/lib/auth';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout.tsx';
import { ChangePassword } from '../components/space/change-password';

export const Route = createFileRoute('/_auth/security/password')({
    component: PasswordComponent,
});

function PasswordComponent() {
    const navigate = useNavigate();
    const changePassword = useChangePassword();

    const handlePasswordChange = async (data: {
        currentPassword: string;
        newPassword: string;
        revokeOtherSessions: boolean;
    }) => {
        await changePassword.mutateAsync(data);
        await navigate({ to: '/' });
    };

    return (
        <ColumnLayout>
            <Column
                id="detail"
                width="flex"
                toolbar={<span className="text-sm text-foreground font-normal">Change Password</span>}
            >
                <div className="h-full overflow-y-auto">
                    <div className="w-full max-w-3xl p-8">
                        <ChangePassword onPasswordChange={handlePasswordChange} />
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
