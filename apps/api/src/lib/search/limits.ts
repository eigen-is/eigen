// Cap on the body text indexed per file (~100 KB): a document's substance without
// letting one huge file dominate the index. Its own module so the main-thread
// extractor and the Worker-pure renderer share the number without either importing
// the other's dependencies.
export const CONTENT_INDEX_MAX_BYTES = 100_000;
