'use client'

import { useCallback } from 'react'

interface Props {
  onResize: (dy: number) => void
}

export default function ResizableHDivider({ onResize }: Props) {
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const onMove = (ev: MouseEvent) => onResize(ev.movementY)
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [onResize])

  return (
    <div
      onMouseDown={handleMouseDown}
      className="h-1 flex-shrink-0 cursor-row-resize bg-violet-900/40 hover:bg-violet-500 active:bg-violet-400 transition-colors select-none"
      title="Kéo để thay đổi kích thước"
    />
  )
}
