export function validatePasswordStrength(password: string): number {
    let score = 0.4 * Math.min((password.length - 1) / 8, 1.0);

    if (/[A-Z]/.test(password)) score += 0.1;
    if (/[a-z]/.test(password)) score += 0.1;
    if (/\d/.test(password)) score += 0.1;
    if (/[^A-Za-z0-9]/.test(password)) score += 0.1;
    score += Math.min(1, Math.max(password.length - 8, 0) * 0.03);

    return Math.min(1, Math.max(0, score));
}
