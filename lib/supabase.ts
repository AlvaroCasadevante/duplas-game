import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export type Room = {
  id: string
  code: string
  player1_id: string
  player1_name: string
  player2_id: string | null
  player2_name: string | null
  status: 'waiting' | 'ready' | 'playing' | 'finished'
  created_at: string
}
