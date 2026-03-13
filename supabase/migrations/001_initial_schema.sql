-- ============================================================
-- AudioTruyen — Initial Schema (run in Supabase SQL Editor)
-- ============================================================

-- ─── novels ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS novels (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID REFERENCES auth.users NOT NULL,
  url                TEXT NOT NULL,
  title              TEXT NOT NULL,
  cover_url          TEXT,
  total_chapters     INTEGER DEFAULT 0,
  toc                JSONB NOT NULL DEFAULT '[]',
  added_at           TIMESTAMPTZ DEFAULT NOW(),
  last_chapter_url   TEXT,
  last_chapter_title TEXT,
  UNIQUE(user_id, url)
);

CREATE INDEX IF NOT EXISTS novels_user_id_idx ON novels(user_id);

-- ─── reading_progress ────────────────────────────────────────
-- chapter_url is globally unique per user on truyenplus.vn
-- novel_id omitted intentionally (chapter URLs are unique across novels)
CREATE TABLE IF NOT EXISTS reading_progress (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES auth.users NOT NULL,
  chapter_url     TEXT NOT NULL,
  sentence_index  INTEGER NOT NULL DEFAULT 0,
  word_index      INTEGER NOT NULL DEFAULT -1,
  is_finished     BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, chapter_url)
);

-- ─── auto-update trigger ─────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_reading_progress_updated_at
  BEFORE UPDATE ON reading_progress
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Row Level Security ───────────────────────────────────────
ALTER TABLE novels           ENABLE ROW LEVEL SECURITY;
ALTER TABLE reading_progress ENABLE ROW LEVEL SECURITY;

-- Deny unauthenticated (anon) role entirely
CREATE POLICY "novels_deny_anon" ON novels
  FOR ALL TO anon USING (false);
CREATE POLICY "progress_deny_anon" ON reading_progress
  FOR ALL TO anon USING (false);

-- Authenticated users: own rows only
CREATE POLICY "novels_own" ON novels
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "progress_own" ON reading_progress
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
