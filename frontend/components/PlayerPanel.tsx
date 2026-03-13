'use client'

import { useCallback } from 'react'
import { useAppStore } from '@/lib/store'
import { toast } from 'react-toastify'
import TTSPlayer from './TTSPlayer'
import RecordingControls from './RecordingControls'
import AmbientPlayer from './AmbientPlayer'

export default function PlayerPanel() {
  const {
    currentChapter,
    setCurrentChapterUrl,
    setCurrentChapter,
    setLoadingChapter,
    activeNovelId,
    updateNovelProgress,
    playerState,
  } = useAppStore()

  const { autoAdvance } = playerState

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
      {currentChapter && (
        <>
          <TTSPlayer
            text={currentChapter.content}
            chapterTitle={currentChapter.chapter_title}
            chapterUrl={currentChapter.source_url}
            onEnded={() => {
              if (autoAdvance && currentChapter.next_url) {
                setTimeout(() => navigateTo(currentChapter.next_url!), 800)
              }
            }}
          />
          <RecordingControls
            text={currentChapter.content}
            chapterTitle={currentChapter.chapter_title}
          />
        </>
      )}
      <AmbientPlayer />
    </div>
  )
}
