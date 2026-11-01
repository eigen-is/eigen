# Reads the glyphs a WeasyPrint PDF prints, for the test that pins the font slices in weasyprint-render.py. A JSON on
# stdin names the PDF, the font slices its HTML embedded, and the variable font locations it printed them at. A JSON on
# stdout lists each glyph a font draws: its text, the slice whose unicode-range holds that text, and whether the
# embedded program draws the outline that slice has for the glyph. Runs under the WeasyPrint venv's Python, which has
# fontTools.
import base64
import io
import json
import re
import sys
import zlib

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont


# Every object's dictionary and every stream's decoded bytes, by object number. WeasyPrint packs the dictionaries into
# compressed object streams and writes each stream on its own.
def pdf_objects(pdf):
    dictionaries, streams = {}, {}
    header = re.compile(rb'(\d+) 0 obj\s*')
    position = 0
    while match := header.search(pdf, position):
        number, start = int(match[1]), match.end()
        end = pdf.index(b'endobj', start)
        stream = re.compile(rb'stream\r?\n').search(pdf, start, end)
        if not stream:
            dictionaries[number] = pdf[start:end]
            position = end
            continue
        dictionary = pdf[start:stream.start()]
        length = int(re.search(rb'/Length (\d+)', dictionary)[1])
        data = pdf[stream.end():stream.end() + length]
        if b'/FlateDecode' in dictionary:
            data = zlib.decompress(data)
        if b'/Type /ObjStm' in dictionary:
            first = int(re.search(rb'/First (\d+)', dictionary)[1])
            offsets = [int(value) for value in data[:first].split()]
            pairs = list(zip(offsets[::2], offsets[1::2]))
            for index, (packed, offset) in enumerate(pairs):
                stop = pairs[index + 1][1] if index + 1 < len(pairs) else len(data) - first
                dictionaries[packed] = data[first + offset:first + stop]
        else:
            dictionaries[number] = dictionary
            streams[number] = data
        position = stream.end() + length
    return dictionaries, streams


def reference(dictionary, key):
    return int(re.search(rb'/' + key + rb'\s*\[?\s*(\d+) 0 R', dictionary)[1])


def code_points(unicode_range):
    for part in unicode_range.split(', '):
        start, _, end = part[2:].partition('-')
        yield int(start, 16), int(end or start, 16)


def outline(glyph_set, name):
    pen = DecomposingRecordingPen(glyph_set)
    glyph_set[name].draw(pen)
    return [(operator, [point for point in points if isinstance(point, tuple)]) for operator, points in pen.value]


# WeasyPrint rounds an instanced variable font's points to whole units.
def same_outline(printed, source):
    return len(printed) == len(source) and all(
        operator == source_operator and len(points) == len(source_points) and all(
            abs(x - source_x) <= 1 and abs(y - source_y) <= 1
            for (x, y), (source_x, source_y) in zip(points, source_points))
        for (operator, points), (source_operator, source_points) in zip(printed, source))


# A slice file also holds glyphs its unicode-range doesn't declare, such as the space. Such a glyph is compared to the
# slice the rest of its program prints from.
def printed_glyphs(request):
    dictionaries, streams = pdf_objects(base64.b64decode(request['pdf']))
    printed = []
    for dictionary in dictionaries.values():
        if b'/Subtype /Type0' not in dictionary:
            continue
        descendant = dictionaries[reference(dictionary, b'DescendantFonts')]
        descriptor = dictionaries[reference(descendant, b'FontDescriptor')]
        family = re.search(rb'/FontFamily \((.*?)\)', descriptor)[1].decode()
        program_number = reference(descriptor, b'FontFile[23]')
        program = TTFont(io.BytesIO(streams[program_number]))
        cmap = streams[reference(dictionary, b'ToUnicode')]
        for cid, utf16 in re.findall(rb'<([0-9a-f]{4})> <([0-9a-f]*)>', cmap):
            cid, text = int(cid, 16), bytes.fromhex(utf16.decode()).decode('utf-16-be')
            # WeasyPrint maps every font's .notdef to U+FFFF.
            if cid == 0:
                continue
            slices = [
                piece for piece in request['slices'] if piece['family'] == family and text and any(
                    start <= ord(text[0]) <= end for start, end in code_points(piece['unicodeRange']))]
            printed.append((family, program_number, program, cid, text, slices))
    program_slices = {number: slices[0] for _, number, _, _, _, slices in printed if len(slices) == 1}
    sources = {}
    glyphs = []
    for family, program_number, program, cid, text, slices in printed:
        printed_order = program.getGlyphOrder()
        glyph = {'family': family, 'program': program_number, 'text': text, 'slice': None}
        glyphs.append(glyph)
        # A character no font has prints .notdef, from an id past the font's glyphs.
        if cid >= len(printed_order):
            glyph['outline'] = 'notdef'
            continue
        if not slices and program_number in program_slices:
            slices = [program_slices[program_number]]
        if len(slices) != 1:
            glyph['outline'] = 'no slice' if not slices else 'several slices'
            continue
        glyph['slice'] = slices[0]['file']
        if slices[0]['file'] not in sources:
            sources[slices[0]['file']] = TTFont(slices[0]['path'])
        source = sources[slices[0]['file']]
        axes = {axis.axisTag for axis in source['fvar'].axes} if 'fvar' in source else set()
        printed_outline = outline(program.getGlyphSet(), printed_order[cid])
        source_outlines = [
            outline(source.getGlyphSet(location={tag: value for tag, value in location.items() if tag in axes}),
                    source.getGlyphOrder()[cid])
            for location in request['locations']]
        if any(same_outline(printed_outline, source_outline) for source_outline in source_outlines):
            glyph['outline'] = 'same'
        elif not printed_outline:
            glyph['outline'] = 'blank'
        else:
            glyph['outline'] = 'other'
    return glyphs


json.dump(printed_glyphs(json.load(sys.stdin)), sys.stdout)
