/**
 * html2pptx unit tests (TDD, mirrors technical-design-slides.md Task A Steps A2-A8).
 *
 * html2pptx converts a single-slide HTML (root <div> with absolutely-positioned
 * children) into a single-slide pptx bytes consumable by mergeSlideFromPptx.
 *
 * Design gap from reference (davila7/claude-code-templates html2pptx.js):
 *   The reference uses Playwright (browser) to get computed positions via
 *   getBoundingClientRect + getComputedStyle. This implementation uses cheerio
 *   (no browser), so it reads inline styles only and requires position:absolute
 *   with left/top/width/height in px. Flexbox is NOT supported (system prompt
 *   instructs deepseek to use position:absolute). See technical-design §5.6.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { html2pptx } from '../src/html2pptx'
import { openPptx, savePptx, mergeSlideFromPptx } from '../src/index'

// Unit conversion constants (match pptx-render coords.ts EMU_PER_INCH + reference PT_PER_PX)
const EMU_PER_INCH = 914400
const PX_PER_IN = 96

// 1x1 red-dot PNG (base64) for image tests
const RED_DOT_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('html2pptx', () => {
  describe('Step A2/A3: text element mapping', () => {
    it('maps <p> with absolute positioning to a text element containing the text', async () => {
      const html =
        '<div style="width:1280px;height:720px;background-color:#0B2545">' +
        '<p style="position:absolute;left:80px;top:60px;width:600px;height:80px;font-size:32px;color:#FFFFFF;font-family:Arial">Title</p>' +
        '</div>'
      const { bytes } = await html2pptx(html, { width: 1280, height: 720 })
      const opened = await openPptx(bytes)
      expect(opened.deck.slides.length).toBe(1)
      const texts = opened.deck.slides[0]!.elements.filter(
        (e) => e.type === 'text' || e.type === 'shape',
      ).map(
        (e) =>
          (
            e as {
              text?: { paragraphs: Array<{ runs: Array<{ text: string }> }> }
            }
          ).text?.paragraphs
            ?.flatMap((p) => p.runs.map((r) => r.text))
            .join('') ?? '',
      )
      expect(texts.join(' ')).toContain('Title')
    })

    it('maps <h1> through <h6> to text elements with default heading font sizes', async () => {
      const tags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const
      const parts = tags.map(
        (t, i) =>
          `<${t} style="position:absolute;left:${10 + i * 10}px;top:${10 + i * 40}px;width:200px;height:30px">${t}-text</${t}>`,
      )
      const html = `<div style="width:1280px;height:720px">${parts.join('')}</div>`
      const { bytes } = await html2pptx(html, { width: 1280, height: 720 })
      const opened = await openPptx(bytes)
      const joined = opened.deck.slides[0]!.elements.map(
        (e) =>
          (
            e as {
              text?: { paragraphs: Array<{ runs: Array<{ text: string }> }> }
            }
          ).text?.paragraphs
            ?.flatMap((p) => p.runs.map((r) => r.text))
            .join('') ?? '',
      ).join(' ')
      for (const t of tags) expect(joined).toContain(`${t}-text`)
    })
  })

  describe('Step A4/A5: CSS positioning + font-size conversion', () => {
    it('converts CSS px positioning to inches (96 DPI) for x/y/w/h', async () => {
      const html =
        '<div style="width:1280px;height:720px">' +
        '<p style="position:absolute;left:96px;top:72px;width:480px;height:60px;font-size:32px">Text</p></div>'
      const { bytes } = await html2pptx(html, { width: 1280, height: 720 })
      const opened = await openPptx(bytes)
      const el = opened.deck.slides[0]!.elements[0]!
      // 96px = 1 inch = 914400 EMU; 72px = 0.75 inch; 480px = 5 inch; 60px = 0.625 inch
      expect(el.transform.offset.x).toBeCloseTo(EMU_PER_INCH, 0)
      expect(el.transform.offset.y).toBeCloseTo(0.75 * EMU_PER_INCH, 0)
      expect(el.transform.offset.cx).toBeCloseTo(5 * EMU_PER_INCH, 0)
      expect(el.transform.offset.cy).toBeCloseTo(0.625 * EMU_PER_INCH, 0)
    })

    it('parses background-color from root div and applies to slide background', async () => {
      const html =
        '<div style="width:1280px;height:720px;background-color:#0B2545">' +
        '<p style="position:absolute;left:10px;top:10px;width:100px;height:20px;font-size:16px">x</p></div>'
      const { bytes } = await html2pptx(html, { width: 1280, height: 720 })
      const opened = await openPptx(bytes)
      // background encoded as a solid fill on the slide
      const bg = opened.deck.slides[0]!.background
      expect(bg).toBeDefined()
      // Engine model convention: colors carry the '#' prefix (see color.ts resolveColorNode)
      expect(bg).toEqual({ type: 'solid', color: '#0B2545' })
    })

    // P1-1 (optimization-checklist-slides-v1): font-size px -> pt conversion has no test lock
    it('converts font-size px to pt (32px -> 24pt) and heading defaults (h1 28px -> 21pt)', async () => {
      const html =
        '<div style="width:1280px;height:720px">' +
        '<p style="position:absolute;left:10px;top:10px;width:200px;height:40px;font-size:32px">Big</p>' +
        '<h1 style="position:absolute;left:10px;top:60px;width:200px;height:40px">Heading</h1></div>'
      const { bytes } = await html2pptx(html, { width: 1280, height: 720 })
      const opened = await openPptx(bytes)
      const runs = opened.deck.slides[0]!.elements.flatMap(
        (e) =>
          (
            e as {
              text?: { paragraphs: Array<{ runs: Array<{ text: string; fontSize?: number }> }> }
            }
          ).text?.paragraphs.flatMap((p) => p.runs) ?? [],
      )
      // 32px * 0.75 = 24pt (modification §7.3)
      const big = runs.find((r) => r.text === 'Big')
      expect(big?.fontSize).toBe(24)
      // h1 default is 28px -> 21pt (HEADING_DEFAULT_PX)
      const heading = runs.find((r) => r.text === 'Heading')
      expect(heading?.fontSize).toBe(21)
    })
  })

  // P1-2 (optimization-checklist-slides-v1): parseInlineRuns has zero unit coverage
  describe('inline run parsing (b/i/span)', () => {
    it('maps <b>/<i>/<span color> to runs with bold/italic/color', async () => {
      const html =
        '<div style="width:1280px;height:720px">' +
        '<p style="position:absolute;left:10px;top:10px;width:400px;height:60px;font-size:16px">' +
        'Hello <b>bold</b> <i>italic</i> <span style="color:#FF0000">red</span></p></div>'
      const { bytes } = await html2pptx(html, { width: 1280, height: 720 })
      const opened = await openPptx(bytes)
      const runs = opened.deck.slides[0]!.elements.flatMap(
        (e) =>
          (
            e as {
              text?: {
                paragraphs: Array<{
                  runs: Array<{ text: string; bold?: boolean; italic?: boolean; color?: string }>
                }>
              }
            }
          ).text?.paragraphs.flatMap((p) => p.runs) ?? [],
      )
      const bold = runs.find((r) => r.text === 'bold')
      expect(bold?.bold).toBe(true)
      const italic = runs.find((r) => r.text === 'italic')
      expect(italic?.italic).toBe(true)
      // span color normalized to engine model format (with '#', see color.ts resolveColorNode)
      const red = runs.find((r) => r.text === 'red')
      expect(red?.color).toBe('#FF0000')
      // plain text runs keep only base options; pptxgenjs defaults the fill to black
      const hello = runs.find((r) => r.text.includes('Hello'))
      expect(hello?.bold).toBeFalsy()
      expect(hello?.italic).toBeFalsy()
      expect(hello?.color).toBe('#000000')
    })

    it('maps <br> inside a paragraph to a line-break run', async () => {
      const html =
        '<div style="width:1280px;height:720px">' +
        '<p style="position:absolute;left:10px;top:10px;width:200px;height:60px">line1<br>line2</p></div>'
      const { bytes } = await html2pptx(html, { width: 1280, height: 720 })
      const opened = await openPptx(bytes)
      const texts = opened.deck.slides[0]!.elements.flatMap(
        (e) =>
          (
            e as {
              text?: { paragraphs: Array<{ runs: Array<{ text: string }> }> }
            }
          ).text?.paragraphs.flatMap((p) => p.runs.map((r) => r.text)) ?? [],
      )
      expect(texts.join('|')).toContain('line1')
      expect(texts.join('|')).toContain('line2')
    })
  })

  describe('Step A6/A7: image download + imageFailures', () => {
    let originalFetch: typeof globalThis.fetch

    beforeEach(() => {
      originalFetch = globalThis.fetch
    })
    afterEach(() => {
      globalThis.fetch = originalFetch
    })

    it('downloads <img> and embeds as base64; failed downloads recorded in imageFailures', async () => {
      const okBytes = Buffer.from(RED_DOT_B64, 'base64')
      globalThis.fetch = vi.fn(async (input: string | URL) => {
        const url = String(input)
        if (url.includes('/bad.png')) {
          throw new Error('HTTP 404')
        }
        return new Response(okBytes, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }) as unknown as typeof globalThis.fetch

      const html =
        '<div style="width:1280px;height:720px">' +
        '<img src="https://example.com/a.png" style="position:absolute;left:0px;top:0px;width:100px;height:100px">' +
        '<img src="https://example.com/bad.png" style="position:absolute;left:200px;top:0px;width:100px;height:100px"></div>'
      const { bytes, imageFailures } = await html2pptx(html, { width: 1280, height: 720 })
      expect(imageFailures.length).toBe(1)
      expect(imageFailures[0]!.url).toBe('https://example.com/bad.png')
      expect(imageFailures[0]!.reason).toContain('404')
      const opened = await openPptx(bytes)
      const pics = opened.deck.slides[0]!.elements.filter((e) => e.type === 'picture')
      expect(pics.length).toBe(1) // only a.png succeeded
    })

    it('continues generating the slide when all images fail (imageFailures records all)', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('network error')
      }) as unknown as typeof globalThis.fetch
      const html =
        '<div style="width:1280px;height:720px">' +
        '<img src="https://example.com/x.png" style="position:absolute;left:0px;top:0px;width:50px;height:50px">' +
        '<p style="position:absolute;left:100px;top:100px;width:300px;height:40px;font-size:20px">survives</p></div>'
      const { bytes, imageFailures } = await html2pptx(html, { width: 1280, height: 720 })
      expect(imageFailures.length).toBe(1)
      const opened = await openPptx(bytes)
      const texts = opened.deck.slides[0]!.elements.filter(
        (e) => e.type === 'text' || e.type === 'shape',
      )
        .map(
          (e) =>
            (
              e as {
                text?: { paragraphs: Array<{ runs: Array<{ text: string }> }> }
              }
            ).text?.paragraphs
              ?.flatMap((p) => p.runs.map((r) => r.text))
              .join('') ?? '',
        )
        .join(' ')
      expect(texts).toContain('survives')
    })
  })

  describe('Step A8: round-trip with mergeSlideFromPptx', () => {
    it('output is consumable by mergeSlideFromPptx (two html2pptx slides merge into one deck)', async () => {
      const htmlA =
        '<div style="width:1280px;height:720px;background-color:#0B2545">' +
        '<p style="position:absolute;left:80px;top:60px;width:600px;font-size:32px;color:#FFFFFF">Page A</p></div>'
      const { bytes: pageA } = await html2pptx(htmlA, { width: 1280, height: 720 })
      const base = await openPptx(pageA)
      expect(base.deck.slides.length).toBe(1)

      const htmlB = htmlA.replace('Page A', 'Page B')
      const { bytes: pageB } = await html2pptx(htmlB, { width: 1280, height: 720 })
      const merged = await mergeSlideFromPptx(base, pageB)
      expect(merged).not.toBeNull()
      expect(base.deck.slides.length).toBe(2)

      const reopened = await openPptx(await savePptx(base))
      expect(reopened.deck.slides.length).toBe(2)
      const texts = reopened.deck.slides.map((sl) =>
        sl.elements
          .filter((el) => el.type === 'text' || el.type === 'shape')
          .map(
            (el) =>
              (
                el as {
                  text?: { paragraphs: Array<{ runs: Array<{ text: string }> }> }
                }
              ).text?.paragraphs
                ?.flatMap((p) => p.runs.map((r) => r.text))
                .join('') ?? '',
          )
          .join(' '),
      )
      expect(texts[0]).toContain('Page A')
      expect(texts[1]).toContain('Page B')
    })
  })

  describe('shape mapping (div with background/border)', () => {
    it('maps <div> with background-color to a shape element', async () => {
      const html =
        '<div style="width:1280px;height:720px">' +
        '<div style="position:absolute;left:100px;top:100px;width:400px;height:200px;background-color:#FF6B6B"></div>' +
        '<p style="position:absolute;left:10px;top:10px;width:100px;height:20px;font-size:14px">label</p></div>'
      const { bytes } = await html2pptx(html, { width: 1280, height: 720 })
      const opened = await openPptx(bytes)
      const shapes = opened.deck.slides[0]!.elements.filter(
        (e) =>
          (e.type === 'text' || e.type === 'shape') &&
          (e as { fill?: { type?: string; color?: string } }).fill?.type === 'solid',
      )
      expect(shapes.length).toBeGreaterThanOrEqual(1)
      const red = shapes.find((s) => (s as { fill?: { color?: string } }).fill?.color === '#FF6B6B')
      expect(red).toBeDefined()
    })
  })

  describe('list mapping (ul/ol)', () => {
    it('maps <ul> with <li> items to a text element with bullet runs', async () => {
      const html =
        '<div style="width:1280px;height:720px">' +
        '<ul style="position:absolute;left:100px;top:100px;width:400px;height:200px;font-size:18px">' +
        '<li>first item</li><li>second item</li></ul></div>'
      const { bytes } = await html2pptx(html, { width: 1280, height: 720 })
      const opened = await openPptx(bytes)
      const joined = opened.deck.slides[0]!.elements.map(
        (e) =>
          (
            e as {
              text?: { paragraphs: Array<{ runs: Array<{ text: string }> }> }
            }
          ).text?.paragraphs
            ?.flatMap((p) => p.runs.map((r) => r.text))
            .join('|') ?? '',
      ).join(' ')
      expect(joined).toContain('first item')
      expect(joined).toContain('second item')
    })
  })

  describe('root div tolerance', () => {
    it('falls back to opts width/height when root div has no inline size', async () => {
      const html =
        '<div><p style="position:absolute;left:10px;top:10px;width:100px;height:20px;font-size:16px">x</p></div>'
      const { bytes } = await html2pptx(html, { width: 1280, height: 720 })
      const opened = await openPptx(bytes)
      // layout should be 13.333 x 7.5 inches (1280x720 @ 96 DPI)
      expect(opened.deck.size.cx).toBeCloseTo((1280 / PX_PER_IN) * EMU_PER_INCH, -3)
      expect(opened.deck.size.cy).toBeCloseTo((720 / PX_PER_IN) * EMU_PER_INCH, -3)
    })

    it('throws when no root <div> found', async () => {
      await expect(html2pptx('just text, no div', { width: 1280, height: 720 })).rejects.toThrow(
        /no root.*div/i,
      )
    })
  })
})
