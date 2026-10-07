// i;ascii-casemap (RFC 4790 § 9.2) folds A–Z only, so an accented letter keeps its case.
export const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
