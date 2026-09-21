import { memberProps, propstatNotFound, propstatOk, response } from './xml';

// Past it a row still appears, with its etag and a 404 for the data (RFC 4918 § 9.1): a truncated collection loses resources silently.
export const REPORT_DATA_BUDGET_BYTES = 33_554_432;

// What one REPORT may still spend on resource bodies.
export type DataBudget = { left: number };

export type ResourceDataRow = {
    href: string;
    // The index row: its etag answers a metadata-only request, its size decides against the budget.
    row: { etag: string; size: number };
    contentType: string;
    wantsData: boolean;
    // The empty element a 404 propstat names when the body does not fit the remaining budget.
    dataElement: string;
    dataProp: (text: string) => string;
    read: () => Promise<{ bytes: Uint8Array; etag: string } | null>;
    // The row a member whose file is gone takes: a multiget's 404 propstat, or RFC 6578's removed row in a sync-collection.
    vanished: (href: string) => string;
    budget: DataBudget;
};

// A row that serves the body quotes the etag of the bytes it read, never the index row's: the two must describe one revision.
export async function resourceDataRow(member: ResourceDataRow): Promise<string> {
    const props = (etag: string) => memberProps(etag, member.contentType);
    if (!member.wantsData) return response(member.href, [propstatOk(props(member.row.etag))]);
    if (member.row.size > member.budget.left) {
        return response(member.href, [propstatOk(props(member.row.etag)), propstatNotFound([member.dataElement])]);
    }

    const served = await member.read();
    // The row is there and the file is not: the drain tombstones it, and this response says it is gone.
    if (!served) return member.vanished(member.href);
    member.budget.left -= served.bytes.length;
    return response(member.href, [
        propstatOk([...props(served.etag), member.dataProp(new TextDecoder().decode(served.bytes))]),
    ]);
}
