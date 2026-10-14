// Reserved whole-paper anchor keeps a stroke continuous across paragraphs/tables.
export const PAPER_ANCHOR = 'synapse-paper-v1'
export function distanceToSegment(point,a,b) {
  const dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy
  const t=length?Math.max(0,Math.min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dy)/length)):0
  return Math.hypot(point[0]-a[0]-t*dx,point[1]-a[1]-t*dy)
}
export const validAnchor = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)
export const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)

export function cleanAnnotations(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 150).filter(stroke => stroke && validAnchor(stroke.id) && validAnchor(stroke.anchor) && validColor(stroke.color)
    && Number.isFinite(stroke.width) && stroke.width >= 1 && stroke.width <= 12 && Array.isArray(stroke.points) && stroke.points.length >= 2 && stroke.points.length <= 500
    && stroke.points.every(point => Array.isArray(point) && point.length === 2 && point.every(n => Number.isFinite(n) && n >= 0 && n <= 1)))
    .map(stroke => ({ id: stroke.id, anchor: stroke.anchor, color: stroke.color, width: stroke.width, points: stroke.points.map(point => [...point]) }))
}

export function annotatedHtml(html, annotations) {
  const root = document.createElement('div'); root.innerHTML = html
  const grouped = new Map()
  for (const stroke of cleanAnnotations(annotations)) {
    const items = grouped.get(stroke.anchor) || []; items.push(stroke); grouped.set(stroke.anchor, items)
  }
  root.dataset.annotationId=PAPER_ANCHOR
  for (const block of [root,...root.querySelectorAll('[data-annotation-id]')]) {
    const strokes = grouped.get(block.dataset.annotationId)
    if (!strokes?.length) continue
    block.style.position = 'relative'
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('class', 'saved-drawing'); svg.setAttribute('viewBox', '0 0 1000 1000'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true')
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:20'
    for (const stroke of strokes) {
      const line = document.createElementNS(ns, 'polyline')
      line.setAttribute('points', stroke.points.map(([x,y]) => `${x * 1000},${y * 1000}`).join(' '))
      line.setAttribute('fill', 'none'); line.setAttribute('stroke', stroke.color); line.setAttribute('stroke-width', String(stroke.width)); line.setAttribute('stroke-linecap', 'round'); line.setAttribute('stroke-linejoin', 'round'); line.setAttribute('vector-effect', 'non-scaling-stroke')
      svg.append(line)
    }
    block.append(svg)
  }
  if(grouped.has(PAPER_ANCHOR)){root.style.cssText='position:relative;isolation:isolate;overflow:hidden';return root.outerHTML}
  return root.innerHTML
}
