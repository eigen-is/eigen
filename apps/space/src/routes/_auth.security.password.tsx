import {createFileRoute, useNavigate} from '@tanstack/react-router'
import { ChangePassword } from '../components/space/change-password'
import { toast } from 'sonner';
import { authClient } from '@workspace/lib/auth';

export const Route = createFileRoute('/_auth/security/password')({
    component: PasswordComponent,
})

function PasswordComponent() {
    const navigate = useNavigate();
    const handlePasswordChange = async (data: { currentPassword: string, newPassword: string }) => {
        const result = await authClient.changePassword({...data, revokeOtherSessions: true});
console.log(result);
        if (result.data) {
            toast.success('Password changed successfully');

            // wait 350ms
            await new Promise(resolve => setTimeout(resolve, 350));

            // navigate to /
            navigate({
                to: '/',
        });

        } else {
            toast.error(result.error?.message ?? 'Failed to change password');
        }
    }

    return (
        <div className="flex flex-col items-center justify-center min-h-screen">
            <ChangePassword onPasswordChange={handlePasswordChange} />
        </div>
    );
}
