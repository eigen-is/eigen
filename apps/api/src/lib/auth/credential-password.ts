// The one write of an account password: its hash onto the user's credential account, the row better-auth's sign-in
// reads. Callers such as an admin's reset and the guest and demo sign-in share it.

import { auth } from './auth';

// Creates the credential account when the user has none. Another provider's account row is left alone.
export async function setCredentialPassword(userId: string, password: string): Promise<void> {
    const context = await auth.$context;
    const hash = await context.password.hash(password);
    if (await context.internalAdapter.findCredentialAccount(userId)) {
        await context.internalAdapter.updatePassword(userId, hash);
    } else {
        await context.internalAdapter.createAccount({
            userId,
            providerId: 'credential',
            accountId: userId,
            password: hash,
        });
    }
}
