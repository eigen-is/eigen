// One kept version of a document, as the version history lists it. The versioning routes return it and the
// versioning hooks read it.

export type Snapshot = {
    id: string;
    name: string;
    createdAt: Date;
    size: number;
};
