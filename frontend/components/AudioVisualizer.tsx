'use client'

import { useEffect, useRef } from 'react'

interface Props {
  audioElement: HTMLAudioElement | null
  isPlaying: boolean
}

const BAR_COUNT = 28
const FFT_SIZE = 64        // yields 32 frequency bins
const BIN_START = 2        // skip DC offset (0) and sub-bass (1)
// Use bins 2–29 (28 bins in speech frequency range for Vietnamese)

export default function AudioVisualizer({ audioElement, isPlaying }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animFrameRef = useRef<number>(0)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const connectedElementRef = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    if (!audioElement || !canvasRef.current) return

    // Create AudioContext lazily (requires user gesture first)
    if (!contextRef.current) {
      contextRef.current = new AudioContext()
    }
    const ctx = contextRef.current

    // If audioElement changed, disconnect the old source node first
    if (sourceRef.current && connectedElementRef.current !== audioElement) {
      sourceRef.current.disconnect()
      sourceRef.current = null
    }

    // Connect new element (only once per element reference)
    if (!sourceRef.current) {
      try {
        sourceRef.current = ctx.createMediaElementSource(audioElement)
        connectedElementRef.current = audioElement
        analyserRef.current = ctx.createAnalyser()
        analyserRef.current.fftSize = FFT_SIZE
        analyserRef.current.smoothingTimeConstant = 0.8
        sourceRef.current.connect(analyserRef.current)
        analyserRef.current.connect(ctx.destination)
      } catch (e) {
        // HTMLMediaElement already connected — log and continue (idle animation only)
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
    const gap = 1
    const barW = Math.floor(W / BAR_COUNT) - gap

    const draw = () => {
      analyser.getByteFrequencyData(dataArray)

      const avg = dataArray.slice(BIN_START, BIN_START + BAR_COUNT).reduce((s, v) => s + v, 0) / (BAR_COUNT * 255)

      if (!isPlaying || avg < 0.01) {
        canvasCtx.clearRect(0, 0, W, H)
        let x = 0
        for (let i = 0; i < BAR_COUNT; i++) {
          canvasCtx.fillStyle = 'rgba(139, 92, 246, 0.25)'
          canvasCtx.beginPath()
          canvasCtx.roundRect(x, H - 3, barW, 3, 1)
          canvasCtx.fill()
          x += barW + gap
        }
        animFrameRef.current = requestAnimationFrame(draw)
        return
      }

      canvasCtx.clearRect(0, 0, W, H)
      let x = 0
      for (let i = 0; i < BAR_COUNT; i++) {
        const binIndex = BIN_START + i
        const value = dataArray[binIndex] / 255
        const barHeight = Math.max(2, value * (H - 4))
        const y = H - barHeight

        const gradient = canvasCtx.createLinearGradient(0, y, 0, H)
        gradient.addColorStop(0, '#a78bfa')
        gradient.addColorStop(1, '#7c3aed')
        canvasCtx.fillStyle = gradient
        canvasCtx.beginPath()
        canvasCtx.roundRect(x, y, barW, barHeight, 2)
        canvasCtx.fill()
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
      width={BAR_COUNT * 9}
      height={32}
      className="w-full"
      aria-hidden="true"
    />
  )
}
