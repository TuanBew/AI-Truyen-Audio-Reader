'use client'

import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAppStore } from '@/lib/store'

/**
 * Subscribes to Supabase auth state changes and syncs them into Zustand.
 * Mount this ONCE at the root component (MainLayout).
 *
 * Design notes:
 * - Uses onAuthStateChange as the single source of truth for session state.
 *   getSession() is used only for initial hydration before the listener fires.
 * - migratedRef prevents double-migration when both getSession() and
 *   onAuthStateChange fire near-simultaneously on page load.
 * - Reads savedNovels/finishedChapterUrls via getState() INSIDE the handler
 *   to avoid stale closure (captures state at sign-in time, not mount time).
 */
export function useAuth() {
  const setAuthState = useAppStore((s) => s.setAuthState)
  const migratedRef = useRef(false)

  useEffect(() => {
    // 1. Hydrate from existing session (handles page refresh)
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session?.user && !migratedRef.current) {
        migratedRef.current = true
        setAuthState({
          supabaseUserId: session.user.id,
          supabaseEmail: session.user.email ?? null,
          syncStatus: 'syncing',
        })
        try {
          await migrateGuestStateToSupabase(session.user.id)
          setAuthState({ syncStatus: 'synced' })
        } catch {
          setAuthState({ syncStatus: 'offline' })
        }
      }
    })

    // 2. Listen for future auth changes (sign-in, sign-out, token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'SIGNED_IN' && session?.user && !migratedRef.current) {
          migratedRef.current = true
          setAuthState({
            supabaseUserId: session.user.id,
            supabaseEmail: session.user.email ?? null,
            syncStatus: 'syncing',
          })
          try {
            await migrateGuestStateToSupabase(session.user.id)
            setAuthState({ syncStatus: 'synced' })
          } catch {
            setAuthState({ syncStatus: 'offline' })
          }
        } else if (event === 'SIGNED_OUT') {
          migratedRef.current = false
          setAuthState({ supabaseUserId: null, supabaseEmail: null, syncStatus: 'idle' })
        }
      }
    )

    return () => subscription.unsubscribe()
  }, [setAuthState])
}


// ─── Guest → Supabase migration ──────────────────────────────

async function migrateGuestStateToSupabase(userId: string) {
  // Read current store state at migration time (not stale mount-time snapshot)
  const { savedNovels, finishedChapterUrls } = useAppStore.getState()

  // Migrate novels — ignoreDuplicates=true: remote title/cover wins on conflict
  for (const novel of savedNovels) {
    await supabase.from('novels').upsert(
      {
        user_id: userId,
        url: novel.url,
        title: novel.title,
        cover_url: novel.coverUrl ?? null,
        total_chapters: novel.totalChapters,
        toc: novel.toc,
        added_at: new Date(novel.addedAt).toISOString(),
        last_chapter_url: novel.lastChapterUrl ?? null,
        last_chapter_title: novel.lastChapterTitle ?? null,
      },
      { onConflict: 'user_id,url', ignoreDuplicates: true }
    )
  }

  // Migrate finished chapters with conflict resolution:
  // is_finished is OR-merged (once finished on either side, it stays finished)
  for (const chapterUrl of finishedChapterUrls) {
    const { data: remote } = await supabase
      .from('reading_progress')
      .select('sentence_index, is_finished')
      .eq('user_id', userId)
      .eq('chapter_url', chapterUrl)
      .single()

    // Skip if remote is already finished — it's authoritative
    if (remote?.is_finished) continue

    await supabase.from('reading_progress').upsert(
      {
        user_id: userId,
        chapter_url: chapterUrl,
        sentence_index: remote?.sentence_index ?? 0,
        word_index: -1,
        is_finished: true,
      },
      { onConflict: 'user_id,chapter_url' }
    )
  }
}
