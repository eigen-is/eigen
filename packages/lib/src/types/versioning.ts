// Eden Treaty's reviver converts ISO strings to Date at runtime — type as
// Date, not string, per project_date_wire_convention.
export type Snapshot = {
    id: string;
    name: string;
    createdAt: Date;
    size: number;
};
