'use client'

import { useEffect, useRef } from 'react'

interface Props {
  audioElement: HTMLAudioElement | null
  isPlaying: boolean
}

const BAR_COUNT = 28
const FFT_SIZE = 64       // 32 frequency bins
const BIN_START = 2       // skip DC + sub-bass

// Neon color cycle per bar: violet → cyan → pink → repeat
const NEON_COLORS = ['#a78bfa', '#00ffff', '#ff66ff']
const IDLE_COLOR = 'rgba(124, 58, 237, 0.2)'

export default function AudioVisualizer({ audioElement, isPlaying }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameRef = useRef<number>(0)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const connectedElementRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    if (!audioElement || !canvasRef.current) return

    if (!contextRef.current) {
      contextRef.current = new AudioContext()
    }
    const ctx = contextRef.current

    if (sourceRef.current && connectedElementRef.current !== audioElement) {
      sourceRef.current.disconnect()
      sourceRef.current = null
    }

    if (!sourceRef.current) {
      try {
        sourceRef.current = ctx.createMediaElementSource(audioElement)
        connectedElementRef.current = audioElement
        analyserRef.current = ctx.createAnalyser()
        analyserRef.current.fftSize = FFT_SIZE
        analyserRef.current.smoothingTimeConstant = 0.75
        sourceRef.current.connect(analyserRef.current)
        analyserRef.current.connect(ctx.destination)
      } catch (e) {
        console.warn('AudioVisualizer: could not connect audio element', e)
      }
    }

    const analyser = analyserRef.current
    if (!analyser) return

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    const canvas = canvasRef.current
    const canvasCtx = canvas.getContext('2d')!
    const W = canvas.width
    const H = canvas.height
    const gap = 2
    const barW = Math.floor(W / BAR_COUNT) - gap

    const draw = () => {
      analyser.getByteFrequencyData(dataArray)
      const avg = dataArray.slice(BIN_START, BIN_START + BAR_COUNT).reduce((s, v) => s + v, 0) / (BAR_COUNT * 255)

      canvasCtx.clearRect(0, 0, W, H)

      if (!isPlaying || avg < 0.01) {
        // Idle: 2-pixel flatline dots with idle color
        let x = 0
        for (let i = 0; i < BAR_COUNT; i++) {
          canvasCtx.fillStyle = IDLE_COLOR
          canvasCtx.fillRect(x, H - 2, barW, 2)
          x += barW + gap
        }
        animFrameRef.current = requestAnimationFrame(draw)
        return
      }

      // Active: pixel-art bars with neon glow
      let x = 0
      for (let i = 0; i < BAR_COUNT; i++) {
        const binIndex = BIN_START + i
        const value = dataArray[binIndex] / 255
        const barHeight = Math.max(2, Math.min(H - 2, Math.round(value * (H - 2) * 1.8)))
        const y = H - barHeight
        const color = NEON_COLORS[i % NEON_COLORS.length]

        // Glow
        canvasCtx.shadowBlur = value > 0.5 ? 8 : 4
        canvasCtx.shadowColor = color

        // Pixel bar (no rounding — crisp pixel look)
        canvasCtx.fillStyle = color
        canvasCtx.fillRect(x, y, barW, barHeight)

        // Bright cap pixel on top
        canvasCtx.fillStyle = '#ffffff'
        canvasCtx.globalAlpha = 0.6
        canvasCtx.fillRect(x, y, barW, 2)
        canvasCtx.globalAlpha = 1

        canvasCtx.shadowBlur = 0
        x += barW + gap
      }

      animFrameRef.current = requestAnimationFrame(draw)
    }

    if (ctx.state === 'suspended') ctx.resume()
    draw()

    return () => cancelAnimationFrame(animFrameRef.current)
  }, [audioElement, isPlaying])

  return (
    <canvas
      ref={canvasRef}
      width={BAR_COUNT * 11}
      height={40}
      className="w-full"
      style={{ imageRendering: 'pixelated' }}
      aria-hidden="true"
    />
  )
}
