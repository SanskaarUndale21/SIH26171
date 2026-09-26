"""
Fills slides 2-6 of the official SIH template using the plain layout shown in
the official SIH example deck (sih2024-...pdf): thin blue-bordered boxes,
plain paragraph/bullet text, no icons or card graphics.
Slide 1 (title) and slide 7 (instructions) are fixed/left as-is.
"""
from pptx import Presentation
from pptx.util import Emu, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR, MSO_AUTO_SIZE
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.oxml.ns import qn

SRC = "../SIH2026-IDEA-Presentation-Format.pptx"
OUT = "../SIH2026-IDEA-Presentation-HexaBits.pptx"

BLUE = RGBColor(0x00, 0x70, 0xC0)
BLACK = RGBColor(0x00, 0x00, 0x00)
BORDER = RGBColor(0x8E, 0xB4, 0xD8)

SLIDE_W = 12192000
MARGIN = 480000
TITLE_X = 1700000
TITLE_W = 8000000

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


def set_title(slide, text):
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


def add_label(slide, text, x, y, w, h, size=13, bold=False, color=BLACK, align=PP_ALIGN.LEFT,
              italic=False, font="Calibri", anchor=MSO_ANCHOR.TOP, line_spacing=1.15, space_after=8):
    tb = slide.shapes.add_textbox(Emu(int(x)), Emu(int(y)), Emu(int(w)), Emu(int(h)))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = 0
    tf.margin_right = 0
    tf.margin_top = 0
    tf.margin_bottom = 0
    tf.vertical_anchor = anchor
    lines = text.split("\n")
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = line_spacing
        p.space_after = Pt(space_after)
        run = p.add_run()
        run.text = line
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.italic = italic
        run.font.name = font
        run.font.color.rgb = color
    return tb


def add_bordered_box(slide, x, y, w, h):
    rect = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Emu(int(x)), Emu(int(y)), Emu(int(w)), Emu(int(h)))
    rect.fill.solid()
    rect.fill.fore_color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    rect.line.color.rgb = BORDER
    rect.line.width = Pt(1)
    rect.shadow.inherit = False
    return rect


def add_arrow(slide, x1, y1, x2, y2, color=RGBColor(0x40, 0x40, 0x40), weight=1.5):
    conn = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Emu(int(x1)), Emu(int(y1)), Emu(int(x2)), Emu(int(y2)))
    conn.line.color.rgb = color
    conn.line.width = Pt(weight)
    ln = conn.line._get_or_add_ln()
    ln.append(ln.makeelement(qn("a:tailEnd"), {"type": "triangle", "w": "med", "len": "med"}))
    return conn


def add_flow_box(slide, x, y, w, h, text, fill=RGBColor(0xDD, 0xEB, 0xF7)):
    rect = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Emu(int(x)), Emu(int(y)), Emu(int(w)), Emu(int(h)))
    rect.fill.solid()
    rect.fill.fore_color.rgb = fill
    rect.line.color.rgb = BLUE
    rect.line.width = Pt(1)
    rect.shadow.inherit = False
    try:
        rect.adjustments[0] = 0.12
    except Exception:
        pass
    tf = rect.text_frame
    tf.word_wrap = True
    tf.margin_left = Emu(40000)
    tf.margin_right = Emu(40000)
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = text
    run.font.size = Pt(10.5)
    run.font.bold = True
    run.font.color.rgb = RGBColor(0x1E, 0x27, 0x61)
    run.font.name = "Calibri"
    return rect


for idx in range(1, 6):
    s = slides[idx]
    tb = find_shape(s, "TextBox 8")
    if tb is not None:
        remove_shape(tb)
    replace_team_name(s)

# fix title slide problem statement details (source template had wrong PS id/theme)
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

# ---------------------------------------------------------------------------
# SLIDE 2 -- IDEA TITLE (two bordered boxes, like the PDF example)
# ---------------------------------------------------------------------------
s2 = slides[1]
set_title(s2, "IDEA TITLE")

box_y = 1350000
box_h = 4750000
box_gap = 350000
box_w = (SLIDE_W - 2 * MARGIN - box_gap) / 2
left_x = MARGIN
right_x = left_x + box_w + box_gap

add_bordered_box(s2, left_x, box_y, box_w, box_h)
add_label(s2, "IDEA / SOLUTION :", left_x + 220000, box_y + 220000, box_w - 440000, 400000,
          size=15, bold=False, color=BLUE)
add_label(s2, "Browsers now hand cloud AI agents full screenshots and raw DOM content to plan "
              "every click, so passwords, personal data and confidential business text leak with "
              "every automated action. A privacy-first browser agent must plan and act without ever "
              "exposing what is on the sensitive parts of the screen.",
          left_x + 220000, box_y + 750000, box_w - 440000, box_h - 950000, size=12.5, color=BLACK)

add_bordered_box(s2, right_x, box_y, box_w, box_h)
add_label(s2, "Problem Resolution :", right_x + 220000, box_y + 220000, box_w - 440000, 400000,
          size=15, bold=False, color=BLUE)
pr_body = ("We built a Privacy-Preserving Browser Agent that fuses on-device detectors "
           "(regex + NER + vision) inside the extension itself. The system:\n"
           "• Redacts PII locally before any pixel or DOM leaves the device\n"
           "• Fuses overlapping detections with confidence scoring instead of first-hit-wins\n"
           "• Lets a cloud LLM plan the next browser action from sanitized context only\n"
           "• Executes the action back in the browser (click, type, scroll, confirm)")
add_label(s2, pr_body, right_x + 220000, box_y + 750000, box_w - 440000, box_h - 950000, size=12,
          color=BLACK, space_after=10)

# ---------------------------------------------------------------------------
# SLIDE 3 -- TECHNICAL APPROACH (bordered box + plain flow diagram)
# ---------------------------------------------------------------------------
s3 = slides[2]
set_title(s3, "TECHNICAL APPROACH")

t_y = 1350000
t_h = 4750000
t_gap = 350000
t_left_w = (SLIDE_W - 2 * MARGIN - t_gap) * 0.42
t_right_w = (SLIDE_W - 2 * MARGIN - t_gap) - t_left_w
t_left_x = MARGIN
t_right_x = t_left_x + t_left_w + t_gap

add_bordered_box(s3, t_left_x, t_y, t_left_w, t_h)
approach_body = (
    "Title: System Architecture & Workflow\n"
    "Content:\n"
    "A high-level architecture with three components:\n"
    "• Browser Extension (Frontend): content script reads the live DOM + pixels, runs "
    "on-device redaction (regex, NER, vision) inside an isolated offscreen document.\n"
    "• FastAPI Server (Planning Brain): stateless endpoint that receives only the sanitized "
    "context and returns the next action.\n"
    "• Side Panel / Floating Pill (UI): persistent chat-style interface for user interaction "
    "and voice control.\n"
    "Data flow:\n"
    "Browser screen → Detect & redact → Sanitized context → Cloud LLM plans → "
    "Extension executes → loops until done."
)
add_label(s3, approach_body, t_left_x + 220000, t_y + 220000, t_left_w - 440000, t_h - 440000,
          size=11, bold=False, color=BLACK, space_after=8)

add_label(s3, "PROCESS FLOW ARCHITECTURE", t_right_x, t_y, t_right_w, 340000, size=13, bold=True,
          color=BLUE)

flow_nodes = ["Browser\nScreen", "Detect &\nRedact\n(on-device)", "Sanitized\nContext", "Cloud LLM\nPlans",
              "Extension\nExecutes"]
fn = len(flow_nodes)
fnode_w = t_right_w
fnode_h = 620000
fgap = 190000
total_h = fn * fnode_h + (fn - 1) * fgap
fstart_y = t_y + 480000
for i, label in enumerate(flow_nodes):
    fy = fstart_y + i * (fnode_h + fgap)
    fill = RGBColor(0xFF, 0xE8, 0xC2) if i in (1, 3) else RGBColor(0xDD, 0xEB, 0xF7)
    add_flow_box(s3, t_right_x, fy, fnode_w, fnode_h, label, fill=fill)
    if i < fn - 1:
        add_arrow(s3, t_right_x + fnode_w / 2, fy + fnode_h, t_right_x + fnode_w / 2, fy + fnode_h + fgap)

# ---------------------------------------------------------------------------
# SLIDE 4 -- FEASIBILITY AND VIABILITY (plain bullets, like the PDF)
# ---------------------------------------------------------------------------
s4 = slides[3]
set_title(s4, "FEASIBILITY AND VIABILITY")

fy0 = 1450000
add_label(s4, "• Analysis of the feasibility of the idea", MARGIN, fy0, SLIDE_W - 2 * MARGIN, 400000,
          size=15, color=BLACK)
add_label(s4,
          "Technical: runs on-device with lightweight, quantized models — no server GPU needed for "
          "perception.  Financial: near-zero inference cost on an open-source stack (Transformers.js, "
          "MediaPipe, Tesseract).  Market: applies to any AI browser agent that needs a real privacy "
          "guarantee.  Operational: ships as a browser extension, no changes needed on the sites being "
          "automated.",
          MARGIN + 350000, fy0 + 420000, SLIDE_W - 2 * MARGIN - 350000, 900000, size=11.5,
          color=RGBColor(0x33, 0x33, 0x33))

fy1 = fy0 + 1500000
add_label(s4, "• Potential challenges and risks", MARGIN, fy1, SLIDE_W - 2 * MARGIN, 400000,
          size=15, color=BLACK)
add_label(s4,
          "Technical: false negatives in PII detection, CSP blocking on-device ML workers, unsafe "
          "navigation targets.  Financial: none significant — open-source stack.  Market: enterprise "
          "adoption needs a security audit.  Operational: keeping detector models current as new PII "
          "patterns emerge.",
          MARGIN + 350000, fy1 + 420000, SLIDE_W - 2 * MARGIN - 350000, 900000, size=11.5,
          color=RGBColor(0x33, 0x33, 0x33))

fy2 = fy1 + 1500000
add_label(s4, "• Strategies for overcoming these challenges", MARGIN, fy2, SLIDE_W - 2 * MARGIN, 400000,
          size=15, color=BLACK)
add_label(s4,
          "Confidence fusion (noisy-OR) across detectors with fail-safe redaction below threshold, "
          "DOM-confirmed-safe zones to cut false positives, an isolated chrome.offscreen document to "
          "dodge CSP, and client-side URL/action validation before every navigation.",
          MARGIN + 350000, fy2 + 420000, SLIDE_W - 2 * MARGIN - 350000, 900000, size=11.5,
          color=RGBColor(0x33, 0x33, 0x33))

# ---------------------------------------------------------------------------
# SLIDE 5 -- IMPACT AND BENEFITS (plain bold-keyword paragraphs, like the PDF)
# ---------------------------------------------------------------------------
s5 = slides[4]
set_title(s5, "IMPACT AND BENEFITS")


def add_bold_lead(slide, x, y, w, h, bold_text, rest_text, size=14.5):
    tb = slide.shapes.add_textbox(Emu(int(x)), Emu(int(y)), Emu(int(w)), Emu(int(h)))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = 0
    tf.margin_top = 0
    p = tf.paragraphs[0]
    p.line_spacing = 1.2
    r1 = p.add_run()
    r1.text = bold_text
    r1.font.bold = True
    r1.font.size = Pt(size)
    r1.font.color.rgb = BLACK
    r1.font.name = "Calibri"
    r2 = p.add_run()
    r2.text = rest_text
    r2.font.bold = False
    r2.font.size = Pt(size)
    r2.font.color.rgb = BLACK
    r2.font.name = "Calibri"
    return tb


impact_y = 1500000
impact_gap = 780000
impacts = [
    ("Privacy: ", "zero raw pixels or keystrokes ever leave the device — safe by architecture, not policy."),
    ("Efficiency: ", "no manual redaction step slows the agent down; detection and redaction run inline."),
    ("Scalability: ", "works across any website; the planning brain is swappable across OpenAI, Groq, "
                       "OpenRouter, or a local LLM."),
    ("Accessibility: ", "voice-driven, hands-free control through the side panel and floating pill."),
]
for i, (b, r) in enumerate(impacts):
    add_bold_lead(s5, MARGIN, impact_y + i * impact_gap, SLIDE_W - 2 * MARGIN, 700000, b, r)

# ---------------------------------------------------------------------------
# SLIDE 6 -- RESEARCH AND REFERENCES (plain list, like the PDF)
# ---------------------------------------------------------------------------
s6 = slides[5]
set_title(s6, "RESEARCH  AND REFERENCES")

add_label(s6, "• Details / Links of the reference and research work", MARGIN, 1500000,
          SLIDE_W - 2 * MARGIN, 400000, size=15, color=BLACK)

refs_text = (
    "ONNX Runtime Web  •  Transformers.js (Hugging Face)  •  MediaPipe BlazeFace (Google)  "
    "•  Tesseract OCR  •  Ultralytics YOLOv8"
)
add_label(s6, refs_text, MARGIN, 2150000, SLIDE_W - 2 * MARGIN, 800000, size=13, color=BLACK,
          line_spacing=1.3)

add_label(s6, "Problem Statement: SIH 2026 — PS 26171, “On-device Visual Perception for "
              "Light-weight Browser Agents.”",
          MARGIN, 3100000, SLIDE_W - 2 * MARGIN, 500000, size=12, italic=True,
          color=RGBColor(0x55, 0x60, 0x70))

prs.save(OUT)
print("saved", OUT)
