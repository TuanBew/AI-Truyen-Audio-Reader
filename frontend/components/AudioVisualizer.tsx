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
  // Use a ref for idleTime to prevent unbounded float accumulation across re-renders
  const idleTimeRef = useRef(0)

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

    const draw = () => {
      animFrameRef.current = requestAnimationFrame(draw)
      analyser.getByteFrequencyData(dataArray)

      const { width, height } = canvas
      canvasCtx.clearRect(0, 0, width, height)
      const barWidth = Math.floor(width / BAR_COUNT) - 1

      for (let i = 0; i < BAR_COUNT; i++) {
        const binIndex = BIN_START + i
        const value = dataArray[binIndex] / 255

        let displayValue = value
        if (!isPlaying || value < 0.01) {
          // Wrap idleTime to prevent float precision loss over long sessions
          idleTimeRef.current = (idleTimeRef.current + 0.04) % (Math.PI * 2)
          displayValue = 0.15 + 0.07 * Math.sin(idleTimeRef.current + i * 0.4)
        }

        const barHeight = Math.max(2, displayValue * (height - 4))
        const x = i * (barWidth + 1)
        const y = height - barHeight

        const gradient = canvasCtx.createLinearGradient(0, y, 0, height)
        gradient.addColorStop(0, '#a78bfa')
        gradient.addColorStop(1, '#7c3aed')
        canvasCtx.fillStyle = gradient
        canvasCtx.beginPath()
        canvasCtx.roundRect(x, y, barWidth, barHeight, 2)
        canvasCtx.fill()
      }
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
