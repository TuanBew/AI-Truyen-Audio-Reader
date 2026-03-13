'use client'

export default function ResizableDivider({ onResize }: { onResize: (dx: number) => void }) {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const onMove = (ev: MouseEvent) => onResize(ev.movementX)
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div
      onMouseDown={handleMouseDown}
      className="w-1 flex-shrink-0 cursor-col-resize bg-gray-800 hover:bg-indigo-500 active:bg-indigo-400 transition-colors select-none"
      title="Kéo để thay đổi kích thước"
    />
  )
}
