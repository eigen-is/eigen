# Renders the HTML on stdin to a PDF on stdout, scaled by the zoom in the first argument, 1 without one. An export
# embeds all it needs as data: URIs, so the fetcher opens those and refuses every other URL, where WeasyPrint's own
# would fetch from the API host. It also teaches WeasyPrint to tell the slices of one font apart, and to print every
# font's outlines, never its colour layers, on every host. Needs WeasyPrint 68, the first with the URLFetcher class.
import sys
from hashlib import md5
from itertools import count
from xml.etree.ElementTree import SubElement

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

        # Only a doc with bands, which carry the doc export's PAGE_BAND_CLASS, pays for the probe.
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
                bottom_y = max(box.position_y + box.margin_height() for box in boxes)
                height = bottom_y - min(box.position_y for box in boxes)
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


# An export embeds each font as slices: files of one family that each draw some of its characters. WeasyPrint tells
# fonts apart by their family, style and weight, but not by their file. So it embedded the first slice's file and drew
# every slice's glyph ids with it, and Chinese, Korean or emoji printed as other characters. Here a font's key and the
# tag of its embedded file also take a digest of the file.
#
# WeasyPrint draws a colour font only with a HarfBuzz newer than the image's, and leaves it blank otherwise. The emoji
# face paints in the text colour anyway, so every font prints its outlines instead.
#
# WeasyPrint is pinned. One that renamed these internals fails every PDF here, and one that changed a signature fails
# with a traceback. If add_font stopped calling stream.get_pango_font_key, the key would be skipped silently and wrong
# glyphs would print again. The glyph test in CI catches that.
def patch_font_embedding():
    try:
        from weasyprint.pdf import fonts, stream
        from weasyprint.text.ffi import ffi, harfbuzz
        from weasyprint.text.fonts import get_hb_object_data, get_pango_font_hb_face

        font_key, font_init = stream.get_pango_font_key, fonts.Font.__init__
    except (AttributeError, ImportError) as error:
        sys.exit(f'weasyprint-render.py: WeasyPrint moved its font internals ({type(error).__name__}: {error})')

    # add_font asks for a key on every text box, and a face can be megabytes, so each face is digested once. The cache
    # holds the face, so its address is not reused for another one while the render runs. The faces of a font
    # collection share one file, so the key also takes the face's index.
    faces = {}

    def key_by_file(pango_font):
        key, description, font_size = font_key(pango_font)
        hb_face = get_pango_font_hb_face(pango_font)
        address = int(ffi.cast('uintptr_t', hb_face))
        if address not in faces:
            digest = md5(get_hb_object_data(hb_face), usedforsecurity=False).digest()
            faces[address] = hb_face, digest, harfbuzz.hb_face_get_index(hb_face)
        _, digest, index = faces[address]
        return (key, digest, index), description, font_size

    def init_by_file(font, pango_font, description, font_size):
        font_init(font, pango_font, description, font_size)
        file = font.file_content + font.index.to_bytes(4, 'big')
        digest = md5(font.hash.encode() + file, usedforsecurity=False).digest()
        tag = ''.join(chr(65 + byte % 26) for byte in digest[:6])
        font.name, font.hash = b'/' + tag.encode() + font.name[len(font.hash) + 1:], tag
        font.colr = False

    stream.get_pango_font_key, fonts.Font.__init__ = key_by_file, init_by_file


# Pango asks fontconfig for the best font of a description, then for all of them in order, and skips the first of that
# list as the best one it already has. The slices of one family tie on every score fontconfig sorts by. glibc's sort
# keeps tied fonts in the order they came, so the best one stays first, but the sort of macOS and musl does not. There
# Pango skipped a slice it never had, and its characters printed as .notdef. A distinct font version for each slice
# file breaks the tie. Should WeasyPrint stop writing its font rules through tostring, this does nothing, and glibc
# still prints right. So only the glyph test on a macOS or musl host pins it, as CI's glibc passes without it.
def break_font_ties():
    try:
        from weasyprint.text import fonts

        serialize = fonts.tostring
    except (AttributeError, ImportError) as error:
        sys.exit(f'weasyprint-render.py: WeasyPrint moved its font rules ({type(error).__name__}: {error})')
    versions = count(1)

    def with_font_version(root, **options):
        for match in root.iter('match'):
            if match.get('target') == 'scan':
                edit = SubElement(match, 'edit', name='fontversion', mode='assign')
                SubElement(edit, 'int').text = str(next(versions))
        return serialize(root, **options)

    fonts.tostring = with_font_version


patch_font_embedding()
break_font_ties()

# A passed stylesheet is the user's, so the margins it grows are !important to win over the document's @page. The probe
# and the render share one font configuration, so the doc's @font-face fonts load once.
html = weasyprint.HTML(file_obj=sys.stdin.buffer, encoding='utf-8', url_fetcher=DataFetcher())
font_config = weasyprint.text.fonts.FontConfiguration()
margins = band_margins(html, font_config)
document = html.render(stylesheets=[weasyprint.CSS(string=margins)] if margins else None, font_config=font_config)
document.write_pdf(sys.stdout.buffer, zoom=float(sys.argv[1]) if len(sys.argv) > 1 else 1)
