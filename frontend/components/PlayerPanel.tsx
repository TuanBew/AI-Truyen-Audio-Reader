'use client'

import { useCallback, useState, useEffect } from 'react'
import { useAppStore } from '@/lib/store'
import { toast } from 'react-toastify'
import TTSPlayer from './TTSPlayer'
import RecordingControls from './RecordingControls'
import AmbientPlayer from './AmbientPlayer'
import ResizableHDivider from './ResizableHDivider'

const LOWER_MIN = 42   // just AmbientPlayer
const LOWER_MAX = 200

export default function PlayerPanel() {
  const {
    currentChapter,
    setCurrentChapterUrl,
    setCurrentChapter,
    setLoadingChapter,
    activeNovelId,
    updateNovelProgress,
  } = useAppStore()

  const [lowerHeight, setLowerHeight] = useState(() => {
    if (typeof window === 'undefined') return 96
    const parsed = parseInt(localStorage.getItem('lower-panel-height') ?? '', 10)
    return isNaN(parsed) ? 96 : parsed
  })

  useEffect(() => {
    localStorage.setItem('lower-panel-height', String(lowerHeight))
  }, [lowerHeight])

  const navigateTo = useCallback(
    async (url: string | null | undefined) => {
      if (!url) return
      setCurrentChapterUrl(url)
      setLoadingChapter(true)
      try {
        const res = await fetch(`/api/scrape/chapter?url=${encodeURIComponent(url)}`)
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          throw new Error(data.detail || `HTTP ${res.status}`)
        }
        const data = await res.json()
        setCurrentChapter(data)
        if (activeNovelId) {
          updateNovelProgress(activeNovelId, url, data.chapter_title ?? '')
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Lỗi không xác định'
        toast.error(`Không tải được chương: ${msg}`)
        setCurrentChapterUrl(null)
      } finally {
        setLoadingChapter(false)
      }
    },
    [setCurrentChapterUrl, setLoadingChapter, setCurrentChapter, activeNovelId, updateNovelProgress]
  )

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      style={{ background: '#0d0d24', borderTop: '1px solid rgba(124,58,237,0.25)' }}
    >
      {/* TTSPlayer — takes remaining space above inner divider */}
      <div style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto' }}>
        {currentChapter && (
          <TTSPlayer
            text={currentChapter.content}
            chapterTitle={currentChapter.chapter_title}
            chapterUrl={currentChapter.source_url}
            onEnded={() => {
              // Read from store directly to avoid stale closure
              const { autoAdvance } = useAppStore.getState()
              if (autoAdvance && currentChapter.next_url) {
                setTimeout(() => navigateTo(currentChapter.next_url!), 800)
              }
            }}
          />
        )}
      </div>

      {/* Inner resizable divider — drag to resize lower section */}
      <ResizableHDivider
        onResize={(dy) =>
          setLowerHeight((h) => Math.min(LOWER_MAX, Math.max(LOWER_MIN, h - dy)))
        }
      />

      {/* Lower section: RecordingControls + AmbientPlayer */}
      <div
        className="flex flex-col flex-shrink-0 overflow-hidden"
        style={{ height: lowerHeight }}
      >
        <div style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto' }}>
          {currentChapter && (
            <RecordingControls
              text={currentChapter.content}
              chapterTitle={currentChapter.chapter_title}
            />
          )}
        </div>
        <AmbientPlayer />
      </div>
    </div>
  )
}
