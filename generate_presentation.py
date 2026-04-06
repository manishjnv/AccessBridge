from pathlib import Path
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_AUTO_SIZE, PP_ALIGN
from pptx.util import Emu, Inches, Pt

BG = RGBColor(0x1A, 0x1A, 0x2E)
ACCENT = RGBColor(0x7B, 0x68, 0xEE)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
LIGHT = RGBColor(0xE0, 0xE0, 0xE0)
MUTED = RGBColor(0xA0, 0xA0, 0xB8)
OUTPUT = Path(r"E:/code/AccessBridge/AccessBridge_Presentation.pptx")
SLIDES = [
  {
    "title": "AccessBridge",
    "subtitle": [
      "Ambient Accessibility Operating Layer",
      "Wipro TopGear Ideathon 2026",
      "Team AccessBridge"
    ],
    "centered": True
  },
  {
    "title": "The Problem",
    "bullets": [
      "1.3 billion people with disabilities worldwide",
      "Current tools require disclosure of disability",
      "Solutions are app-specific, not universal",
      "Tools do not adapt to individual user needs",
      "Stigma prevents adoption of assistive technology",
      "Aging population (2.5B) increasingly excluded"
    ]
  },
  {
    "title": "Our Solution",
    "bullets": [
      "Zero-disclosure: no need to identify as disabled",
      "Cross-application: works on ANY website automatically",
      "Learns and adapts from user behavior in real-time",
      "Privacy-first: all processing happens on-device",
      "Chrome extension with zero installation friction"
    ]
  },
  {
    "title": "Architecture",
    "bullets": [
      "Monorepo: @accessbridge/core + extension + ai-engine",
      "Chrome Extension built on Manifest V3",
      "3-tier AI pipeline: local rules > Gemini Flash > Claude",
      "Encrypted IndexedDB user profiles",
      "Event-driven signal pipeline with real-time processing"
    ]
  },
  {
    "title": "Key Innovation: Struggle Detection",
    "bullets": [
      "10 signal types: typing speed, mouse jitter, scroll patterns, error rates, hesitation, backspace ratio, zoom, voice strain, gaze, fatigue",
      "Decision Engine with 11 adaptive rules",
      "Automatic adaptation without user action required",
      "Continuous learning from behavioral patterns"
    ]
  },
  {
    "title": "Feature: Cognitive Support",
    "bullets": [
      "Focus mode removes page distractions",
      "Distraction shield for deep work sessions",
      "Reading guide overlay for tracking text",
      "AI-powered page and email summarization",
      "Text simplification with Flesch-Kincaid targeting"
    ]
  },
  {
    "title": "Feature: Motor Assistance",
    "bullets": [
      "20+ voice commands in English and Hindi",
      "Dwell click for users with motor impairments",
      "Eye tracking via FaceDetector API",
      "Full keyboard-only navigation mode",
      "Predictive input with smart suggestions"
    ]
  },
  {
    "title": "Feature: Sensory Adaptation",
    "bullets": [
      "High contrast themes (multiple profiles)",
      "Dynamic font scaling across all content",
      "Text-to-speech via Web Speech API",
      "Reduced motion mode for vestibular sensitivity",
      "Color filters for various types of color blindness"
    ]
  },
  {
    "title": "Feature: Fatigue-Adaptive UI",
    "bullets": [
      "4 progressive levels of page simplification",
      "Level 1 - Subtle: larger targets, simpler navigation",
      "Level 2 - Moderate: reduce content, increase spacing",
      "Level 3 - Significant: auto-summarize, simplify layout",
      "Level 4 - Maximum: essential content only, break reminders"
    ]
  },
  {
    "title": "Domain Intelligence",
    "bullets": [
      "Banking: jargon decoder, form assistance, Indian numbering",
      "Insurance: policy simplifier, claims assistant, comparison tool",
      "Extensible connector architecture for any domain",
      "Context-aware assistance tailored to each vertical"
    ]
  },
  {
    "title": "AI Engine",
    "bullets": [
      "3-tier cost optimization: free local > Gemini Flash > Claude",
      "Intelligent response caching and request deduplication",
      "Cost tracking with configurable daily budgets",
      "Graceful degradation when budget is exhausted",
      "Sub-100ms response time for local tier"
    ]
  },
  {
    "title": "Testing & Quality",
    "bullets": [
      "116 unit tests passing across all packages",
      "TypeScript strict mode enabled throughout",
      "Zero build errors with clean CI on every push",
      "Automated CI/CD deployment pipeline",
      "Comprehensive coverage for critical paths"
    ]
  },
  {
    "title": "Tech Stack",
    "bullets": [
      "Chrome Extension on Manifest V3",
      "TypeScript / React / Vite",
      "pnpm monorepo architecture",
      "IndexedDB for encrypted local storage",
      "Web Speech API / MediaPipe / FaceDetector",
      "Vitest for unit and integration testing"
    ]
  },
  {
    "title": "Impact & Market",
    "bullets": [
      "TAM: 1.3B disabled + 2.5B aging = 3.8B potential users",
      "Zero-disclosure removes stigma barrier entirely",
      "Works on any website with no integration required",
      "Privacy-first: no data ever leaves the device",
      "B2B potential: enterprise accessibility compliance"
    ]
  },
  {
    "title": "Demo & Links",
    "bullets": [
      "Live Chrome extension demo available",
      "GitHub: github.com/manishjnv/AccessBridge",
      "Deployed: accessbridge.live",
      "",
      "Thank you!"
    ],
    "centered_bullets": True
  }
]


def add_background(slide, prs):
    bg = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, prs.slide_width, prs.slide_height)
    bg.fill.solid()
    bg.fill.fore_color.rgb = BG
    bg.line.fill.background()
    bar_h = Emu(int(0.08 * 914400))
    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, prs.slide_height - bar_h, prs.slide_width, bar_h)
    bar.fill.solid()
    bar.fill.fore_color.rgb = ACCENT
    bar.line.fill.background()


def style_run(run, size, color, bold=False, font_name="Calibri"):
    run.font.name = font_name
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color


def add_slide_number(slide, prs, number):
    box = slide.shapes.add_textbox(prs.slide_width - Inches(1.0), prs.slide_height - Emu(int(0.08 * 914400)) - Inches(0.35), Inches(0.8), Inches(0.3))
    tf = box.text_frame
    tf.clear()
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.RIGHT
    r = p.add_run()
    r.text = str(number)
    style_run(r, 11, MUTED)


def add_title_slide(slide, prs, data):
    box = slide.shapes.add_textbox(Inches(1.0), Inches(1.6), Inches(11.33), Inches(1.8))
    tf = box.text_frame
    tf.clear()
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    r = p.add_run()
    r.text = data["title"]
    style_run(r, 52, WHITE, bold=True)
    line_w = Inches(4.0)
    line_x = (prs.slide_width - line_w) // 2
    line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, line_x, Inches(3.35), line_w, Emu(int(0.04 * 914400)))
    line.fill.solid()
    line.fill.fore_color.rgb = ACCENT
    line.line.fill.background()
    box2 = slide.shapes.add_textbox(Inches(1.4), Inches(3.7), Inches(10.5), Inches(2.5))
    tf2 = box2.text_frame
    tf2.clear()
    tf2.word_wrap = True
    tf2.auto_size = MSO_AUTO_SIZE.NONE
    for i, line_text in enumerate(data["subtitle"]):
        p = tf2.paragraphs[0] if i == 0 else tf2.add_paragraph()
        p.alignment = PP_ALIGN.CENTER
        p.space_after = Pt(6)
        r = p.add_run()
        r.text = line_text
        if i == 0:
            style_run(r, 24, ACCENT, bold=True)
        elif i == 1:
            style_run(r, 20, LIGHT)
        else:
            style_run(r, 18, MUTED)


def add_content_slide(slide, prs, data, slide_num):
    box = slide.shapes.add_textbox(Inches(0.8), Inches(0.5), Inches(11.7), Inches(1.0))
    tf = box.text_frame
    tf.clear()
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.LEFT
    r = p.add_run()
    r.text = data["title"]
    style_run(r, 34, WHITE, bold=True)
    line = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(0.8), Inches(1.48), Inches(2.2), Emu(int(0.04 * 914400)))
    line.fill.solid()
    line.fill.fore_color.rgb = ACCENT
    line.line.fill.background()
    centered = data.get("centered_bullets", False)
    left = Inches(2.0) if centered else Inches(1.0)
    width = Inches(9.3) if centered else Inches(11.2)
    box = slide.shapes.add_textbox(left, Inches(1.95), width, Inches(5.0))
    tf = box.text_frame
    tf.clear()
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    for i, bullet in enumerate(data["bullets"]):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.space_after = Pt(10)
        p.space_before = Pt(2)
        p.line_spacing = 1.2
        if centered:
            p.alignment = PP_ALIGN.CENTER
        else:
            p.alignment = PP_ALIGN.LEFT
        if not bullet:
            r = p.add_run()
            r.text = " "
            style_run(r, 14, BG)
            continue
        if not centered:
            marker = p.add_run()
            marker.text = chr(9656) + "  "
            style_run(marker, 19, ACCENT, bold=True)
        r = p.add_run()
        r.text = bullet
        has_number = any(ch.isdigit() for ch in bullet)
        is_emphasis = any(kw in bullet for kw in ["ANY", "TAM:", "Zero", "3-tier", "116", "20+", "10 signal"])
        if bullet == "Thank you!":
            style_run(r, 28, ACCENT, bold=True)
        elif has_number or is_emphasis:
            style_run(r, 19, WHITE, bold=True)
        else:
            style_run(r, 19, LIGHT)
    add_slide_number(slide, prs, slide_num)


def build_presentation():
    prs = Presentation()
    prs.slide_width = Emu(round(13.333 * 914400))
    prs.slide_height = Inches(7.5)
    blank_layout = prs.slide_layouts[6]
    for i, slide_data in enumerate(SLIDES):
        slide = prs.slides.add_slide(blank_layout)
        add_background(slide, prs)
        if slide_data.get("centered") and "subtitle" in slide_data:
            add_title_slide(slide, prs, slide_data)
            add_slide_number(slide, prs, i + 1)
        else:
            add_content_slide(slide, prs, slide_data, i + 1)
    prs.save(str(OUTPUT))
    print(f"Presentation saved: {OUTPUT}")
    print(f"Total slides: {len(SLIDES)}")


if __name__ == "__main__":
    build_presentation()
