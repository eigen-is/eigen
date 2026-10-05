// The largest @page side an export asks WeasyPrint for: 200 inches, the PDF page limit. A page sized from
// collaborator data (a huge column width, a drawing element far out) would otherwise cost WeasyPrint
// without bound. Content past it continues on the next page or is cut at the right edge.
export const MAX_PDF_PAGE_PX = 19_200;
