// Derived from @mjackson/multipart-parser (MIT © Michael Jackson).

export type SearchFunction = (haystack: Uint8Array, start?: number) => number;

// Boyer-Moore-Horspool search for a fixed pattern.
export function createSearch(pattern: string): SearchFunction {
    const needle = new TextEncoder().encode(pattern);
    const needleEnd = needle.length - 1;
    // Skip distances must fit in a byte; callers keep the needle short by capping the
    // boundary length (see MAX_BOUNDARY_LENGTH), so a distance can never wrap to 0.
    const skipTable = new Uint8Array(256).fill(needle.length);
    for (let i = 0; i < needleEnd; ++i) {
        skipTable[needle[i]] = needleEnd - i;
    }

    return (haystack, start = 0) => {
        const haystackLength = haystack.length;
        let i = start + needleEnd;

        while (i < haystackLength) {
            for (let j = needleEnd, k = i; j >= 0 && haystack[k] === needle[j]; --j, --k) {
                if (j === 0) return k;
            }
            i += skipTable[haystack[i]];
        }

        return -1;
    };
}

export type PartialTailSearchFunction = (haystack: Uint8Array) => number;

// Finds where a prefix of the pattern begins as the suffix of the haystack, or -1.
// Used to hold back bytes that may turn out to be the start of a boundary.
export function createPartialTailSearch(pattern: string): PartialTailSearchFunction {
    const needle = new TextEncoder().encode(pattern);

    const byteIndexes: Record<number, number[]> = {};
    for (let i = 0; i < needle.length; ++i) {
        const byte = needle[i];
        if (byteIndexes[byte] === undefined) byteIndexes[byte] = [];
        byteIndexes[byte].push(i);
    }

    return (haystack) => {
        const haystackEnd = haystack.length - 1;

        if (haystack[haystackEnd] in byteIndexes) {
            const indexes = byteIndexes[haystack[haystackEnd]];

            for (let i = indexes.length - 1; i >= 0; --i) {
                for (let j = indexes[i], k = haystackEnd; j >= 0 && haystack[k] === needle[j]; --j, --k) {
                    if (j === 0) return k;
                }
            }
        }

        return -1;
    };
}
