// What one counted import file did, for every domain that takes a whole file at a time: a member is
// imported, skipped as a duplicate, or failed on its own content. The three always sum to the number of
// members in the file.
export type ImportCountsResult = { imported: number; skipped: number; failed: number };
