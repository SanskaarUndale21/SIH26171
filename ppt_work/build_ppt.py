"""
Fills slides 2-6 of the official SIH template with real project content,
replacing the template's raw bullet placeholder with a card/diagram layout
(style borrowed from a winning SIH deck: shrunk centered title + tagline,
rounded-rect icon cards, a real two-box architecture diagram, stat callouts).
Slide 1 (title) and slide 7 (instructions) are never touched.
"""
from pptx import Presentation
from pptx.util import Emu, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR, MSO_AUTO_SIZE
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.oxml.ns import qn

SRC = "../SIH2026-IDEA-Presentation-Format.pptx"
OUT = "../SIH2026-IDEA-Presentation-HexaBits.pptx"
ICON_DIR = "icons"

PRIMARY = RGBColor(0x00, 0x70, 0xC0)
NAVY = RGBColor(0x1E, 0x27, 0x61)
CARD_FILL = RGBColor(0xF3, 0xF7, 0xFC)
AMBER = RGBColor(0xF2, 0x99, 0x14)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
DARK_TEXT = RGBColor(0x28, 0x2E, 0x3A)
GREY_TEXT = RGBColor(0x55, 0x60, 0x70)

SLIDE_W = 12192000
MARGIN = 609600
BAR_TOP = 6354762
CONTENT_TOP = 1500000
CONTENT_BOTTOM = 6250000
TITLE_X = 1700000
TITLE_W = 8000000  # right edge 9700000 -- stays clear of the logo picture starting at x=9780086

prs = Presentation(SRC)
slides = prs.slides


def find_shape(slide, name):
    for shp in slide.shapes:
        if shp.name == name:
            return shp
    return None


def remove_shape(shape):
    shape._element.getparent().remove(shape._element)


def replace_team_name(slide):
    oval = find_shape(slide, "Oval 10")
    if oval is not None:
        oval.text_frame.paragraphs[0].runs[0].text = "HexaBits"


def set_title(slide, text, tagline):
    title = find_shape(slide, "Title 1")
    title.left, title.top, title.width, title.height = Emu(TITLE_X), Emu(140000), Emu(TITLE_W), Emu(520000)
    tf = title.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    p.runs[0].text = text
    p.runs[0].font.size = Pt(28)
    for r in p.runs[1:]:
        r.text = ""
    add_label(slide, tagline, TITLE_X, 650000, TITLE_W, 420000, size=12.5, italic=True, color=GREY_TEXT,
              align=PP_ALIGN.CENTER)


def add_label(slide, text, x, y, w, h, size=11, bold=False, color=DARK_TEXT, align=PP_ALIGN.CENTER,
              italic=False, font="Calibri", anchor=MSO_ANCHOR.TOP, line_spacing=None):
    tb = slide.shapes.add_textbox(Emu(int(x)), Emu(int(y)), Emu(int(w)), Emu(int(h)))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.TEXT_TO_FIT_SHAPE
    tf.margin_left = 0
    tf.margin_right = 0
    tf.margin_top = 0
    tf.margin_bottom = 0
    tf.vertical_anchor = anchor
    lines = text.split("\n")
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        if line_spacing:
            p.line_spacing = line_spacing
        run = p.add_run()
        run.text = line
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.italic = italic
        run.font.name = font
        run.font.color.rgb = color
    return tb


def add_icon_circle(slide, icon_name, cx, cy, diameter, bg=PRIMARY, icon_scale=0.56):
    circle = slide.shapes.add_shape(MSO_SHAPE.OVAL, Emu(int(cx - diameter / 2)), Emu(int(cy - diameter / 2)),
                                     Emu(int(diameter)), Emu(int(diameter)))
    circle.fill.solid()
    circle.fill.fore_color.rgb = bg
    circle.line.fill.background()
    circle.shadow.inherit = False
    isize = int(diameter * icon_scale)
    slide.shapes.add_picture(f"{ICON_DIR}/{icon_name}.png", Emu(int(cx - isize / 2)), Emu(int(cy - isize / 2)),
                              Emu(isize), Emu(isize))
    return circle


def add_arrow(slide, x1, y1, x2, y2, color=PRIMARY, weight=1.75):
    conn = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Emu(int(x1)), Emu(int(y1)), Emu(int(x2)), Emu(int(y2)))
    conn.line.color.rgb = color
    conn.line.width = Pt(weight)
    ln = conn.line._get_or_add_ln()
    ln.append(ln.makeelement(qn("a:tailEnd"), {"type": "triangle", "w": "med", "len": "med"}))
    return conn


def add_rounded_rect(slide, x, y, w, h, fill=CARD_FILL):
    rect = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Emu(int(x)), Emu(int(y)), Emu(int(w)), Emu(int(h)))
    rect.fill.solid()
    rect.fill.fore_color.rgb = fill
    rect.line.color.rgb = RGBColor(0xDC, 0xE6, 0xF0)
    rect.line.width = Pt(0.75)
    rect.shadow.inherit = False
    try:
        rect.adjustments[0] = 0.06
    except Exception:
        pass
    return rect


def add_card(slide, x, y, w, h, icon, header, bullets, icon_bg=PRIMARY):
    add_rounded_rect(slide, x, y, w, h)
    pad = 150000
    diam = min(420000, w * 0.32)
    cy = y + pad + diam / 2
    add_icon_circle(slide, icon, x + w / 2, cy, diam, bg=icon_bg)
    header_y = cy + diam / 2 + 50000
    add_label(slide, header, x + pad, header_y, w - 2 * pad, 360000, size=12.5, bold=True, color=NAVY,
              align=PP_ALIGN.CENTER)
    bullets_y = header_y + 380000
    bullet_text = "\n".join(f"• {b}" for b in bullets)
    add_label(slide, bullet_text, x + pad, bullets_y, w - 2 * pad, (y + h) - bullets_y - pad, size=10,
              color=DARK_TEXT, align=PP_ALIGN.LEFT, line_spacing=1.12)


def add_stat(slide, x, y, w, h, number, caption, align=PP_ALIGN.LEFT):
    add_label(slide, number, x, y, 1700000 if align == PP_ALIGN.LEFT else w, h, size=54, bold=True, color=PRIMARY,
              align=align, font="Cambria")
    cap_x = x + 1700000 if align == PP_ALIGN.LEFT else x
    cap_w = w - 1700000 if align == PP_ALIGN.LEFT else w
    add_label(slide, caption, cap_x, y + 130000, cap_w, h - 130000, size=12.5, color=GREY_TEXT,
               align=PP_ALIGN.LEFT if align == PP_ALIGN.LEFT else PP_ALIGN.CENTER, anchor=MSO_ANCHOR.MIDDLE)


s1 = slides[0]
tb9 = find_shape(s1, "TextBox 9")
if tb9 is not None:
    tf9 = tb9.text_frame
    lines = [
        "",
        "Problem Statement ID – SIH26171",
        "Problem Statement Title- On-device Visual Perception for Light-weight Browser Agents",
        "Theme- Miscellaneous",
        "PS Category- Software",
        "Team ID-",
        "Team Name-HexaBits",
    ]
    for p, text in zip(tf9.paragraphs, lines):
        for r in p.runs[1:]:
            r.text = ""
        if p.runs:
            p.runs[0].text = text
        elif text:
            p.text = text

for idx in range(1, 6):
    s = slides[idx]
    tb = find_shape(s, "TextBox 8")
    if tb is not None:
        remove_shape(tb)
    replace_team_name(s)

# ---------------------------------------------------------------------------
# SLIDE 2 -- Proposed Solution / Architecture pipeline
# ---------------------------------------------------------------------------
s2 = slides[1]
set_title(s2, "FUSION PRIVACY AGENT",
          "On-device redaction + a server LLM that never sees your screen unfiltered.")
add_label(s2, "How it works, end to end:", MARGIN, CONTENT_TOP, SLIDE_W - 2 * MARGIN, 320000, size=13,
          italic=True, color=GREY_TEXT, align=PP_ALIGN.CENTER)

pipe_nodes = [
    ("browser", "Browser Screen", ["Live DOM + on-screen pixels"]),
    ("shield", "Detect + Redact", ["On-device: faces, text, PII"]),
    ("lock", "Sanitized Context", ["Redacted image + DOM manifest"]),
    ("robot", "Cloud LLM Plans", ["Server picks the next action"]),
    ("click", "Extension Executes", ["Click, type, scroll, confirm"]),
]
node_y = 2050000
node_h = 1900000
gap = 150000
node_w = (SLIDE_W - 2 * MARGIN - 4 * gap) / 5
xs = [MARGIN + i * (node_w + gap) for i in range(5)]
for i, (icon, head, bl) in enumerate(pipe_nodes):
    bg = AMBER if i == 3 else PRIMARY
    add_card(s2, xs[i], node_y, node_w, node_h, icon, head, bl, icon_bg=bg)
for i in range(4):
    y = node_y + 150000 + min(420000, node_w * 0.32) / 2
    add_arrow(s2, xs[i] + node_w + 15000, y, xs[i + 1] - 15000, y)

stat_y = node_y + node_h + 300000
stat_w = (SLIDE_W - 2 * MARGIN) / 3
stats2 = [("0", "raw pixels or keystrokes ever leave the device"),
          ("5", "on-device detectors fused into one manifest"),
          ("2", "risk tiers -- routine actions vs. confirm-first")]
for i, (num, cap) in enumerate(stats2):
    add_stat(s2, MARGIN + i * stat_w, stat_y, stat_w, 900000, num, cap, align=PP_ALIGN.LEFT)

# ---------------------------------------------------------------------------
# SLIDE 3 -- Technical Approach / architecture diagram
# ---------------------------------------------------------------------------
s3 = slides[2]
set_title(s3, "TECHNICAL APPROACH",
          "Two swappable halves: an on-device browser client and a server-side planning brain.")
add_label(s3, "A privacy-first, swappable-brain architecture:", MARGIN, CONTENT_TOP, SLIDE_W - 2 * MARGIN, 320000,
          size=13, italic=True, color=GREY_TEXT, align=PP_ALIGN.CENTER)

arch_y = 1900000
arch_h = 2450000
arch_gap = 900000
arch_w = (SLIDE_W - 2 * MARGIN - arch_gap) / 2
left_x = MARGIN
right_x = left_x + arch_w + arch_gap

add_rounded_rect(s3, left_x, arch_y, arch_w, arch_h)
add_icon_circle(s3, "browser", left_x + 500000, arch_y + 420000, 480000)
add_label(s3, "BROWSER -- fully on-device", left_x + 900000, arch_y + 240000, arch_w - 1050000, 400000, size=13,
          bold=True, color=NAVY, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE)
add_label(s3, "• Content script reads the live page\n• Offscreen document runs all ML "
              "(CSP-safe)\n• Side panel + floating pill for chat & voice",
          left_x + 300000, arch_y + 900000, arch_w - 600000, arch_h - 1050000, size=11, color=DARK_TEXT,
          align=PP_ALIGN.LEFT, line_spacing=1.25)

add_rounded_rect(s3, right_x, arch_y, arch_w, arch_h)
add_icon_circle(s3, "server", right_x + 500000, arch_y + 420000, 480000)
add_label(s3, "SERVER -- swappable brain", right_x + 900000, arch_y + 240000, arch_w - 1050000, 400000, size=13,
          bold=True, color=NAVY, align=PP_ALIGN.LEFT, anchor=MSO_ANCHOR.MIDDLE)
add_label(s3, "• FastAPI, one endpoint: get_next_action()\n• Works with OpenAI, Groq, "
              "OpenRouter, or local\n• Never sees a raw pixel or a password",
          right_x + 300000, arch_y + 900000, arch_w - 600000, arch_h - 1050000, size=11, color=DARK_TEXT,
          align=PP_ALIGN.LEFT, line_spacing=1.25)

mid_y1 = arch_y + arch_h / 2 - 120000
mid_y2 = arch_y + arch_h / 2 + 120000
gap_mid_x = left_x + arch_w + arch_gap / 2
label_w = 700000
add_arrow(s3, left_x + arch_w + 40000, mid_y1, right_x - 40000, mid_y1)
add_label(s3, "redacted context only", gap_mid_x - label_w / 2, mid_y1 - 300000, label_w, 260000,
          size=8, italic=True, color=GREY_TEXT)
add_arrow(s3, right_x - 40000, mid_y2, left_x + arch_w + 40000, mid_y2)
add_label(s3, "next action", gap_mid_x - label_w / 2, mid_y2 + 60000, label_w, 260000, size=8,
          italic=True, color=GREY_TEXT)

loop_y = arch_y + arch_h + 320000
loop_stages = [("eye", "Observe"), ("shield", "Redact"), ("robot", "Plan"), ("check", "Confirm"), ("click", "Act")]
loop_w = (SLIDE_W - 2 * MARGIN - 4 * gap) / 5
loop_xs = [MARGIN + i * (loop_w + gap) for i in range(5)]
lcd = 480000
for i, (icon, label) in enumerate(loop_stages):
    cx = loop_xs[i] + loop_w / 2
    add_icon_circle(s3, icon, cx, loop_y + lcd / 2, lcd, bg=PRIMARY if i != 3 else AMBER, icon_scale=0.6)
    add_label(s3, label, loop_xs[i], loop_y + lcd + 40000, loop_w, 300000, size=10.5, bold=True, color=NAVY)
for i in range(4):
    y = loop_y + lcd / 2
    add_arrow(s3, loop_xs[i] + loop_w / 2 + lcd / 2 + 15000, y, loop_xs[i + 1] + loop_w / 2 - lcd / 2 - 15000, y)
add_label(s3, "Loops every step until the task is done, a step limit is hit, or you say stop.",
          MARGIN, loop_y + lcd + 380000, SLIDE_W - 2 * MARGIN, 300000, size=10, italic=True, color=GREY_TEXT)

# ---------------------------------------------------------------------------
# SLIDE 4 -- Feasibility and Viability
# ---------------------------------------------------------------------------
s4 = slides[3]
set_title(s4, "FEASIBILITY AND VIABILITY",
          "Built and stress-tested on real pages -- every failure below was root-caused, not guessed.")
add_label(s4, "From live testing to a resilient pipeline:", MARGIN, CONTENT_TOP, SLIDE_W - 2 * MARGIN, 320000,
          size=13, italic=True, color=GREY_TEXT, align=PP_ALIGN.CENTER)

f_gap = 300000
f_w = (SLIDE_W - 2 * MARGIN - 2 * f_gap) / 3
f_y = 1900000
f_h = 2750000
f_xs = [MARGIN + i * (f_w + f_gap) for i in range(3)]
add_card(s4, f_xs[0], f_y, f_w, f_h, "bolt", "Feasible Now",
         ["Runs on hardware already in\nevery pocket", "No server GPU needed for\nperception",
          "~420MB models, zero network\ncalls at runtime"], icon_bg=PRIMARY)
add_card(s4, f_xs[1], f_y, f_w, f_h, "warn", "Real Challenges Hit",
         ["Model hallucinated CSS\nselectors", "Host CSP silently blocked\nML workers",
          "Unsafe navigation targets"], icon_bg=AMBER)
add_card(s4, f_xs[2], f_y, f_w, f_h, "check", "Fixed By",
         ["Real DOM selectors, not\nguesses", "Isolated chrome.offscreen\ndocument",
          "Client-side URL/action\nvalidation"], icon_bg=PRIMARY)

stat4_y = f_y + f_h + 300000
add_stat(s4, MARGIN, stat4_y, SLIDE_W - 2 * MARGIN, 800000, "3",
         "real bugs found and fixed during live testing -- root-caused from logs, never patched blindly.")

# ---------------------------------------------------------------------------
# SLIDE 5 -- Impact and Benefits
# ---------------------------------------------------------------------------
s5 = slides[4]
set_title(s5, "IMPACT AND BENEFITS",
          "Unlocks AI browser agents for the workflows that matter most: the sensitive ones.")
add_label(s5, "Why it matters:", MARGIN, CONTENT_TOP, SLIDE_W - 2 * MARGIN, 320000, size=13, italic=True,
          color=GREY_TEXT, align=PP_ALIGN.CENTER)

i_gap = 250000
i_w = (SLIDE_W - 2 * MARGIN - 3 * i_gap) / 4
i_y = 1900000
i_h = 2600000
i_xs = [MARGIN + i * (i_w + i_gap) for i in range(4)]
impact_items = [
    ("shield", "Privacy", ["GDPR / DPDP-safe by\narchitecture, not policy"]),
    ("bolt", "Productivity", ["Multi-step browser tasks\nin one sentence"]),
    ("access", "Accessibility", ["Voice-driven, hands-free\ncontrol"]),
    ("eye", "Transparency", ["Every redaction shown\nlive on the real page"]),
]
for i, (icon, head, bl) in enumerate(impact_items):
    add_card(s5, i_xs[i], i_y, i_w, i_h, icon, head, bl)

add_label(s5, "“Privacy by architecture, not by policy.”", MARGIN, i_y + i_h + 350000,
          SLIDE_W - 2 * MARGIN, 500000, size=19, bold=True, italic=True, color=PRIMARY, align=PP_ALIGN.CENTER,
          font="Cambria")

# ---------------------------------------------------------------------------
# SLIDE 6 -- Research and References
# ---------------------------------------------------------------------------
s6 = slides[5]
set_title(s6, "RESEARCH AND REFERENCES",
          "Standing entirely on open, peer-reviewed and industry-standard building blocks.")
add_label(s6, "Built entirely on open-source and industry-standard components:", MARGIN, CONTENT_TOP,
          SLIDE_W - 2 * MARGIN, 320000, size=13, italic=True, color=GREY_TEXT, align=PP_ALIGN.CENTER)

refs = [
    ("cpu", "ONNX Runtime Web"),
    ("code", "Transformers.js (Hugging Face)"),
    ("eye", "MediaPipe BlazeFace (Google)"),
    ("browser", "Ultralytics YOLOv8"),
    ("robot", "Microsoft Florence-2"),
    ("chart", "OpenAI GPT-4o-mini"),
    ("scroll", "Tesseract OCR"),
]
grid_top = 1950000
cols = 4
col_w = (SLIDE_W - 2 * MARGIN) / cols
row_h = 1750000
icon_d6 = 460000
for i, (icon, label) in enumerate(refs):
    col = i % cols
    row = i // cols
    cx = MARGIN + col_w * (col + 0.5)
    cy = grid_top + row * row_h + icon_d6 / 2
    add_icon_circle(s6, icon, cx, cy, icon_d6)
    add_label(s6, label, cx - col_w / 2 + 60000, cy + icon_d6 / 2 + 50000, col_w - 120000, 500000, size=10.5,
              bold=True, color=NAVY, line_spacing=1.1)

add_label(s6, "Problem Statement: SIH 2026 -- PS 26171, “On-device Visual Perception for "
              "Light-weight Browser Agents.”",
          MARGIN, grid_top + 2 * row_h + 150000, SLIDE_W - 2 * MARGIN, 320000, size=10, italic=True,
          color=GREY_TEXT, align=PP_ALIGN.CENTER)

prs.save(OUT)
print("saved", OUT)
