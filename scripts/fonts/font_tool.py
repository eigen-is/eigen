"""The font file work of build-font-slices.ts, which plans the slices and calls this through a local fontTools venv.

usage:
  font_tool.py cmap FONT                    print the font's code points as a JSON list
  font_tool.py instance FONT OUT AXIS=MIN:MAX
                                            narrow a variable font's axis, for example wght=400:700
  font_tool.py woff2 FONT OUT               the whole font as WOFF2, tables untouched
  font_tool.py subset JOBS_JSON             cut each job's slice: [{"font", "codePoints", "out", "features", "colorForeground"}]

A slice keeps the font's variable axes. With colorForeground, every glyph also gets one COLRv0 layer, the glyph itself
in the text color (palette index 0xFFFF), so browsers treat the face as a color font and draw it in the CSS color.
"""
import json
import sys

from fontTools import subset
from fontTools.colorLib.builder import buildCOLR, buildCPAL
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer


def cmap(path):
    print(json.dumps(sorted(TTFont(path).getBestCmap())))


def instance(path, out, axis):
    tag, _, bounds = axis.partition("=")
    low, _, high = bounds.partition(":")
    font = instancer.instantiateVariableFont(TTFont(path, recalcTimestamp=False), {tag: (float(low), float(high))})
    font.save(out)


def woff2(path, out):
    font = TTFont(path, recalcTimestamp=False)
    font.flavor = "woff2"
    font.save(out)


def cut(job):
    options = subset.Options()
    options.layout_features = job["features"]
    options.flavor = "woff2"
    font = subset.load_font(job["font"], options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=job["codePoints"])
    subsetter.subset(font)
    if job["colorForeground"]:
        glyphs = [glyph for glyph in font.getGlyphOrder() if glyph != ".notdef"]
        font["COLR"] = buildCOLR({glyph: [(glyph, 0xFFFF)] for glyph in glyphs}, version=0)
        font["CPAL"] = buildCPAL([[(0, 0, 0, 1)]])
    subset.save_font(font, job["out"], options)


def main(command, *args):
    if command == "cmap":
        cmap(*args)
    elif command == "instance":
        instance(*args)
    elif command == "woff2":
        woff2(*args)
    elif command == "subset":
        with open(args[0]) as jobs:
            for job in json.load(jobs):
                cut(job)
    else:
        sys.exit(f"unknown command {command}")


if __name__ == "__main__":
    main(*sys.argv[1:])
