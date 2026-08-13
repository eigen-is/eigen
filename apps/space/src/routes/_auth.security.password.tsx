import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useChangePassword } from '@workspace/lib/auth';
import { Column, ColumnLayout } from '@workspace/ui/components/layout/app/column-layout';
import { ToolbarTitle } from '@workspace/ui/components/layout/toolbar';
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
            <Column id="detail" width="flex" onBack="sidebar" toolbar={<ToolbarTitle>Change Password</ToolbarTitle>}>
                <div className="h-full overflow-y-auto">
                    <div className="w-full max-w-3xl app-gutter">
                        <ChangePassword onPasswordChange={handlePasswordChange} />
                    </div>
                </div>
            </Column>
        </ColumnLayout>
    );
}
