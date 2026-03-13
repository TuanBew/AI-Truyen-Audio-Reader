'use client'

// Schema: reading_progress(user_id, chapter_url, sentence_index, word_index, is_finished, updated_at)
// One-time migration: ALTER TABLE reading_progress ADD COLUMN IF NOT EXISTS is_finished boolean DEFAULT false;

import { useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAppStore } from '@/lib/store'

/**
 * Returns a sync function that debounces reading progress upserts to Supabase.
 * Call on every sentence advance. Guest users (no userId): no-op.
 */
export function useSyncProgress() {
  const userId = useAppStore((s) => s.authState.supabaseUserId)
  const setAuthState = useAppStore((s) => s.setAuthState)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  return useCallback(
    (chapterUrl: string, sentenceIndex: number, wordIndex: number, isFinished: boolean) => {
      if (!userId) return  // guest mode — no-op

      if (debounceRef.current) clearTimeout(debounceRef.current)

      debounceRef.current = setTimeout(async () => {
        setAuthState({ syncStatus: 'syncing' })
        try {
          const { error } = await supabase.from('reading_progress').upsert(
            {
              user_id: userId,
              chapter_url: chapterUrl,
              sentence_index: sentenceIndex,
              word_index: wordIndex,
              is_finished: isFinished,
            },
            { onConflict: 'user_id,chapter_url' }
          )
          setAuthState({ syncStatus: error ? 'offline' : 'synced' })
        } catch {
          setAuthState({ syncStatus: 'offline' })
        }
      }, 1000)
    },
    [userId, setAuthState]
  )
}
