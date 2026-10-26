# Renders the HTML on stdin to a PDF on stdout, scaled by the zoom in the first argument, 1 without one. WeasyPrint's
# own fetcher opens any URL the HTML names, from the API host, and an export embeds everything it needs as a data: URI,
# so this one opens data: URIs and refuses the rest: http(s), file:, a path, any other scheme. Needs WeasyPrint 68, the
# first with the URLFetcher class.
import sys

import weasyprint


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


# A doc's PDF (export/doc/transform.ts) without its body: the bands are running elements of .page, the body its article.
# A line on page 1 and a forced page 2 lay out page 1's bands and the other pages' alike.
BAND_PROBE = """
.page > article { display: none !important; }
.page::before, .page::after { content: '\\a0' !important; display: block !important; }
.page::after { break-before: page !important; }
"""


# A margin box pushes nothing, so a header taller than the top margin would print over the body, where Word and the
# editor move the body down: the margin a band needs is its distance from the edge plus its laid-out height, paragraph
# spacing included, as the editor measures it. A probe of the bands alone measures page 1's, which may print bands of
# its own, and the other pages', so the doc lays out once; None when every band fits. A full-page letterhead overflows
# its margin rather than take the page. The probe reads WeasyPrint's layout, so a WeasyPrint that moved it grows no
# margin rather than failing every PDF export, and says so in one line on stderr.
def band_margins(html, font_config):
    try:
        from weasyprint.formatting_structure.boxes import MarginBox

        # PAGE_BAND_CLASS: only a doc with bands pays for the probe.
        if not any('page-band' in (element.get('class') or '').split() for element in html.etree_element.iter()):
            return None
        margins, grown = [], False
        for page in html.render(stylesheets=[weasyprint.CSS(string=BAND_PROBE)], font_config=font_config).pages:
            page_box = page._page_box
            margin_top, margin_bottom = page_box.margin_top, page_box.margin_bottom
            top, bottom = margin_top, margin_bottom
            for margin_box in page_box.children:
                boxes = list(descendants(margin_box)) if isinstance(margin_box, MarginBox) else []
                if not boxes:
                    continue
                height = max(box.position_y + box.margin_height() for box in boxes) - min(box.position_y for box in boxes)
                if margin_box.at_keyword.startswith('@top'):
                    top = max(top, margin_box.padding_top + height)
                elif margin_box.at_keyword.startswith('@bottom'):
                    bottom = max(bottom, margin_box.padding_bottom + height)
            # The grown margins leave the body at least half the page, or what the doc's own margins leave it.
            growth = top + bottom - margin_top - margin_bottom
            room = max(0, page.height / 2 - margin_top - margin_bottom)
            scale = min(1, room / growth) if growth else 0
            margins.append((margin_top + (top - margin_top) * scale, margin_bottom + (bottom - margin_bottom) * scale))
            grown = grown or scale > 0
        if not grown:
            return None
        return ' '.join(
            f'{selector} {{ margin-top: {top}px !important; margin-bottom: {bottom}px !important; }}'
            for selector, (top, bottom) in zip(('@page :first', '@page'), margins)
        )
    except (AttributeError, ImportError) as error:
        reason = f'{type(error).__name__}: {error}'
        print(f'band_margins: WeasyPrint layout moved, bands grow no margin ({reason})', file=sys.stderr)
        return None


# A passed stylesheet is the user's, so the margins it grows are !important to win over the document's @page. The probe
# and the render share one font configuration, so the doc's @font-face fonts load once.
html = weasyprint.HTML(file_obj=sys.stdin.buffer, encoding='utf-8', url_fetcher=DataFetcher())
font_config = weasyprint.text.fonts.FontConfiguration()
margins = band_margins(html, font_config)
document = html.render(stylesheets=[weasyprint.CSS(string=margins)] if margins else None, font_config=font_config)
document.write_pdf(sys.stdout.buffer, zoom=float(sys.argv[1]) if len(sys.argv) > 1 else 1)
