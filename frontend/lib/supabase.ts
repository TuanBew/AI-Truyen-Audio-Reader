import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
    'Copy frontend/.env.local.example to frontend/.env.local and fill in your values.'
  )
}

// Singleton browser Supabase client.
// Uses the anon key — Row Level Security enforces per-user access.
// No server-side session management needed (client-side SPA only).
export const supabase = createClient(supabaseUrl, supabaseAnonKey)
