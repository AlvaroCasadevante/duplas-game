'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'

type Phase = 'home' | 'waiting' | 'ready'

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function generateCode(): string {
  return Array.from(
    { length: 4 },
    () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  ).join('')
}

function getPlayerId(): string {
  let id = localStorage.getItem('duplas_player_id')
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem('duplas_player_id', id)
  }
  return id
}

export default function Home() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('home')
  const [name, setName] = useState('')
  const [joinCode, setJoinCode] = useState('')
  const [roomCode, setRoomCode] = useState('')
  const [roomId, setRoomId] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const channelRef = useRef<RealtimeChannel | null>(null)
  const navigatedRef = useRef(false)

  useEffect(() => {
    return () => { channelRef.current?.unsubscribe() }
  }, [])

  function subscribeToRoom(id: string) {
    channelRef.current = supabase
      .channel(`room-${id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${id}` },
        (payload) => {
          const updated = payload.new as { status: string }
          if (updated.status === 'ready') setPhase('ready')
          if (updated.status === 'playing' && !navigatedRef.current) {
            navigatedRef.current = true
            router.push(`/game/${id}`)
          }
        }
      )
      .subscribe()
  }

  async function handleCreate() {
    if (!name.trim()) { setError('Escribe tu nombre primero'); return }
    setLoading(true)
    setError('')

    const playerId = getPlayerId()
    const code = generateCode()

    const { data, error: err } = await supabase
      .from('rooms')
      .insert({
        code,
        player1_id: playerId,
        player1_name: name.trim(),
        status: 'waiting',
      })
      .select('id')
      .single()

    setLoading(false)

    if (err || !data) {
      setError('Error al crear la sala, intenta de nuevo')
      return
    }

    sessionStorage.setItem(`duplas_role_${data.id}`, 'p1')
    setRoomCode(code)
    setRoomId(data.id)
    setPhase('waiting')
    subscribeToRoom(data.id)
  }

  async function handleJoin() {
    if (!name.trim()) { setError('Escribe tu nombre primero'); return }
    if (joinCode.trim().length < 4) { setError('El código debe tener 4 caracteres'); return }
    setLoading(true)
    setError('')

    const playerId = getPlayerId()

    const { data: room, error: findErr } = await supabase
      .from('rooms')
      .select('id')
      .eq('code', joinCode.trim().toUpperCase())
      .eq('status', 'waiting')
      .single()

    if (findErr || !room) {
      setError('Código inválido o sala no disponible')
      setLoading(false)
      return
    }

    const { error: updateErr } = await supabase
      .from('rooms')
      .update({
        player2_id: playerId,
        player2_name: name.trim(),
        status: 'ready',
      })
      .eq('id', room.id)

    setLoading(false)

    if (updateErr) {
      setError('Error al unirse, intenta de nuevo')
      return
    }

    sessionStorage.setItem(`duplas_role_${room.id}`, 'p2')
    setRoomId(room.id)
    setPhase('ready')
    subscribeToRoom(room.id)   // P2 también escucha el evento 'playing'
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(roomCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleStart() {
    setLoading(true)
    navigatedRef.current = true   // evita doble navegación si el evento Realtime rebota
    await supabase.from('rooms').update({ status: 'playing' }).eq('id', roomId)
    router.push(`/game/${roomId}`)
  }

  // --- Waiting screen (creator) ---
  if (phase === 'waiting') {
    return (
      <main className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="text-center space-y-8 w-full max-w-sm">
          <h1 className="text-3xl font-bold text-white tracking-widest">DUPLAS PONG</h1>

          <div className="space-y-2">
            <p className="text-slate-400 text-sm uppercase tracking-wider">Código de sala</p>
            <div className="bg-slate-900 border-2 border-cyan-500 rounded-2xl px-8 py-5 inline-block">
              <span className="text-5xl font-mono font-bold text-cyan-400 tracking-[0.5em]">
                {roomCode}
              </span>
            </div>
          </div>

          <button
            onClick={handleCopy}
            className="text-sm text-slate-500 hover:text-white transition-colors underline underline-offset-4"
          >
            {copied ? 'Copiado!' : 'Copiar código'}
          </button>

          <p className="text-slate-300 font-medium">
            Comparte este código con tu amigo
          </p>

          <div className="flex items-center justify-center gap-3 text-slate-500 text-sm">
            <span className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse inline-block" />
            Esperando al segundo jugador...
          </div>
        </div>
      </main>
    )
  }

  // --- Ready screen ---
  if (phase === 'ready') {
    return (
      <main className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="text-center space-y-8 w-full max-w-sm">
          <h1 className="text-3xl font-bold text-white tracking-widest">DUPLAS PONG</h1>

          <div className="space-y-3">
            <div className="w-16 h-16 rounded-full bg-green-500/20 border-2 border-green-500 flex items-center justify-center mx-auto">
              <span className="text-green-400 text-2xl font-bold">2/2</span>
            </div>
            <h2 className="text-2xl font-bold text-green-400">¡Ambos listos!</h2>
            <p className="text-slate-400 text-sm">Los dos jugadores están en la sala</p>
          </div>

          <button
            onClick={handleStart}
            className="w-full py-4 bg-green-500 hover:bg-green-400 active:bg-green-600 text-black font-bold text-lg rounded-xl transition-colors"
          >
            Empezar partida
          </button>
        </div>
      </main>
    )
  }

  // --- Home screen ---
  return (
    <main className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-4xl font-bold text-white tracking-widest">DUPLAS PONG</h1>
          <p className="text-slate-500 text-sm">Cooperativo · 2 jugadores</p>
        </div>

        {error && (
          <p className="text-red-400 text-sm text-center bg-red-950/50 border border-red-900 rounded-lg px-4 py-2">
            {error}
          </p>
        )}

        <div className="space-y-1.5">
          <label className="text-slate-400 text-sm font-medium block">Tu nombre</label>
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setError('') }}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="Ej: María"
            maxLength={20}
            autoFocus
            className="w-full bg-slate-900 border border-slate-700 text-white rounded-xl px-4 py-3 focus:outline-none focus:border-cyan-500 transition-colors placeholder:text-slate-600"
          />
        </div>

        <button
          onClick={handleCreate}
          disabled={loading}
          className="w-full py-3.5 bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-700 disabled:opacity-40 text-white font-bold rounded-xl transition-colors"
        >
          {loading ? 'Creando sala...' : 'Crear nueva sala'}
        </button>

        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-slate-800" />
          <span className="text-slate-600 text-xs uppercase tracking-wider">o únete</span>
          <div className="flex-1 h-px bg-slate-800" />
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-slate-400 text-sm font-medium block">Código de sala</label>
            <input
              type="text"
              value={joinCode}
              onChange={(e) => {
                setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4))
                setError('')
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
              placeholder="ABCD"
              maxLength={4}
              className="w-full bg-slate-900 border border-slate-700 text-white rounded-xl px-4 py-3 font-mono tracking-[0.5em] uppercase text-center text-xl focus:outline-none focus:border-purple-500 transition-colors placeholder:text-slate-600 placeholder:tracking-normal placeholder:text-base"
            />
          </div>
          <button
            onClick={handleJoin}
            disabled={loading}
            className="w-full py-3.5 bg-purple-700 hover:bg-purple-600 active:bg-purple-800 disabled:opacity-40 text-white font-bold rounded-xl transition-colors"
          >
            {loading ? 'Uniéndose...' : 'Unirse a sala'}
          </button>
        </div>
      </div>
    </main>
  )
}
