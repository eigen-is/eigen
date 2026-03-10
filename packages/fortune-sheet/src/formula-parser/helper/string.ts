/**
 * Trim value by cutting character starting from the beginning and ending at the same time.
 *
 * @param string String to trimming.
 * @param margin Number of character to cut.
 * @returns Trimmed string.
 */
export function trimEdges(string: string, margin = 1): string {
  return string.substring(margin, string.length - margin);
}
