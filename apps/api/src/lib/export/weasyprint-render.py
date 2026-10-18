# Renders the HTML on stdin to a PDF on stdout, scaled by the zoom in the first argument, 1 without one. WeasyPrint's
# own fetcher opens any URL the HTML names, from the API host, and an export embeds everything it needs as a data: URI,
# so this one opens data: URIs and refuses the rest: http(s), file:, a path, any other scheme. Needs WeasyPrint 68, the
# first with the URLFetcher class.
import sys

import weasyprint
from weasyprint.formatting_structure.boxes import MarginBox


# Not URLFetcher(allowed_protocols={'data'}): 68.0 takes the text before '://' as the scheme, so it refuses every data:.
class DataFetcher(weasyprint.urls.URLFetcher):
    def fetch(self, url, headers=None):
        if not url.lower().startswith('data:'):
            raise ValueError(f'only data: URIs are fetched, not {url[:80]}')
        return super().fetch(url, headers)


def descendants(box):
    for child in getattr(box, 'children', None) or []:
        yield child
        yield from descendants(child)


# A margin box pushes nothing, so a header taller than the top margin would print over the body, where Word and the
# editor move the body down: the margin a band needs is its distance from the edge plus its laid-out height, paragraph
# spacing included, as the editor measures it. Page 1's, which may print bands of its own, and the most any other page
# needs; None when every band fits.
def band_margins(document):
    needs = []
    for page in document.pages:
        page_box = page._page_box
        top, bottom = page_box.margin_top, page_box.margin_bottom
        for margin_box in page_box.children:
            if not isinstance(margin_box, MarginBox):
                continue
            boxes = list(descendants(margin_box))
            if not boxes:
                continue
            height = max(box.position_y + box.margin_height() for box in boxes) - min(box.position_y for box in boxes)
            if margin_box.at_keyword.startswith('@top'):
                top = max(top, margin_box.padding_top + height)
            elif margin_box.at_keyword.startswith('@bottom'):
                bottom = max(bottom, margin_box.padding_bottom + height)
        needs.append((top, bottom, page_box.margin_top, page_box.margin_bottom))
    if all(top == margin_top and bottom == margin_bottom for top, bottom, margin_top, margin_bottom in needs):
        return None
    rest = needs[1:] or needs[:1]
    first = f'margin-top: {needs[0][0]}px !important; margin-bottom: {needs[0][1]}px !important;'
    other = f'margin-top: {max(n[0] for n in rest)}px !important; margin-bottom: {max(n[1] for n in rest)}px !important;'
    return f'@page {{ {other} }} @page :first {{ {first} }}'


# A passed stylesheet is the user's, so the margins it grows are !important to win over the document's @page.
html = weasyprint.HTML(file_obj=sys.stdin.buffer, encoding='utf-8', url_fetcher=DataFetcher())
document = html.render()
margins = band_margins(document)
if margins:
    document = html.render(stylesheets=[weasyprint.CSS(string=margins)])
document.write_pdf(sys.stdout.buffer, zoom=float(sys.argv[1]) if len(sys.argv) > 1 else 1)
