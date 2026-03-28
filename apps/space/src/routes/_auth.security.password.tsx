import {createFileRoute, useNavigate} from '@tanstack/react-router';
import {authClient} from '@workspace/lib/auth';
import {toast} from 'sonner';
import {ChangePassword} from '../components/space/change-password';

export const Route = createFileRoute('/_auth/security/password')({
    component: PasswordComponent,
});

function PasswordComponent() {
    const navigate = useNavigate();
    const handlePasswordChange = async (data: {
        currentPassword: string;
        newPassword: string;
        revokeOtherSessions: boolean;
    }) => {
        const result = await authClient.changePassword(data);
        if (result.data) {
            toast.success('Password changed successfully');
            await navigate({to: '/'});
        } else {
            toast.error(result.error?.message ?? 'Failed to change password');
        }
    };

    return (
        <div className="flex flex-col m-8">
            <div className="w-full max-w-3xl">
                <h1 className="text-2xl font-semibold mb-6">Change Password</h1>
                <ChangePassword onPasswordChange={handlePasswordChange}/>
            </div>
        </div>
    );
}
