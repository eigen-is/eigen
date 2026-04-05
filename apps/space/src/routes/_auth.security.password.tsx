import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useChangePassword } from '@workspace/lib/auth';
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
        <div className="flex flex-col m-8">
            <div className="w-full max-w-3xl">
                <h1 className="text-2xl font-semibold mb-6">Change Password</h1>
                <ChangePassword onPasswordChange={handlePasswordChange} />
            </div>
        </div>
    );
}
