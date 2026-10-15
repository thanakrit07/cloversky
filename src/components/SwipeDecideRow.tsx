import { useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'

// Past this much travel the gesture is a swipe, not a tap or a vertical
// scroll (same as SwipeableRow).
const DIRECTION_LOCK = 8
// Released past this, the swipe decides; short of it, the row springs back.
const COMMIT = 72
const MAX = 120
// The page's own swipe-back (usePushTransition) owns a drag that starts this
// close to the left edge; a row never competes for it.
const EDGE_WIDTH = 24

interface Props {
  onAccept: () => void
  onSkip: () => void
  disabled?: boolean
  className?: string
  children: ReactNode
}

// Swipe right to accept, left to skip: a quicker route through a long list
// for a thumb, never the only one — the row keeps its own switch for taps,
// mouse and keyboard. Unlike SwipeableRow (swipe to reveal Delete) nothing
// stays open: the row springs back as soon as the decision is made.
export function SwipeDecideRow({ onAccept, onSkip, disabled, className, children }: Props) {
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; y: number } | null>(null)
  const axis = useRef<'undecided' | 'horizontal' | 'vertical'>('undecided')
  // A drag ends in a click on whatever was under the finger; that click is not a tap.
  const swallowClick = useRef(false)

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (disabled) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (e.clientX <= EDGE_WIDTH) return
    start.current = { x: e.clientX, y: e.clientY }
    axis.current = 'undecided'
    swallowClick.current = false
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!start.current) return
    const dx = e.clientX - start.current.x
    const dy = e.clientY - start.current.y
    if (axis.current === 'undecided') {
      if (Math.abs(dx) < DIRECTION_LOCK && Math.abs(dy) < DIRECTION_LOCK) return
      // Vertical intent wins ties so the list scrolls normally.
      axis.current = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
      if (axis.current === 'horizontal') {
        setDragging(true)
        swallowClick.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
      }
    }
    if (axis.current !== 'horizontal') return
    setOffset(Math.max(-MAX, Math.min(MAX, dx)))
  }

  function onPointerUp() {
    if (start.current && axis.current === 'horizontal') {
      if (offset >= COMMIT) onAccept()
      else if (offset <= -COMMIT) onSkip()
    }
    start.current = null
    axis.current = 'undecided'
    setDragging(false)
    setOffset(0)
  }

  function onClickCapture(e: MouseEvent) {
    if (!swallowClick.current) return
    swallowClick.current = false
    e.stopPropagation()
    e.preventDefault()
  }

  const armed = Math.abs(offset) >= COMMIT
  return (
    <div className={cn('relative overflow-hidden', className)}>
      {offset !== 0 && (
        <div
          aria-hidden
          className={cn(
            'absolute inset-0 flex items-center px-5 text-xs font-medium transition-colors',
            offset > 0 ? 'justify-start' : 'justify-end',
            offset > 0 ? (armed ? 'bg-primary text-primary-foreground' : 'bg-primary/15 text-primary') : armed ? 'bg-muted-foreground text-background' : 'bg-muted text-muted-foreground',
          )}
        >
          {offset > 0 ? (
            <span className="flex items-center gap-1">
              <Check className="size-4" /> Accept
            </span>
          ) : (
            <span className="flex items-center gap-1">
              Skip <X className="size-4" />
            </span>
          )}
        </div>
      )}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onClickCapture}
        className="relative touch-pan-y bg-background"
        style={{ transform: `translateX(${offset}px)`, transition: dragging ? undefined : 'transform 150ms ease-out' }}
      >
        {children}
      </div>
    </div>
  )
}
