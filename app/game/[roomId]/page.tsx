'use client'

import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'

// ── World (portrait-first, mobile target) ─────────────────────────────────────
const W = 400, H = 820
const BAR_W = 100, BAR_H = 12, BAR_Y = H - 45
const BALL_R = 7, SPEED = 5
const SYNC_MS = 30, BALL_SYNC_MS = 50, LERP = 0.5

// ── Bricks ───────────────────────────────────────────────────────────────────
const COLS = 5, ROWS = 5
const BGAP = 5
const BW = Math.floor((W - 60 - (COLS - 1) * BGAP) / COLS)   // = 64
const BH = 22
const BLEFT = 30, BTOP = 55
const ROW_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6']
const BRICK_DESCENT = 0.06   // unidades lógicas por frame ≈ 1 fila cada ~8s

function brickRect(i: number, offsetY = 0) {
  const row = Math.floor(i / COLS), col = i % COLS
  return {
    x: BLEFT + col * (BW + BGAP),
    y: BTOP + row * (BH + BGAP) + offsetY,
    cx: BLEFT + col * (BW + BGAP) + BW / 2,
    cy: BTOP + row * (BH + BGAP) + BH / 2 + offsetY,
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────
type Ball = { x: number; y: number; vx: number; vy: number }
type Snap = { balls: Ball[]; p1x: number; p2x: number; bricks: boolean[]; brickOffset: number; score: number; over: boolean }

// ── Deterministic seed ────────────────────────────────────────────────────────
function seededRng(seed: string) {
  let h = 0x9e3779b9
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 0x9e3779b9) | 0
  return () => { h ^= h << 13; h ^= h >> 17; h ^= h << 5; return (h >>> 0) / 2 ** 32 }
}

function makeBall(seed: string, index: number): Ball {
  const rng = seededRng(seed + index)
  const angle = (rng() * 50 + 55) * (Math.PI / 180)   // 55°–105°
  const dir = rng() < 0.5 ? 1 : -1
  // Pelotas nuevas aparecen en X alternadas para repartir la presión
  const startX = index === 0 ? W / 2 : W * (0.2 + (index % 4) * 0.2)
  return {
    x: startX, y: H - 100,
    vx: Math.cos(angle) * SPEED * dir,
    vy: -Math.abs(Math.sin(angle) * SPEED),
  }
}

function freshSnap(roomId: string, restart = 0): Snap {
  return {
    balls: [makeBall(roomId + restart, 0)],
    p1x: W / 4,
    p2x: (3 * W) / 4,
    bricks: Array(COLS * ROWS).fill(true),
    brickOffset: 0,
    score: 0,
    over: false,
  }
}

const BAR_GAP = 3

function clampToWorld(x: number) { return Math.max(BAR_W / 2, Math.min(W - BAR_W / 2, x)) }

// Modelo "muro blando, sin empujar":
// — Si el compañero ha entrado en mi zona, solo me permito alejarme (escape).
// — Si no hay solapamiento, simplemente bloqueo MI movimiento antes de entrar en su zona.
function applyBarCollision(rawX: number, prevX: number, remX: number): number {
  const x = clampToWorld(rawX)
  if (Math.abs(prevX - remX) < BAR_W + BAR_GAP) {
    // Solapamiento existente (el compañero vino hacia mí): solo permito salir
    return prevX < remX ? Math.min(x, prevX) : Math.max(x, prevX)
  }
  // Sin solapamiento: bloqueo mi avance
  return prevX < remX
    ? Math.min(x, remX - BAR_W - BAR_GAP)
    : Math.max(x, remX + BAR_W + BAR_GAP)
}

// ── Physics ───────────────────────────────────────────────────────────────────
function tickBall(ball: Ball, s: Snap, bricks: boolean[]): { ball: Ball; bricks: boolean[]; scored: number; over: boolean } {
  let { x, y, vx, vy } = ball
  let scored = 0
  let over = false

  x += vx; y += vy

  if (x - BALL_R <= 0)   { x = BALL_R;     vx =  Math.abs(vx) }
  if (x + BALL_R >= W)   { x = W - BALL_R; vx = -Math.abs(vx) }
  if (y - BALL_R <= 0)   { y = BALL_R;     vy =  Math.abs(vy) }

  // Brick collisions (bricks is shared — primera pelota que toca un ladrillo lo rompe)
  for (let i = 0; i < bricks.length; i++) {
    if (!bricks[i]) continue
    const { cx, cy } = brickRect(i, s.brickOffset)
    const nearX = Math.max(cx - BW / 2, Math.min(cx + BW / 2, x))
    const nearY = Math.max(cy - BH / 2, Math.min(cy + BH / 2, y))
    const dx = x - nearX, dy = y - nearY
    if (dx * dx + dy * dy < BALL_R * BALL_R) {
      bricks[i] = false
      scored++
      if (Math.abs(dy) >= Math.abs(dx)) vy = dy > 0 ? Math.abs(vy) : -Math.abs(vy)
      else                               vx = dx > 0 ? Math.abs(vx) : -Math.abs(vx)
      break
    }
  }

  // P1 bar
  if (vy > 0 &&
      y + BALL_R >= BAR_Y - BAR_H / 2 && y - BALL_R <= BAR_Y + BAR_H / 2 &&
      x >= s.p1x - BAR_W / 2 && x <= s.p1x + BAR_W / 2) {
    y = BAR_Y - BAR_H / 2 - BALL_R
    const rel = Math.max(-0.8, Math.min(0.8, (x - s.p1x) / (BAR_W / 2)))
    vx = rel * SPEED * 0.85
    vy = -Math.sqrt(Math.max(1, SPEED * SPEED - vx * vx))
  }

  // P2 bar
  if (vy > 0 &&
      y + BALL_R >= BAR_Y - BAR_H / 2 && y - BALL_R <= BAR_Y + BAR_H / 2 &&
      x >= s.p2x - BAR_W / 2 && x <= s.p2x + BAR_W / 2) {
    y = BAR_Y - BAR_H / 2 - BALL_R
    const rel = Math.max(-0.8, Math.min(0.8, (x - s.p2x) / (BAR_W / 2)))
    vx = rel * SPEED * 0.85
    vy = -Math.sqrt(Math.max(1, SPEED * SPEED - vx * vx))
  }

  if (y + BALL_R >= H) over = true

  return { ball: { x, y, vx, vy }, bricks, scored, over }
}

function tick(s: Snap): Snap {
  if (s.over) return s
  let score = s.score
  let over = false
  let bricks = [...s.bricks]

  // Descenso del techo de ladrillos
  const ROW_H = BH + BGAP
  let brickOffset = s.brickOffset + BRICK_DESCENT
  if (brickOffset >= ROW_H) {
    brickOffset -= ROW_H
    // Fila nueva en la cima, la fila más baja desaparece
    bricks = [...Array(COLS).fill(true), ...bricks.slice(0, COLS * (ROWS - 1))]
  }

  // Las colisiones usan el offset actualizado
  const sWithOffset = { ...s, brickOffset }

  const balls = s.balls.map(ball => {
    const r = tickBall(ball, sWithOffset, bricks)
    bricks = r.bricks
    score += r.scored
    if (r.over) over = true
    return r.ball
  })

  return { ...s, balls, bricks, brickOffset, score, over }
}

// ── Render ────────────────────────────────────────────────────────────────────
function render(ctx: CanvasRenderingContext2D, s: Snap, sw: number, sh: number, isP1: boolean, names: { p1: string; p2: string }) {
  const scale = Math.min(sw / W, sh / H)
  const ox = (sw - W * scale) / 2, oy = (sh - H * scale) / 2

  ctx.fillStyle = '#030712'
  ctx.fillRect(0, 0, sw, sh)
  ctx.save()
  ctx.translate(ox, oy)
  ctx.scale(scale, scale)

  // Background
  ctx.fillStyle = '#0f172a'
  ctx.fillRect(0, 0, W, H)

  // Subtle floor danger gradient
  const grad = ctx.createLinearGradient(0, H - 90, 0, H)
  grad.addColorStop(0, 'rgba(239,68,68,0)')
  grad.addColorStop(1, 'rgba(239,68,68,0.10)')
  ctx.fillStyle = grad
  ctx.fillRect(0, H - 70, W, 70)

  // Bricks
  for (let i = 0; i < s.bricks.length; i++) {
    if (!s.bricks[i]) continue
    const row = Math.floor(i / COLS)
    const { x, y } = brickRect(i, s.brickOffset)
    const color = ROW_COLORS[row]
    ctx.fillStyle = color
    ctx.shadowColor = color
    ctx.shadowBlur = 5
    ctx.beginPath()
    ctx.roundRect(x, y, BW, BH, 3)
    ctx.fill()
    ctx.shadowBlur = 0
  }

  // Balls
  ctx.shadowColor = '#ffffff90'
  ctx.shadowBlur = 14
  ctx.fillStyle = '#ffffff'
  for (const ball of s.balls) {
    ctx.beginPath()
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.shadowBlur = 0

  // P1 bar — always BLUE
  ctx.fillStyle = '#3b82f6'
  ctx.shadowColor = isP1 ? '#3b82f6cc' : '#3b82f644'
  ctx.shadowBlur = isP1 ? 20 : 6
  ctx.beginPath()
  ctx.roundRect(s.p1x - BAR_W / 2, BAR_Y - BAR_H / 2, BAR_W, BAR_H, 6)
  ctx.fill()
  ctx.shadowBlur = 0

  // P2 bar — always RED
  ctx.fillStyle = '#ef4444'
  ctx.shadowColor = !isP1 ? '#ef4444cc' : '#ef444444'
  ctx.shadowBlur = !isP1 ? 20 : 6
  ctx.beginPath()
  ctx.roundRect(s.p2x - BAR_W / 2, BAR_Y - BAR_H / 2, BAR_W, BAR_H, 6)
  ctx.fill()
  ctx.shadowBlur = 0

  // Bar labels
  ctx.font = 'bold 12px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#93c5fd'
  ctx.fillText(names.p1, s.p1x, BAR_Y + BAR_H / 2 + 4)
  ctx.fillStyle = '#fca5a5'
  ctx.fillText(names.p2, s.p2x, BAR_Y + BAR_H / 2 + 4)

  // Score (faded center)
  ctx.globalAlpha = 0.18
  ctx.font = 'bold 90px monospace'
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(s.score), W / 2, H / 2 + 20)
  ctx.globalAlpha = 1

  // Game over
  if (s.over) {
    ctx.fillStyle = 'rgba(0,0,0,0.72)'
    ctx.fillRect(0, 0, W, H)
    ctx.shadowColor = '#f87171'
    ctx.shadowBlur = 24
    ctx.fillStyle = '#f87171'
    ctx.font = 'bold 46px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('GAME OVER', W / 2, H / 2 - 40)
    ctx.shadowBlur = 0
    ctx.fillStyle = '#ffffff'
    ctx.font = '26px monospace'
    ctx.fillText(`${s.score} punto${s.score !== 1 ? 's' : ''}`, W / 2, H / 2 + 16)
  }

  ctx.restore()
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function GamePage() {
  const { roomId } = useParams<{ roomId: string }>()
  const router = useRouter()

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const snapRef = useRef<Snap | null>(null)
  const isP1Ref = useRef(false)

  // Own bar: rawMouseXRef = posición sin restricciones (del ratón/dedo)
  //          myXRef        = posición restringida final (lo que se envía y renderiza)
  const rawMouseXRef = useRef(0)
  const myXRef = useRef(0)
  const remoteLerpRef = useRef(0)      // current smoothed position
  const remoteTargetRef = useRef(0)    // latest received position

  const namesRef = useRef({ p1: 'J1', p2: 'J2' })
  const channelRef = useRef<RealtimeChannel | null>(null)
  const rafRef = useRef(0)
  const lastBarSyncRef = useRef(0)
  const lastBallSyncRef = useRef(0)
  const lastNewBallRef = useRef(0)
  const restartCountRef = useRef(0)
  const gameOverRef = useRef(false)

  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [gameOver, setGameOver] = useState(false)

  // Reinicia el juego en la misma sala (llamado localmente y desde el broadcast 'restart')
  function applyRestart(count: number) {
    restartCountRef.current = count
    const snap = freshSnap(roomId, count)
    snapRef.current = snap
    const initX = isP1Ref.current ? snap.p1x : snap.p2x
    rawMouseXRef.current = initX
    myXRef.current = initX
    remoteLerpRef.current = isP1Ref.current ? snap.p2x : snap.p1x
    remoteTargetRef.current = remoteLerpRef.current
    lastNewBallRef.current = 0
    gameOverRef.current = false
    setGameOver(false)
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    async function init() {
      const pid = localStorage.getItem('duplas_player_id') ?? ''

      const storedRole = sessionStorage.getItem(`duplas_role_${roomId}`)
      // Siempre consultamos la sala para obtener los nombres
      const { data: room } = await supabase
        .from('rooms').select('player1_id, player2_id, player1_name, player2_name').eq('id', roomId).single()
      if (!room) { setError('Sala no encontrada'); return }

      if (!storedRole) {
        isP1Ref.current = room.player1_id === pid
      } else {
        isP1Ref.current = storedRole === 'p1'
      }
      namesRef.current = {
        p1: (room.player1_name as string | null) ?? 'J1',
        p2: (room.player2_name as string | null) ?? 'J2',
      }
      console.log(`[ROL] ${isP1Ref.current ? 'P1 (creador)' : 'P2 (unido)'} — sessionStorage: "${storedRole}"`)

      const c = canvasRef.current!
      function sizeCanvas() {
        c.width  = window.innerWidth
        c.height = window.innerHeight
      }
      sizeCanvas()
      window.addEventListener('resize', sizeCanvas)
      // orientationchange fires before dimensions update on iOS
      window.addEventListener('orientationchange', () => setTimeout(sizeCanvas, 150))

      const snap = freshSnap(roomId)
      snapRef.current = snap
      const initMyX = isP1Ref.current ? snap.p1x : snap.p2x
      rawMouseXRef.current = initMyX
      myXRef.current = initMyX
      remoteLerpRef.current = isP1Ref.current ? snap.p2x : snap.p1x
      remoteTargetRef.current = remoteLerpRef.current

      // Realtime channel — registrar listeners ANTES de subscribe()
      const role = isP1Ref.current ? 'P1' : 'P2'
      const ch = supabase.channel(`game-${roomId}`, {
        config: { broadcast: { self: false } },
      })

      // Receive the other player's bar position
      const barListenEvent = isP1Ref.current ? 'bar2' : 'bar1'
      ch.on('broadcast', { event: barListenEvent }, ({ payload }) => {
        remoteTargetRef.current = (payload.x as number)
      })

      // Cualquier jugador puede iniciar un reinicio
      ch.on('broadcast', { event: 'restart' }, ({ payload }) => {
        applyRestart(payload.count as number)
      })

      // P2: recibe estado autoritativo de P1 (pelotas, ladrillos, score, game over)
      if (!isP1Ref.current) {
        ch.on('broadcast', { event: 'ball' }, ({ payload }) => {
          if (snapRef.current) {
            snapRef.current = {
              ...snapRef.current,
              balls: payload.balls as Ball[],
              bricks: payload.bricks as boolean[],
              brickOffset: payload.brickOffset as number,
              score: payload.score as number,
              over: payload.over as boolean,
            }
          }
        })
      }

      // Arrancar el juego solo cuando el canal esté listo
      ch.subscribe((status) => {
        console.log(`[${role}] canal "game-${roomId}" estado: ${status}`)
        if (status === 'SUBSCRIBED') {
          channelRef.current = ch
          setReady(true)
        }
      })
    }

    init()
    return () => {
      cancelAnimationFrame(rafRef.current)
      channelRef.current?.unsubscribe()
    }
  }, [roomId, router])

  // ── Input ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const c = canvasRef.current
    if (!c || !ready) return

    function fromScreenX(clientX: number) {
      const scale = Math.min(c!.width / W, c!.height / H)
      const ox = (c!.width - W * scale) / 2
      rawMouseXRef.current = clampToWorld((clientX - ox) / scale)
    }

    const onMouse = (e: MouseEvent) => fromScreenX(e.clientX)
    const onTouch = (e: TouchEvent) => { e.preventDefault(); fromScreenX(e.touches[0].clientX) }

    c.addEventListener('mousemove', onMouse)
    c.addEventListener('touchmove', onTouch, { passive: false })
    c.addEventListener('touchstart', onTouch, { passive: false })
    return () => {
      c.removeEventListener('mousemove', onMouse)
      c.removeEventListener('touchmove', onTouch)
      c.removeEventListener('touchstart', onTouch)
    }
  }, [ready])

  // ── Game loop ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return

    const c = canvasRef.current!
    const ctx = c.getContext('2d')!

    function loop(now: number) {
      rafRef.current = requestAnimationFrame(loop)

      // Lerp remote bar
      remoteLerpRef.current += (remoteTargetRef.current - remoteLerpRef.current) * LERP

      const remX = remoteLerpRef.current
      // Aplica colisión: la barra no puede cruzar la del compañero
      const myX = applyBarCollision(rawMouseXRef.current, myXRef.current, remX)
      myXRef.current = myX
      rawMouseXRef.current = myX   // cancela el overshoot pendiente: si colisionó, no hay intención almacenada

      const s = snapRef.current!
      const withBars: Snap = isP1Ref.current
        ? { ...s, p1x: myX, p2x: remX }
        : { ...s, p1x: remX, p2x: myX }

      if (isP1Ref.current) {
        // ── P1: única fuente de verdad ─────────────────────────────────────────
        const next = tick(withBars)
        snapRef.current = next

        if (next.over && !gameOverRef.current) {
          gameOverRef.current = true
          setGameOver(true)
        }

        // Añade pelota nueva cada 10s (máx. 4)
        if (!next.over) {
          if (lastNewBallRef.current === 0) lastNewBallRef.current = now
          if (now - lastNewBallRef.current >= 10000 && next.balls.length < 4) {
            const newBall = makeBall(roomId + restartCountRef.current, next.balls.length)
            // Nueva pelota + velocidad +5% para todas
            snapRef.current = {
              ...next,
              balls: [...next.balls, newBall].map(b => ({ ...b, vx: b.vx * 1.05, vy: b.vy * 1.05 })),
            }
            lastNewBallRef.current = now
          }
        }

        // Broadcast estado completo cada BALL_SYNC_MS
        if (now - lastBallSyncRef.current >= BALL_SYNC_MS) {
          const snap = snapRef.current!
          channelRef.current?.send({
            type: 'broadcast',
            event: 'ball',
            payload: { balls: snap.balls, bricks: snap.bricks, brickOffset: snap.brickOffset, score: snap.score, over: snap.over },
          })
          lastBallSyncRef.current = now
        }
      } else {
        // ── P2: no corre física, solo actualiza posiciones de barras ───────────
        snapRef.current = withBars

        // Game over llega exclusivamente del broadcast de P1
        if (withBars.over && !gameOverRef.current) {
          gameOverRef.current = true
          setGameOver(true)
        }
      }

      render(ctx, snapRef.current, c.width, c.height, isP1Ref.current, namesRef.current)

      // Ambos envían su barra cada SYNC_MS
      if (now - lastBarSyncRef.current >= SYNC_MS) {
        channelRef.current?.send({
          type: 'broadcast',
          event: isP1Ref.current ? 'bar1' : 'bar2',
          payload: { x: myX },
        })
        lastBarSyncRef.current = now
      }
    }

    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [ready])

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden' }}>
      <canvas ref={canvasRef} style={{ display: 'block', touchAction: 'none', position: 'fixed', top: 0, left: 0 }} />

      {!ready && !error && (
        <div style={{ position: 'absolute', inset: 0, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: '#94a3b8', fontSize: 18 }}>Cargando partida...</p>
        </div>
      )}
      {error && (
        <div style={{ position: 'absolute', inset: 0, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p style={{ color: '#f87171', fontSize: 18 }}>{error}</p>
        </div>
      )}
      {gameOver && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <button
            onClick={() => {
              const count = restartCountRef.current + 1
              applyRestart(count)
              channelRef.current?.send({
                type: 'broadcast',
                event: 'restart',
                payload: { count },
              })
            }}
            style={{
              marginTop: 120,
              pointerEvents: 'auto',
              padding: '14px 40px',
              background: '#22c55e',
              color: '#000',
              fontWeight: 700,
              fontSize: 18,
              borderRadius: 12,
              border: 'none',
              cursor: 'pointer',
            }}
          >
            ¡Revancha!
          </button>
        </div>
      )}
    </div>
  )
}
