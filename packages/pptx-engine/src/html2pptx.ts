/**
 * html2pptx - Convert a single-slide HTML into single-slide pptx bytes.
 *
 * Used by the slides cloud generation pipeline (Cycle 1, Task A): deepseek
 * generates HTML conforming to a constrained format, and this module converts
 * it to a single-slide pptx that mergeSlideFromPptx can merge into the target deck.
 *
 * Design gap from reference (davila7/claude-code-templates html2pptx.js):
 *   The reference uses Playwright (browser) to render HTML and read computed
 *   positions via getBoundingClientRect + getComputedStyle. This implementation
 *   uses cheerio (no browser), so it reads inline `style` attributes only and
 *   requires `position:absolute` with left/top/width/height in px. Flexbox is
 *   NOT supported (the deepseek system prompt instructs position:absolute).
 *   See technical-design-slides.md §5.6 for the supported feature matrix.
 *
 * Element mapping (confirmed against reference html2pptx.js + html2pptx.md):
 *   <p>/<h1>-<h6>  -> addText (text runs with font options)
 *   <ul>/<ol>      -> addText (LI items become bulleted/numbered paragraphs)
 *   <div> w/ bg    -> addText('', { shape:'rect', fill, line }) (shape element)
 *   <img src>      -> fetch URL -> base64 -> addImage (failures -> imageFailures)
 *
 * Unit conversion (matches reference constants):
 *   x/y/w/h:  px -> inches  (/96, PX_PER_IN=96)
 *   fontSize: px -> pt      (*0.75, PT_PER_PX=0.75)
 *   color:    #RRGGBB -> RRGGBB (strip #)
 */
import PptxGenJS from 'pptxgenjs'
import * as cheerio from 'cheerio'
// cheerio re-exports its node types from domhandler but doesn't export them from
// the package root; Element comes from domhandler directly (cheerio dep).
import type { Element } from 'domhandler'

// ── Public interface ───────────────────────────────────────────────────

export interface Html2PptxOptions {
  /** Canvas width in px (e.g. 1280). Used as fallback when root div has no inline width. */
  width: number
  /** Canvas height in px (e.g. 720). Used as fallback when root div has no inline height. */
  height: number
}

export interface Html2PptxImageFailure {
  /** The image URL that failed to download. */
  url: string
  /** Human-readable failure reason (HTTP status, network error, etc.). */
  reason: string
}

export interface Html2PptxResult {
  /** Single-slide pptx bytes, consumable by mergeSlideFromPptx. */
  bytes: Uint8Array
  /** Image URLs that failed to download; the slide still generated without them. */
  imageFailures: Html2PptxImageFailure[]
}

// ── Constants (match reference html2pptx.js) ───────────────────────────

const PX_PER_IN = 96
const PT_PER_PX = 0.75

// Default heading font sizes in px (when h1-h6 omit font-size in inline style).
// Matches technical-design-slides.md §5.2 ("fontSize 从 style 解析或默认 28/24/20/18/16/14px").
const HEADING_DEFAULT_PX: Record<string, number> = {
  h1: 28,
  h2: 24,
  h3: 20,
  h4: 18,
  h5: 16,
  h6: 14,
}

// ── Public entry point ─────────────────────────────────────────────────

/**
 * Convert a single-slide HTML string into single-slide pptx bytes.
 *
 * The HTML must have a root `<div>` (with inline width/height/background-color)
 * containing absolutely-positioned children. See technical-design-slides.md §5
 * for the format contract.
 */
export async function html2pptx(html: string, opts: Html2PptxOptions): Promise<Html2PptxResult> {
  const $ = cheerio.load(html)

  // Tolerate wrapper tags (<html>/<body>): find the first <div> as root.
  // TODO(design-gap): reference validates body dimensions match pres layout;
  // we skip that check (no browser to compute scroll dimensions for overflow).
  const root = $('div').first()
  if (!root.length) throw new Error('html2pptx: no root <div> found in HTML')

  const rootStyle = parseInlineStyle(root.attr('style') ?? '')
  const widthPx = parsePx(rootStyle.width) ?? opts.width
  const heightPx = parsePx(rootStyle.height) ?? opts.height
  const bgColor = normalizeColor(rootStyle['background-color'] ?? rootStyle.background)

  const pptx = new PptxGenJS()
  // Layout name must be custom (1280x720 px = 13.333"x7.5"); matches merge-slide.test.ts:18
  pptx.defineLayout({ name: 'GENOFFICE', width: widthPx / PX_PER_IN, height: heightPx / PX_PER_IN })
  pptx.layout = 'GENOFFICE'
  const slide = pptx.addSlide()
  if (bgColor) slide.background = { color: bgColor }

  const imageFailures: Html2PptxImageFailure[] = []
  const processed = new Set<Element>()

  // Traverse all descendants of root in document order (mirrors reference's
  // document.querySelectorAll('*') + processed Set pattern).
  for (const el of root.find('*').toArray()) {
    if (processed.has(el)) continue
    const tagName = (el.tagName ?? '').toLowerCase()

    // Images: fetch + embed or record failure
    if (tagName === 'img') {
      await addImageFromElement($, el, slide, imageFailures)
      processed.add(el)
      continue
    }

    // Lists: collect LI runs into one addText with bullets
    if (tagName === 'ul' || tagName === 'ol') {
      addListFromElement($, el, slide, tagName === 'ol')
      processed.add(el)
      // Mark LI children processed so they aren't double-emitted as text
      for (const li of $(el).find('li').toArray()) processed.add(li)
      continue
    }

    // Text elements: p, h1-h6
    if (tagName === 'p' || /^h[1-6]$/.test(tagName)) {
      addTextFromElement($, el, slide, tagName)
      processed.add(el)
      continue
    }

    // Div with background/border -> shape
    if (tagName === 'div') {
      addShapeFromElement($, el, slide)
      processed.add(el)
      continue
    }
    // Other tags (span, b, i, u outside a text parent, etc.) are not top-level
    // convertible elements; they're handled inside addTextFromElement's inline
    // run parser. Skip them here.
  }

  const buf = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer
  // Buffer extends Uint8Array; new Uint8Array(buf) copies bytes into a plain Uint8Array
  // (matches merge-slide.test.ts:23-24 pattern).
  return { bytes: new Uint8Array(buf), imageFailures }
}

// ── Element handlers ───────────────────────────────────────────────────

/** `<img src>` -> fetch URL -> base64 -> slide.addImage; failures -> imageFailures. */
async function addImageFromElement(
  $: cheerio.CheerioAPI,
  el: Element,
  slide: PptxGenJS.Slide,
  imageFailures: Html2PptxImageFailure[],
): Promise<void> {
  const src = $(el).attr('src')
  if (!src) {
    imageFailures.push({ url: '', reason: 'missing src attribute' })
    return
  }
  const style = parseInlineStyle($(el).attr('style') ?? '')
  const pos = resolvePosition(style)
  if (!pos) return // position:absolute with left/top/width/height is required
  try {
    const resp = await fetch(src)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const ab = await resp.arrayBuffer()
    const mime = resp.headers.get('content-type') ?? 'image/png'
    const b64 = Buffer.from(ab).toString('base64')
    slide.addImage({
      data: `${mime};base64,${b64}`,
      x: pos.x,
      y: pos.y,
      w: pos.w,
      h: pos.h,
    })
  } catch (e) {
    imageFailures.push({
      url: src,
      reason: e instanceof Error ? e.message : String(e),
    })
  }
}

/** `<ul>`/`<ol>` -> one addText call with LI items as bullet/number paragraphs. */
function addListFromElement(
  $: cheerio.CheerioAPI,
  el: Element,
  slide: PptxGenJS.Slide,
  ordered: boolean,
): void {
  const style = parseInlineStyle($(el).attr('style') ?? '')
  const pos = resolvePosition(style)
  if (!pos) return
  const items = $(el).find('li').toArray()
  if (items.length === 0) return

  const baseOpts = baseTextOptions(style, 'p')
  const runs: PptxGenJS.TextProps[] = []
  items.forEach((li, idx) => {
    const liRuns = parseInlineRuns($, li, baseOpts)
    if (liRuns.length === 0) {
      liRuns.push({ text: '', options: toTextPropsOptions(baseOpts) })
    }
    // First run of each LI gets the bullet; reference uses { indent } for bullet position.
    liRuns[0]!.options = {
      ...liRuns[0]!.options,
      bullet: ordered ? { type: 'number' } : true,
    }
    // Last run of each LI (except the last item) breaks to a new line.
    if (idx < items.length - 1) {
      const last = liRuns[liRuns.length - 1]!
      last.options = { ...last.options, breakLine: true }
    }
    runs.push(...liRuns)
  })

  slide.addText(runs, { x: pos.x, y: pos.y, w: pos.w, h: pos.h, valign: 'top' })
}

/** `<p>`/`<h1>`-`<h6>` -> addText with inline formatting parsed into runs. */
function addTextFromElement(
  $: cheerio.CheerioAPI,
  el: Element,
  slide: PptxGenJS.Slide,
  tagName: string,
): void {
  const style = parseInlineStyle($(el).attr('style') ?? '')
  const pos = resolvePosition(style)
  if (!pos) return
  const baseOpts = baseTextOptions(style, tagName)
  const text = $(el).text().trim()
  if (!text) return

  const hasInlineFmt = $(el).find('b, i, u, strong, em, span, br').length > 0
  if (hasInlineFmt) {
    const runs = parseInlineRuns($, el, baseOpts)
    if (runs.length > 0) {
      slide.addText(runs, { x: pos.x, y: pos.y, w: pos.w, h: pos.h, valign: 'top' })
      return
    }
  }
  slide.addText(text, {
    x: pos.x,
    y: pos.y,
    w: pos.w,
    h: pos.h,
    valign: 'top',
    ...toTextPropsOptions(baseOpts),
  })
}

/** `<div>` with background/border -> addText('', { shape:'rect', fill, line }). */
function addShapeFromElement($: cheerio.CheerioAPI, el: Element, slide: PptxGenJS.Slide): void {
  const style = parseInlineStyle($(el).attr('style') ?? '')
  const pos = resolvePosition(style)
  if (!pos) return
  const fill = normalizeColor(style['background-color'] ?? style.background)
  const borderColor = normalizeColor(style['border-color'] ?? style['border-top-color'])
  const borderWidthPx = parsePx(style['border-width'] ?? style['border-top-width'])
  // Only emit a shape if there's a fill or border; otherwise the div is a pure
  // layout container (no visual) and emitting an empty transparent shape would
  // pollute the slide. Text children are handled by their own addTextFromElement.
  if (!fill && !borderColor) return

  const shapeOpts: PptxGenJS.ShapeProps = {
    x: pos.x,
    y: pos.y,
    w: pos.w,
    h: pos.h,
  }
  if (fill) shapeOpts.fill = { color: fill }
  if (borderColor && borderWidthPx !== undefined) {
    shapeOpts.line = { color: borderColor, width: borderWidthPx * PT_PER_PX }
  }
  slide.addShape('rect' as PptxGenJS.SHAPE_NAME, shapeOpts)
}

// ── Inline formatting parser (b/i/u/strong/em/span -> runs) ────────────

interface RunOptions {
  fontSize?: number
  fontFace?: string
  color?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  align?: 'left' | 'center' | 'right'
}

/**
 * Convert internal RunOptions to pptxgenjs TextPropsOptions at the boundary.
 * pptxgenjs v4 types underline as { style, color } only (its runtime still
 * normalizes boolean true to { style: 'sng' }, see pptxgen.es.js, but the
 * type rejects it), so boolean underline maps to the object form here.
 */
function toTextPropsOptions(o: RunOptions): PptxGenJS.TextPropsOptions {
  const { underline, ...rest } = o
  return {
    ...rest,
    ...(underline ? { underline: { style: 'sng' } } : {}),
  }
}

/**
 * Parse inline formatting tags into pptxgenjs text runs.
 *
 * Walks child nodes of `el`; text nodes become runs with base options, and
 * `<b>`/`<strong>` (bold), `<i>`/`<em>` (italic), `<u>` (underline), `<span>`
 * (style-derived color/font-size/weight/style/decoration) override base options.
 *
 * TODO(design-gap): the reference reads computed styles for inline elements
 * (inheritance-aware). We read inline `style` only, so a <span> without inline
 * style inherits the parent text element's options (correct for most cases).
 */
function parseInlineRuns(
  $: cheerio.CheerioAPI,
  el: Element,
  baseOpts: RunOptions,
): PptxGenJS.TextProps[] {
  const runs: PptxGenJS.TextProps[] = []
  for (const node of el.childNodes ?? []) {
    if (node.type === 'text') {
      const text = (node as unknown as { data?: string }).data ?? ''
      const collapsed = text.replace(/\s+/g, ' ')
      if (collapsed) runs.push({ text: collapsed, options: toTextPropsOptions(baseOpts) })
    } else if (node.type === 'tag') {
      const childEl = node as Element
      const childTag = childEl.tagName.toLowerCase()
      if (childTag === 'br') {
        runs.push({ text: '\n', options: { ...toTextPropsOptions(baseOpts), breakLine: true } })
        continue
      }
      const inlineOpts: RunOptions = { ...baseOpts }
      if (childTag === 'b' || childTag === 'strong') inlineOpts.bold = true
      if (childTag === 'i' || childTag === 'em') inlineOpts.italic = true
      if (childTag === 'u') inlineOpts.underline = true
      if (childTag === 'span') {
        const spanStyle = parseInlineStyle($(childEl).attr('style') ?? '')
        const spanColor = normalizeColor(spanStyle.color)
        if (spanColor) inlineOpts.color = spanColor
        const spanFontPx = parsePx(spanStyle['font-size'])
        if (spanFontPx !== undefined) inlineOpts.fontSize = spanFontPx * PT_PER_PX
        const fw = spanStyle['font-weight']
        if (fw === 'bold' || (fw && parseInt(fw, 10) >= 600)) inlineOpts.bold = true
        if (spanStyle['font-style'] === 'italic') inlineOpts.italic = true
        if ((spanStyle['text-decoration'] ?? '').includes('underline')) inlineOpts.underline = true
      }
      // Recurse: nested inline tags flatten into sequential runs.
      const childRuns = parseInlineRuns($, childEl, inlineOpts)
      runs.push(...childRuns)
    }
  }
  // Trim leading/trailing whitespace from first/last run (mirror reference).
  if (runs.length > 0) {
    runs[0]!.text = (runs[0]!.text ?? '').replace(/^\s+/, '')
    const last = runs[runs.length - 1]!
    last.text = (last.text ?? '').replace(/\s+$/, '')
  }
  return runs.filter((r) => (r.text ?? '').length > 0)
}

// ── Style + position helpers ───────────────────────────────────────────

interface ResolvedPosition {
  x: number // inches
  y: number // inches
  w: number // inches
  h: number // inches
}

/**
 * Parse position:absolute inline style into inches.
 *
 * `left`/`top`/`width` are required. `height` is optional: when omitted (deepseek
 * often omits height on single-line text), it defaults to fontSize * 1.5 px (one
 * line + padding), mirroring the reference's `lineHeight = fontSize * 1.2` heuristic.
 *
 * Returns undefined when position is not absolute or left/top/width are missing
 * (the system prompt instructs deepseek to always set these on leaf elements).
 */
function resolvePosition(
  style: Record<string, string>,
  tagName?: string,
): ResolvedPosition | undefined {
  // position:absolute is required; relative/static elements have no predictable coords
  // without a browser layout engine.
  if (style.position !== 'absolute') return undefined
  const leftPx = parsePx(style.left)
  const topPx = parsePx(style.top)
  const widthPx = parsePx(style.width)
  if (leftPx === undefined || topPx === undefined || widthPx === undefined) return undefined
  let heightPx = parsePx(style.height)
  if (heightPx === undefined) {
    // Fallback: one line of text. Use font-size from style or heading default.
    const fontPx = parsePx(style['font-size']) ?? HEADING_DEFAULT_PX[tagName ?? ''] ?? 16
    heightPx = fontPx * 1.5
  }
  return {
    x: leftPx / PX_PER_IN,
    y: topPx / PX_PER_IN,
    w: widthPx / PX_PER_IN,
    h: heightPx / PX_PER_IN,
  }
}

/** Build base text options (fontSize/fontFace/color/bold/align) from inline style. */
function baseTextOptions(style: Record<string, string>, tagName: string): RunOptions {
  const opts: RunOptions = {}
  const fontPx = parsePx(style['font-size']) ?? HEADING_DEFAULT_PX[tagName]
  if (fontPx !== undefined) opts.fontSize = fontPx * PT_PER_PX
  const fontFace = style['font-family']
  if (fontFace) {
    // Take first font in the stack, strip quotes (e.g. 'Arial, sans-serif' -> 'Arial')
    opts.fontFace = fontFace.split(',')[0]!.replace(/['"]/g, '').trim()
  }
  const color = normalizeColor(style.color)
  if (color) opts.color = color
  const fw = style['font-weight']
  if (fw === 'bold' || (fw && parseInt(fw, 10) >= 600)) opts.bold = true
  const align = style['text-align']
  if (align === 'left' || align === 'center' || align === 'right') opts.align = align
  return opts
}

/** Parse "left:80px;top:60px;font-size:32px" into { left:'80px', top:'60px', 'font-size':'32px' }. */
function parseInlineStyle(style: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!style) return out
  for (const decl of style.split(';')) {
    const idx = decl.indexOf(':')
    if (idx < 0) continue
    const key = decl.slice(0, idx).trim().toLowerCase()
    const val = decl.slice(idx + 1).trim()
    if (key) out[key] = val
  }
  return out
}

/** Parse "80px" -> 80, "80" -> 80. Returns undefined for empty/non-numeric. */
function parsePx(val: string | undefined): number | undefined {
  if (!val) return undefined
  const m = val.match(/^(-?[\d.]+)\s*(?:px)?$/)
  return m ? parseFloat(m[1]!) : undefined
}

/**
 * Normalize a CSS color to pptxgenjs hex format (no # prefix).
 * Accepts #RRGGBB, #RGB, rgb(r,g,b), rgba(r,g,b,a). Returns undefined for
 * transparent/none/empty (so callers can skip setting the color).
 */
function normalizeColor(val: string | undefined): string | undefined {
  if (!val) return undefined
  const v = val.trim().toLowerCase()
  if (v === 'transparent' || v === 'none' || v === 'rgba(0, 0, 0, 0)') return undefined
  // #RRGGBB or #RGB
  const hexMatch = v.match(/^#?([0-9a-f]{6}|[0-9a-f]{3})$/)
  if (hexMatch) {
    let hex = hexMatch[1]!
    if (hex.length === 3)
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('')
    return hex.toUpperCase()
  }
  // rgb(r, g, b) / rgba(r, g, b, a)
  const rgbMatch = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (rgbMatch) {
    return rgbMatch
      .slice(1, 4)
      .map((n) => parseInt(n!, 10).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  }
  return undefined
}
