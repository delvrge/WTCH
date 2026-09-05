'use client'

import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { supabaseClient } from '@/lib/supabase'
import { errorMessage } from '@/lib/supabase'
import { ALL_TOPICS, countByTopicSubtopic } from '@/lib/topic-taxonomy'

// A force-directed overview of the fixed taxonomy, rooted at a single fixed
// product hub in the app's accent color, every topic hangs off it, and every
// subtopic hangs off its topic. Deliberately three levels only, patterns
// themselves don't appear here; that granularity belongs to Library's list
// + search. This is a vibes/overview picture, not a lookup tool. Zero new
// dependencies: plain canvas + a hand-rolled force simulation. Reads
// community_patterns.topic/subtopic directly (see lib/topic-taxonomy.ts) ,
// every topic/subtopic node always renders, even at zero count, since the
// taxonomy is fixed rather than data-driven.

interface PatternRow {
  topic: string | null
  subtopic: string | null
}

interface Node {
  id: string
  kind: 'root' | 'topic' | 'cluster'
  label: string
  detail: string | null
  radius: number
  color: string
  x: number
  y: number
  vx: number
  vy: number
  baseX: number
  baseY: number
  floatPhase: number
  floatSpeed: number
  floatAmp: number
}

const ROOT_COLOR = '#eb1100'
const ROOT_LABEL = process.env.NEXT_PUBLIC_PRODUCT_NAME ?? 'Product'
const ROOT_RADIUS = 14

interface Edge {
  from: number
  to: number
}

const MAX_TICKS = 320
// Fallback CSS-pixel height, used only before the container has been
// measured (e.g. the very first layout pass). Once mounted, both width and
// height track the canvas's actual rendered box via ResizeObserver, see
// the resize-handling effect below.
const FALLBACK_HEIGHT = 620

// Force-directed layouts only truly settle if the forces themselves decay
// over time (same trick d3-force uses as "alpha"). Without it, repulsion +
// spring + gravity keep re-injecting exactly as much energy as velocity
// damping removes, so the system finds a permanent low-amplitude limit
// cycle instead of a resting layout, verified empirically: with constant-
// magnitude forces, kinetic energy plateaus around ~2800 (vs. the ~3.5
// threshold below) even after 2000 ticks, and denser graphs end up with
// hundreds of overlapping node pairs because the layout never finishes
// spreading out. Scaling every force by a geometrically-decaying alpha
// (1 -> ALPHA_MIN over MAX_TICKS) fixes this: as alpha shrinks, forces
// shrink, velocity damping wins, and the layout actually comes to rest.
const ALPHA_MIN = 0.001
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / MAX_TICKS)

// Minimum distance any node keeps from a canvas edge. Sized for the 12px
// label font's ascent/descent so text never clips, even for a small node.
const LABEL_PAD = 12

// While a node is being dragged the rest of the graph is relaxed one step
// per frame so it trails behind rather than snapping. DRAG_ALPHA is the
// fixed "temperature" that pass runs at, high enough that neighbours visibly
// flow, low enough that the layout doesn't explode. DRAG_DAMPING below 1
// bleeds off velocity so motion settles instead of oscillating forever.
const DRAG_ALPHA = 0.35
const DRAG_DAMPING = 0.82

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// Golden-angle hue rotation: gives N visually distinct colors for any N,
// unlike a fixed palette that starts repeating once topic count exceeds
// its length.
function colorForIndex(i: number): string {
  const hue = (i * 137.508) % 360
  return `hsl(${hue}, 62%, 58%)`
}

// Keeps the canvas backing store (device pixels) matched to its logical
// CSS size at the current devicePixelRatio. Called on initial layout, on
// container resize, and on DPR change (e.g. dragging the window to a
// different-density monitor), see the resize-handling effect below. Kept
// as a standalone function (not touching canvas.style.width/height) so it
// never fights the CSS layout that makes the canvas responsive.
function syncCanvasResolution(canvas: HTMLCanvasElement, logicalWidth: number, logicalHeight: number) {
  const dpr = window.devicePixelRatio || 1
  const targetWidth = Math.round(logicalWidth * dpr)
  const targetHeight = Math.round(logicalHeight * dpr)
  if (canvas.width !== targetWidth) canvas.width = targetWidth
  if (canvas.height !== targetHeight) canvas.height = targetHeight
}

// Clamps a node's distance from center to a circle instead of clamping x/y
// independently to a rectangle, this is what makes the whole layout read
// as a sphere/medallion (nodes that hit the boundary sit right on a clean
// circular rim) rather than spreading out to fill the canvas's corners.
function clampToCircle(n: Node, cx: number, cy: number, boundaryRadius: number) {
  const dx = n.x - cx
  const dy = n.y - cy
  const dist = Math.sqrt(dx * dx + dy * dy)
  const maxDist = Math.max(0, boundaryRadius - Math.max(n.radius, LABEL_PAD))
  if (dist > maxDist && dist > 0) {
    const scale = maxDist / dist
    n.x = cx + dx * scale
    n.y = cy + dy * scale
    n.vx = 0
    n.vy = 0
  }
}

function runSimulation(nodes: Node[], edges: Edge[], width: number, height: number) {
  const cx = width / 2
  const cy = height / 2
  // Margin leaves room for a topic label drifting past its node near the
  // rim without clipping the canvas edge.
  const boundaryRadius = Math.min(width, height) / 2 - 28
  let alpha = 1

  for (let tick = 0; tick < MAX_TICKS; tick++) {
    let kinetic = 0

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]
        const b = nodes[j]
        let dx = b.x - a.x
        let dy = b.y - a.y
        let distSq = dx * dx + dy * dy
        if (distSq < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; distSq = 1 }
        if (distSq > 140000) continue
        const dist = Math.sqrt(distSq)
        const force = (3000 / distSq) * alpha
        const fx = (dx / dist) * force
        const fy = (dy / dist) * force
        a.vx -= fx; a.vy -= fy
        b.vx += fx; b.vy += fy
      }
    }

    for (const e of edges) {
      const a = nodes[e.from]
      const b = nodes[e.to]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const restDist = b.radius + 30
      const force = (dist - restDist) * 0.02 * alpha
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      a.vx += fx; a.vy += fy
      b.vx -= fx; b.vy -= fy
    }

    for (const n of nodes) {
      n.vx += (cx - n.x) * 0.001 * alpha
      n.vy += (cy - n.y) * 0.001 * alpha
    }

    for (const n of nodes) {
      // The root hub is pinned dead-center, it's the one fixed point
      // everything else hangs off, not another body the sim is free to
      // shove around.
      if (n.kind === 'root') { n.vx = 0; n.vy = 0; n.x = cx; n.y = cy; continue }
      n.vx *= 0.86
      n.vy *= 0.86
      n.x += n.vx
      n.y += n.vy
      clampToCircle(n, cx, cy, boundaryRadius)
      kinetic += n.vx * n.vx + n.vy * n.vy
    }

    alpha += (ALPHA_MIN - alpha) * ALPHA_DECAY

    if (kinetic < 0.05 * nodes.length || alpha <= ALPHA_MIN) break
  }
}

// One relaxation step, run per animation frame while a node is being
// dragged. This is what makes the graph "follow" the dragged dot: every edge
// pulls its two ends toward a rest length, neighbours get dragged along the
// chain, and damping turns what would be rigid snapping into a trailing,
// fluid motion. The dragged node itself is pinned to the cursor and never
// integrated here, it is the thing everything else is reacting to.
function relaxStep(
  nodes: Node[],
  edges: Edge[],
  width: number,
  height: number,
  draggingId: string | null,
) {
  const cx = width / 2
  const cy = height / 2
  const boundaryRadius = Math.min(width, height) / 2 - 28
  for (const e of edges) {
    const a = nodes[e.from]
    const b = nodes[e.to]
    if (!a || !b) continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    const restDist = b.radius + 30
    const force = (dist - restDist) * 0.08 * DRAG_ALPHA
    const fx = (dx / dist) * force
    const fy = (dy / dist) * force
    if (a.id !== draggingId && a.kind !== 'root') { a.vx += fx; a.vy += fy }
    if (b.id !== draggingId && b.kind !== 'root') { b.vx -= fx; b.vy -= fy }
  }

  // Light mutual repulsion so trailing nodes fan out instead of collapsing
  // into a single point behind the one being pulled.
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let distSq = dx * dx + dy * dy
      if (distSq < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; distSq = 1 }
      if (distSq > 40000) continue
      const dist = Math.sqrt(distSq)
      const force = (5500 / distSq) * DRAG_ALPHA
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      if (a.id !== draggingId && a.kind !== 'root') { a.vx -= fx; a.vy -= fy }
      if (b.id !== draggingId && b.kind !== 'root') { b.vx += fx; b.vy += fy }
    }
  }

  for (const n of nodes) {
    // Root hub never moves, dragged or not.
    if (n.kind === 'root') { n.vx = 0; n.vy = 0; continue }
    if (n.id === draggingId) continue
    n.vx *= DRAG_DAMPING
    n.vy *= DRAG_DAMPING
    n.x += n.vx
    n.y += n.vy
    clampToCircle(n, cx, cy, boundaryRadius)
    // The float animation reads from baseX/baseY, so they have to track the
    // relaxed position or the node would snap back on the next frame.
    n.baseX = n.x
    n.baseY = n.y
  }
}

export default function ClusterGraph() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<{ label: string; detail: string | null } | null>(null)
  const nodesRef = useRef<Node[]>([])
  const edgesRef = useRef<Edge[]>([])
  const draggingIdRef = useRef<string | null>(null)
  // Mirrors draggingIdRef purely so the cursor can re-render; the ref itself
  // is what the animation loop reads, since that must not trigger renders.
  const [dragging, setDragging] = useState(false)
  // Logical (CSS-pixel) canvas size, node x/y and all drawing stay in this
  // space; the backing store is scaled up separately for crisp rendering on
  // high-DPI screens (see the ctx.setTransform calls in the render effect).
  const sizeRef = useRef({ width: 800, height: FALLBACK_HEIGHT })

  useEffect(() => {
    let cancelled = false

    async function load() {
      setError('')
      try {
        const { data, error: patternError } = await supabaseClient()
          .from('community_patterns')
          .select('topic, subtopic')
        if (patternError) throw new Error(patternError.message)
        if (cancelled) return

        const patterns = (data || []) as PatternRow[]

        const canvas = canvasRef.current
        const width = canvas?.clientWidth || 800
        const height = canvas?.clientHeight || FALLBACK_HEIGHT

        const counts = countByTopicSubtopic(patterns)

        const nodes: Node[] = []
        const topicIndex = new Map<string, number>()

        // Seed positions on a wheel, topics evenly spaced around a ring
        // centered on the fixed root hub, each topic's subtopics fanned
        // in a small arc just outside it, instead of dropping every node
        // at a random point. The force simulation below still runs (so
        // nothing actually overlaps), but starting from an already-
        // organized layout makes it settle into a clean radial shape
        // rather than a random-looking cloud.
        const cx = width / 2
        const cy = height / 2
        const topicRingRadius = Math.min(width, height) * 0.22
        const topicCount = ALL_TOPICS.length

        const rootIndex = nodes.length
        nodes.push({
          id: 'root:product',
          kind: 'root',
          label: ROOT_LABEL,
          detail: `${topicCount} topics`,
          radius: ROOT_RADIUS,
          color: ROOT_COLOR,
          x: cx,
          y: cy,
          vx: 0,
          vy: 0,
          baseX: cx,
          baseY: cy,
          floatPhase: 0,
          floatSpeed: 0,
          floatAmp: 0,
        })

        ALL_TOPICS.forEach(({ topic, subtopics }, i) => {
          const bySubtopic = counts.get(topic)
          const total = subtopics.reduce((sum, s) => sum + (bySubtopic?.get(s) || 0), 0)
          const angle = (i / topicCount) * Math.PI * 2 - Math.PI / 2
          topicIndex.set(topic, nodes.length)
          nodes.push({
            id: `topic:${topic}`,
            kind: 'topic',
            label: topic,
            detail: `${subtopics.length} ${subtopics.length === 1 ? 'subtopic' : 'subtopics'}, ${total} ${total === 1 ? 'case' : 'cases'}`,
            radius: 10 + Math.sqrt(total) * 2.5,
            color: colorForIndex(i),
            x: cx + Math.cos(angle) * topicRingRadius,
            y: cy + Math.sin(angle) * topicRingRadius,
            vx: 0,
            vy: 0,
            baseX: 0,
            baseY: 0,
            floatPhase: Math.random() * Math.PI * 2,
            floatSpeed: 0.00025 + Math.random() * 0.0003,
            floatAmp: 3 + Math.random() * 3,
          })
        })

        const edges: Edge[] = []
        ALL_TOPICS.forEach(({ topic }) => {
          edges.push({ from: rootIndex, to: topicIndex.get(topic)! })
        })
        ALL_TOPICS.forEach(({ topic, subtopics }) => {
          const tIdx = topicIndex.get(topic)!
          const topicNode = nodes[tIdx]
          const bySubtopic = counts.get(topic)
          const subRingRadius = topicNode.radius + 34
          subtopics.forEach((subtopic, j) => {
            const count = bySubtopic?.get(subtopic) || 0
            const idx = nodes.length
            const subAngle = (j / Math.max(subtopics.length, 1)) * Math.PI * 2
            nodes.push({
              id: `${topic}::${subtopic}`,
              kind: 'cluster',
              label: subtopic,
              detail: `${count} ${count === 1 ? 'case' : 'cases'}`,
              radius: 3 + Math.sqrt(count || 1),
              color: topicNode.color,
              x: topicNode.x + Math.cos(subAngle) * subRingRadius,
              y: topicNode.y + Math.sin(subAngle) * subRingRadius,
              vx: 0,
              vy: 0,
              baseX: 0,
              baseY: 0,
              floatPhase: Math.random() * Math.PI * 2,
              floatSpeed: 0.0003 + Math.random() * 0.0004,
              floatAmp: 1.5 + Math.random() * 2,
            })
            edges.push({ from: idx, to: tIdx })
          })
        })

        runSimulation(nodes, edges, width, height)
        for (const n of nodes) { n.baseX = n.x; n.baseY = n.y }
        nodesRef.current = nodes
        edgesRef.current = edges
        sizeRef.current = { width, height }

        // Backing-store resolution only, canvas.style.width/height is left
        // alone so the CSS layout (width: 100%, see the JSX below) keeps
        // driving the on-screen size; pinning it to a px value here would
        // freeze the canvas at whatever the container measured at mount and
        // silently stop tracking any later container resize.
        const canvasEl = canvasRef.current
        if (canvasEl) syncCanvasResolution(canvasEl, width, height)
      } catch (err) {
        if (!cancelled) setError(errorMessage(err, 'Could not load the graph.'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [])

  // Keeps the canvas matched to its container and to the display's current
  // DPR for the component's whole lifetime, the initial sizing in load()
  // above only runs once, so without this the canvas would go stale (wrong
  // resolution, or wrong logical width vs. its actual on-screen box) after
  // any container resize or after dragging the window to a monitor with a
  // different devicePixelRatio.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // The canvas is CSS-sized (width: 100%, height: 100% of its flex
    // parent, see globals.css), so both dimensions can change, not just
    // width: the height now tracks whatever the Context page's left column
    // measures out to, rather than a fixed constant. Existing node
    // positions are rescaled proportionally on either axis rather than
    // re-running the sim, so a resize stretches the layout instead of
    // reshuffling it.
    function handleSizeChange(newWidth: number, newHeight: number) {
      const c = canvasRef.current
      if (!c || newWidth <= 0 || newHeight <= 0) return
      const prevWidth = sizeRef.current.width
      const prevHeight = sizeRef.current.height
      const widthChanged = Math.abs(newWidth - prevWidth) >= 0.5
      const heightChanged = Math.abs(newHeight - prevHeight) >= 0.5
      if ((widthChanged || heightChanged) && nodesRef.current.length > 0) {
        const scaleX = prevWidth > 0 ? newWidth / prevWidth : 1
        const scaleY = prevHeight > 0 ? newHeight / prevHeight : 1
        for (const n of nodesRef.current) {
          n.x = Math.max(n.radius, Math.min(newWidth - n.radius, n.x * scaleX))
          n.y = Math.max(n.radius, Math.min(newHeight - n.radius, n.y * scaleY))
          n.baseX = Math.max(n.radius, Math.min(newWidth - n.radius, n.baseX * scaleX))
          n.baseY = Math.max(n.radius, Math.min(newHeight - n.radius, n.baseY * scaleY))
        }
      }
      sizeRef.current = { width: newWidth, height: newHeight }
      syncCanvasResolution(c, newWidth, newHeight)
    }

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) handleSizeChange(entry.contentRect.width, entry.contentRect.height)
    })
    ro.observe(canvas)

    // devicePixelRatio has no native change event; the standard workaround
    // is a self-resubscribing matchMedia query tuned to the current ratio ,
    // it fires once when the ratio moves away from that value (zoom, or the
    // window crossing onto a different-density monitor), at which point we
    // resync the backing store and re-arm for the new ratio.
    let dprQuery: MediaQueryList | null = null
    function onDprChange() {
      dprQuery?.removeEventListener('change', onDprChange)
      const c = canvasRef.current
      if (c) syncCanvasResolution(c, sizeRef.current.width, sizeRef.current.height)
      watchDpr()
    }
    function watchDpr() {
      const dpr = window.devicePixelRatio || 1
      dprQuery = window.matchMedia(`(resolution: ${dpr}dppx)`)
      dprQuery.addEventListener('change', onDprChange)
    }
    watchDpr()

    return () => {
      ro.disconnect()
      dprQuery?.removeEventListener('change', onDprChange)
    }
  }, [])

  // Continuous slow float, not a one-shot render: once the sim has settled
  // (load() sets baseX/baseY), each frame nudges every node a few px around
  // its resting spot on its own sine wave, then redraws. Runs indefinitely
  // while mounted, cancelled on unmount/reload so it never leaks.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || loading || error) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0

    function render(t: number) {
      const c = canvasRef.current
      if (!c || !ctx) return
      const nodes = nodesRef.current
      // While dragging, relax the rest of the graph one step per frame so it
      // trails the dragged node. Skipped under prefers-reduced-motion, where
      // dragging still works but nothing flows after it.
      if (draggingIdRef.current && !prefersReducedMotion()) {
        const { width: logicalW, height: logicalH } = sizeRef.current
        relaxStep(nodes, edgesRef.current, logicalW, logicalH, draggingIdRef.current)
      }
      for (const n of nodes) {
        // The root hub is fixed dead-center, it never floats.
        if (n.kind === 'root') continue
        // A node being dragged has its x/y driven directly by the pointer
        // (see handleMouseMove), the float must not fight the cursor.
        if (n.id === draggingIdRef.current) continue
        // A node the relax pass just moved must not also be float-animated
        // back toward a stale base, or it visibly fights the drag.
        if (draggingIdRef.current) continue
        n.x = n.baseX + Math.sin(t * n.floatSpeed + n.floatPhase) * n.floatAmp
        n.y = n.baseY + Math.cos(t * n.floatSpeed * 0.8 + n.floatPhase) * n.floatAmp
      }

      const dpr = window.devicePixelRatio || 1
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, c.width, c.height)
      // Everything below is drawn in CSS-pixel space (matching node x/y);
      // this scale maps it onto the higher-resolution backing store set in
      // load() above, so the graph renders crisp instead of blurry on
      // high-DPI screens.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // canvas fillStyle can't parse a CSS custom property directly, read
      // the computed value out at draw time so labels still match theme.
      const fgColor = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '#ededed'

      ctx.strokeStyle = 'rgba(140,140,140,0.18)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const e of edgesRef.current) {
        const a = nodes[e.from]
        const b = nodes[e.to]
        if (!a || !b) continue
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
      }
      ctx.stroke()

      // Root hub: solid accent color, with a soft glow so it reads as the light
      // source everything else radiates from, drawn first so topic blobs
      // and edges layer on top of it, then its label drawn last of all
      // (after every other label) so it's never occluded.
      const root = nodes.find((n) => n.kind === 'root')
      if (root) {
        ctx.save()
        ctx.shadowColor = ROOT_COLOR
        ctx.shadowBlur = 12
        ctx.beginPath()
        ctx.arc(root.x, root.y, root.radius, 0, Math.PI * 2)
        ctx.fillStyle = ROOT_COLOR
        ctx.fill()
        ctx.restore()
      }

      // topic blobs (background), then cluster dots, then topic labels on top ,
      // clusters never get a label drawn, by design.
      for (const n of nodes) {
        if (n.kind !== 'topic') continue
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2)
        ctx.fillStyle = n.color
        ctx.globalAlpha = 0.28
        ctx.fill()
        ctx.globalAlpha = 1
      }
      for (const n of nodes) {
        if (n.kind !== 'cluster') continue
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2)
        ctx.fillStyle = n.color
        ctx.fill()
      }
      for (const n of nodes) {
        if (n.kind !== 'topic') continue
        ctx.beginPath()
        ctx.arc(n.x, n.y, 3.5, 0, Math.PI * 2)
        ctx.fillStyle = n.color
        ctx.fill()
        // Match the app's own font stack (app/globals.css) rather than a
        // generic one, and set alignment/baseline explicitly instead of
        // relying on canvas defaults. Draw position is rounded to the
        // nearest CSS pixel, at fractional coordinates (nodes float on a
        // sine wave every frame) glyph edges land between device pixels and
        // get anti-aliased into a soft, muddy smear instead of a crisp line.
        ctx.font = '12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
        ctx.textBaseline = 'alphabetic'
        ctx.fillStyle = fgColor
        // Labels draw to the right of their node, so a node sitting near the
        // right edge pushes its label off-canvas, clamping the node itself
        // can't prevent that, since the overflow is text the node doesn't
        // know the width of. Measure it, and flip the label to the node's
        // left when it wouldn't fit on the right.
        const labelWidth = ctx.measureText(n.label).width
        const labelX = Math.round(n.x + n.radius + 4)
        if (labelX + labelWidth > sizeRef.current.width - 4) {
          ctx.textAlign = 'right'
          ctx.fillText(n.label, Math.round(n.x - n.radius - 4), Math.round(n.y + 4))
        } else {
          ctx.textAlign = 'left'
          ctx.fillText(n.label, labelX, Math.round(n.y + 4))
        }
      }

      // The root's own label: centered under the hub rather than beside it ,
      // it's the fixed anchor, not one more node competing for label space.
      if (root) {
        ctx.font = 'bold 13px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'alphabetic'
        ctx.fillStyle = fgColor
        ctx.fillText(root.label, Math.round(root.x), Math.round(root.y + root.radius + 18))
      }

      raf = requestAnimationFrame(render)
    }

    raf = requestAnimationFrame(render)
    return () => cancelAnimationFrame(raf)
  }, [loading, error])

  function nodeAt(canvas: HTMLCanvasElement, e: MouseEvent<HTMLCanvasElement>): Node | null {
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    for (const n of nodesRef.current) {
      const dx = n.x - x
      const dy = n.y - y
      if (dx * dx + dy * dy <= (n.radius + 4) * (n.radius + 4)) return n
    }
    return null
  }

  function handleMouseDown(e: MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return
    const hit = nodeAt(canvas, e)
    setSelected(hit ? { label: hit.label, detail: hit.detail } : null)
    draggingIdRef.current = hit ? hit.id : null
    setDragging(Boolean(hit))
  }

  // Dragging never lets a node leave the canvas, clamped to its own radius
  // on every side, same rule the settle simulation itself uses, so a
  // dropped node stays visible rather than getting dragged off-screen.
  function handleMouseMove(e: MouseEvent<HTMLCanvasElement>) {
    const draggingId = draggingIdRef.current
    if (!draggingId) return
    const canvas = canvasRef.current
    if (!canvas) return
    const node = nodesRef.current.find((n) => n.id === draggingId)
    if (!node) return
    const rect = canvas.getBoundingClientRect()
    const { width, height } = sizeRef.current
    node.x = e.clientX - rect.left
    node.y = e.clientY - rect.top
    // Same circular rim the settle/relax passes enforce, dragging a node
    // can push it toward the edge but never past the sphere's boundary.
    const cx = width / 2
    const cy = height / 2
    const boundaryRadius = Math.min(width, height) / 2 - 28
    clampToCircle(node, cx, cy, boundaryRadius)
    node.baseX = node.x
    node.baseY = node.y
  }

  function stopDragging() {
    draggingIdRef.current = null
    setDragging(false)
  }

  return (
    <div className="stack">
      {error ? <p className="error">{error}</p> : null}
      {loading ? <p className="meta"><span className="spinner" /> Loading graph…</p> : null}
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDragging}
        onMouseLeave={stopDragging}
        style={{ width: '100%', height: '100%', minHeight: FALLBACK_HEIGHT, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', cursor: dragging ? 'grabbing' : 'grab' }}
      />
      {selected ? (
        <div className="doc">
          <p className="row-title">{selected.label}</p>
          {selected.detail ? <p className="body-text">{selected.detail}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
