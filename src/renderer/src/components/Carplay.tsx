import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { CommandMapping } from '../../../main/carplay/messages/common'

import type { ExtraConfig } from '../../../main/Globals'
import { useCarplayStore, useStatusStore } from '../store/store'
import { useBackdrop } from '../store/backdrop'
import { InitEvent, Renderer } from './worker/render/RenderEvents'
import useCarplayAudio from './useCarplayAudio'
import { useCarplayTouch } from './useCarplayTouch'
import type { CarPlayWorker, KeyCommand } from './worker/types'

type ChunkPacket = {
  id?: string
  offset?: number
  total?: number
  sentAt?: number
  isLast?: boolean
  chunk?: ArrayBuffer | ArrayBufferView
  [key: string]: any
}

type PendingChunk = {
  buffer: Uint8Array
  received: number
  createdAt: number
}

const VIDEO_CHUNK_TTL_MS = 2000
const MAX_PENDING_VIDEO_PACKETS = 4

const prunePendingVideoChunks = (
  pending: Map<string, PendingChunk>,
  now = Date.now()
) => {
  for (const [id, state] of pending) {
    if (now - state.createdAt > VIDEO_CHUNK_TTL_MS) pending.delete(id)
  }

  while (pending.size > MAX_PENDING_VIDEO_PACKETS) {
    const oldest = pending.keys().next().value
    if (!oldest) break
    pending.delete(oldest)
  }
}

const chunkBytes = (chunk: ChunkPacket['chunk']): Uint8Array | null => {
  if (!chunk) return null
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  return null
}

const chunkTransferBuffer = (chunk: ChunkPacket['chunk']): ArrayBuffer | null => {
  if (!chunk) return null
  if (chunk instanceof ArrayBuffer) return chunk
  if (!ArrayBuffer.isView(chunk)) return null
  if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) {
    return chunk.buffer as ArrayBuffer
  }
  return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer
}

const reassembleVideoPacket = (
  packet: ChunkPacket,
  pending: Map<string, PendingChunk>
): ChunkPacket | null => {
  const bytes = chunkBytes(packet.chunk)
  if (!bytes) return null

  const now = Date.now()
  prunePendingVideoChunks(pending, now)

  const total = Number(packet.total ?? bytes.byteLength)
  const offset = Number(packet.offset ?? 0)
  const id = packet.id

  if (!id || !Number.isFinite(total) || total <= bytes.byteLength) return packet
  if (!Number.isFinite(offset) || offset < 0 || offset + bytes.byteLength > total) {
    if (id) pending.delete(id)
    return null
  }

  let state = pending.get(id)
  if (!state || state.buffer.byteLength !== total) {
    state = { buffer: new Uint8Array(total), received: 0, createdAt: now }
    pending.set(id, state)
  }

  state.buffer.set(bytes, offset)
  state.received += bytes.byteLength

  if (!packet.isLast || state.received < total) return null

  pending.delete(id)
  return {
    ...packet,
    offset: 0,
    total,
    isLast: true,
    chunk: state.buffer
  }
}

interface CarplayProps {
  receivingVideo: boolean
  setReceivingVideo: (v: boolean) => void
  settings: ExtraConfig
  command: KeyCommand
  commandCounter: number
}

const Carplay: React.FC<CarplayProps> = ({
  receivingVideo,
  setReceivingVideo,
  settings,
  command,
  commandCounter
}) => {
  const navigate = useNavigate()
  const location = useLocation()
  const pathname = location.pathname
  const plainMode = settings.diagnosticPlainCarplay === true
  const roundedClipMode = settings.diagnosticRoundedCarplayClip === true
  const forceHardwareDecode = settings.diagnosticHardwareDecode === true
  const pointerCaptureTouch =
    settings.pointerCaptureTouch !== false || settings.diagnosticPointerCaptureTouch === true

  // Zustand Store
  const isStreaming = useStatusStore((s) => s.isStreaming)
  const homeMode = useStatusStore((s) => s.homeMode)
  const setStreaming = useStatusStore((s) => s.setStreaming)
  const setDongleConnected = useStatusStore((s) => s.setDongleConnected)
  const isDongleConnected = useStatusStore((s) => s.isDongleConnected)
  const resetInfo = useCarplayStore((s) => s.resetInfo)
  const setDeviceInfo = useCarplayStore((s) => s.setDeviceInfo)
  const setNegotiatedResolution = useCarplayStore((s) => s.setNegotiatedResolution)
  const setAudioInfo = useCarplayStore((s) => s.setAudioInfo)
  const setPcmData = useCarplayStore((s) => s.setPcmData)

  useEffect(() => {
    console.log('[UI] Dongle connected:', isDongleConnected)
  }, [isDongleConnected])

  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mainElem = useRef<HTMLDivElement>(null)
  const hasStartedRef = useRef(false)
  const pendingVideoChunksRef = useRef(new Map<string, PendingChunk>())
  const [renderReady, setRenderReady] = useState(false)

  // MediaPlayStatus Handling
  const mediaPlayStatusRef = useRef<number | undefined>(undefined)
  const audioCommandRef = useRef<number | undefined>(undefined)

  // RenderWorker + OffscreenCanvas per Ref
  const renderWorkerRef = useRef<Worker | null>(null)
  const offscreenCanvasRef = useRef<OffscreenCanvas | null>(null)

  // Render settings
  const preferredRenderer = 'auto' //  'auto' | 'webgl2' | 'webgl' | 'webgpu'
  const reportFps = false
  const useHardware = true // true => prefere-hardware, false => no-preference hardware->software
  const useWebRTC = true

  // Get Settings
  const configRef = useRef(settings)
  useEffect(() => {
    configRef.current = settings
  }, [settings])

  // CHANNELS
  const videoChannel = useMemo(() => new MessageChannel(), [])
  const micChannel = useMemo(() => new MessageChannel(), [])

  // CarPlay Worker Setup
  const carplayWorker = useMemo<CarPlayWorker>(() => {
    const w = new Worker(new URL('./worker/CarPlay.worker.ts', import.meta.url), {
      type: 'module'
    }) as CarPlayWorker

    w.onerror = (e) => {
      console.error('Worker error:', e)
    }

    console.log('[CARPLAY] Creating CarPlayWorker with port:', {
      microphonePort: micChannel.port1
    })

    w.postMessage(
      {
        type: 'initialise',
        payload: {
          microphonePort: micChannel.port1
        }
      },
      [micChannel.port1]
    )
    return w
  }, [micChannel])

  useEffect(() => {
    carplayWorker.postMessage({
      type: 'setPcmEnabled',
      payload: { enabled: !plainMode && pathname === '/info' }
    })
  }, [carplayWorker, pathname, plainMode])

  // Render Worker Setup
  useEffect(() => {
    if (canvasRef.current && !offscreenCanvasRef.current && !renderWorkerRef.current) {
      offscreenCanvasRef.current = canvasRef.current.transferControlToOffscreen()
      const w = new Worker(new URL('./worker/render/Render.worker.ts', import.meta.url), {
        type: 'module'
      })
      renderWorkerRef.current = w
      w.postMessage(
        new InitEvent(
          offscreenCanvasRef.current,
          videoChannel.port2,
          preferredRenderer as Renderer,
          reportFps,
          useHardware,
          useWebRTC,
          forceHardwareDecode
        ),
        [offscreenCanvasRef.current, videoChannel.port2]
      )
    }
    // Cleanup when canvas is unmounted
    return () => {
      renderWorkerRef.current?.terminate()
      renderWorkerRef.current = null
      offscreenCanvasRef.current = null
    }
  }, [videoChannel])

  useEffect(() => {
    if (!renderWorkerRef.current) return
    const handler = (ev: MessageEvent<any>) => {
      if (ev.data?.type === 'render-ready') {
        console.log('[CARPLAY] Render worker ready message recived')
        setRenderReady(true)
      } else if (ev.data?.type === 'backdrop-frame') {
        useBackdrop.getState().setFrame(ev.data.bitmap as ImageBitmap)
      } else if (ev.data?.type === 'render-diagnostics') {
        window.carplay.diagnostics?.log(ev.data.message ?? 'render-worker', ev.data.data)
      }
    }
    renderWorkerRef.current.addEventListener('message', handler)
    return () => renderWorkerRef.current?.removeEventListener('message', handler)
  }, [])

  // Enable the ambient backdrop frame tap only while the backdrop is actually
  // visible. The setting alone is not enough: settings/idle/plain routes should
  // not sample live frames in the worker.
  useEffect(() => {
    if (!renderReady) return
    const enabled =
      !plainMode &&
      pathname === '/' &&
      isStreaming &&
      !homeMode &&
      settings.backdropEnabled === true
    renderWorkerRef.current?.postMessage({
      type: 'set-backdrop',
      enabled,
    })
    if (!enabled) useBackdrop.getState().setFrame(null)
  }, [renderReady, plainMode, pathname, isStreaming, homeMode, settings.backdropEnabled])

  // Preload-Chunks fwd to Worker-Port
  useEffect(() => {
    const handleVideo = (packet: any) => {
      const fullPacket = reassembleVideoPacket(packet, pendingVideoChunksRef.current)
      if (!fullPacket) return

      const transfer = chunkTransferBuffer(fullPacket.chunk)
      if (!transfer) return
      const sentAt =
        typeof fullPacket.sentAt === 'number' && Number.isFinite(fullPacket.sentAt)
          ? fullPacket.sentAt
          : Date.now()

      videoChannel.port1.postMessage(
        {
          buffer: transfer,
          sentAt
        },
        [transfer]
      )
    }

    window.carplay.ipc.onVideoChunk(handleVideo)

    return () => window.carplay.ipc.offVideoChunk?.(handleVideo)
  }, [videoChannel])

  useEffect(() => {
    const handleAudio = (packet: ChunkPacket) => {
      const transfer = chunkTransferBuffer(packet?.chunk)
      if (transfer) {
        const { chunk: _chunk, ...meta } = packet
        micChannel.port2.postMessage(
          {
            ...meta,
            type: 'audio',
            buffer: transfer,
          },
          [transfer]
        )
      }
    }

    window.carplay.ipc.onAudioChunk(handleAudio)

    return () => window.carplay.ipc.offAudioChunk?.(handleAudio)
  }, [micChannel])

  // Audio- and Touch-Hooks
  const { processAudio, getAudioPlayer } = useCarplayAudio(carplayWorker)

  const sendTouchEvent = useCarplayTouch(pointerCaptureTouch)

  // Carplay Worker messages
  useEffect(() => {
    if (!carplayWorker) return
    const handler = (ev: MessageEvent<any>) => {
      const { type, payload, message } = ev.data
      switch (type) {
        case 'plugged':
          setDongleConnected(true)
          break
        case 'unplugged':
          pendingVideoChunksRef.current.clear()
          hasStartedRef.current = false
          setDongleConnected(false)
          setStreaming(false)
          setReceivingVideo(false)
          resetInfo()
          break
        case 'requestBuffer':
          getAudioPlayer(message)
          break
        case 'audio':
          processAudio({
            ...message,
            command: audioCommandRef.current
          })
          audioCommandRef.current = undefined
          break
        case 'audioInfo':
          setAudioInfo(payload)
          break
        case 'pcmData':
          setPcmData(new Float32Array(payload as ArrayBuffer))
          break
        case 'command': {
          const val = (message as any).value
          if (!plainMode && val === CommandMapping.requestHostUI) navigate('/settings')
          break
        }
        case 'dongleInfo':
          setDeviceInfo(payload)
          break
        case 'resolution':
          setNegotiatedResolution(payload.width, payload.height)
          setStreaming(true)
          setReceivingVideo(true)
          hasStartedRef.current = true
          break
        case 'failure':
          pendingVideoChunksRef.current.clear()
          hasStartedRef.current = false
          setStreaming(false)
          setReceivingVideo(false)
          resetInfo()
          break
        case 'phone-unplugged':
          pendingVideoChunksRef.current.clear()
          setDongleConnected(true)
          setStreaming(false)
          setReceivingVideo(false)
          resetInfo()
          break
      }
    }
    carplayWorker.addEventListener('message', handler)
    return () => carplayWorker.removeEventListener('message', handler)
  }, [
    carplayWorker,
    getAudioPlayer,
    processAudio,
    navigate,
    plainMode,
    setDeviceInfo,
    setNegotiatedResolution,
    setAudioInfo,
    setPcmData,
    setDongleConnected,
    setStreaming,
    resetInfo,
    setReceivingVideo
  ])

  // USB
  useEffect(() => {
    const onUsbConnect = async () => {
      if (!hasStartedRef.current) {
        resetInfo()
        setDongleConnected(true)
        hasStartedRef.current = true
      }
    }
    const onUsbDisconnect = async () => {
      pendingVideoChunksRef.current.clear()
      setReceivingVideo(false)
      setStreaming(false)
      setDongleConnected(false)
      hasStartedRef.current = false
      resetInfo()
      await window.carplay.ipc.stop()
      if (canvasRef.current) {
        canvasRef.current.style.width = '0'
        canvasRef.current.style.height = '0'
      }
    }
    const usbHandler = (_: any, data: { type: string }) => {
      if (data.type === 'plugged') onUsbConnect()
      else if (data.type === 'unplugged') onUsbDisconnect()
    }
    window.carplay.usb.listenForEvents(usbHandler)

    ;(async () => {
      const last = await window.carplay.usb.getLastEvent()
      if (last) usbHandler(null, last)
    })()

    return () => {
      window.carplay.usb.unlistenForEvents?.(usbHandler)
    }
  }, [setReceivingVideo, setDongleConnected, setStreaming, navigate, resetInfo])

  // Settings-Events
  useEffect(() => {
    const handler = (_: any, data: any) => {
      switch (data.type) {
        case 'resolution':
          useCarplayStore.setState({
            negotiatedWidth: data.payload.width,
            negotiatedHeight: data.payload.height
          })
          useStatusStore.setState({ isStreaming: true })
          setReceivingVideo(true)
          break
        case 'audioInfo':
          useCarplayStore.setState({
            audioCodec: data.payload.codec,
            audioSampleRate: data.payload.sampleRate,
            audioChannels: data.payload.channels,
            audioBitDepth: data.payload.bitDepth
          })
          break
        case 'media': {
          const playStatus = data.payload?.payload?.media?.MediaPlayStatus
          const prevStatus = mediaPlayStatusRef.current
          if (typeof playStatus === 'number' && playStatus !== prevStatus) {
            mediaPlayStatusRef.current = playStatus
            audioCommandRef.current = playStatus
          }
          break
        }
        case 'plugged':
          useStatusStore.setState({ isDongleConnected: true })
          break
        case 'unplugged':
          pendingVideoChunksRef.current.clear()
          useStatusStore.setState({
            isDongleConnected: false,
            isStreaming: false
          })
          useCarplayStore.getState().resetInfo()
          break
        case 'phone-unplugged':
          pendingVideoChunksRef.current.clear()
          useStatusStore.setState({
            isDongleConnected: true,
            isStreaming: false
          })
          setReceivingVideo(false)
          useCarplayStore.getState().resetInfo()
          break
        case 'command':
          if (!plainMode && data.message?.value === CommandMapping.requestHostUI) navigate('/settings')
          break
      }
    }
    window.carplay.ipc.onEvent(handler)
    return () => {
      window.carplay.ipc.offEvent?.(handler)
    }
  }, [navigate, plainMode])

  // Resize Observer
  useEffect(() => {
    if (!carplayWorker || !mainElem.current) return
    const obs = new ResizeObserver(() => carplayWorker.postMessage({ type: 'frame' }))
    obs.observe(mainElem.current)
    return () => obs.disconnect()
  }, [carplayWorker])

  // KeyCommand
  useEffect(() => {
    if (commandCounter) {
      window.carplay.ipc.sendKeyCommand(command)
    }
  }, [command, commandCounter])

  // Cleanup
  useEffect(() => {
    return () => {
      carplayWorker.terminate()
      renderWorkerRef.current?.terminate()
      renderWorkerRef.current = null
      offscreenCanvasRef.current = null
    }
  }, [carplayWorker])

  const isLoading = !isStreaming

  return (
    <div
      id="main"
      ref={mainElem}
      className="App"
      style={
        plainMode || pathname === '/'
          ? { height: '100%', width: '100%', touchAction: 'none' }
          : { display: 'none' }
      }
    >
      {(!isDongleConnected || isLoading) && pathname === '/' && !homeMode && (
        <div
          style={{
            position: 'absolute',
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            gap: 14,
            paddingTop: '18%',
          }}
        >
          <div style={{
            fontSize: 36,
            fontWeight: 700,
            color: 'rgba(255,255,255,0.82)',
            textAlign: 'center',
            letterSpacing: 0.5,
            lineHeight: 1.2,
          }}>
            {!isDongleConnected ? 'Searching for\nAdapter' : 'Searching for\niPhone'}
          </div>
          <div style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'rgba(255,255,255,0.28)',
            letterSpacing: 3,
            textTransform: 'uppercase',
            textAlign: 'center',
          }}>
            {!isDongleConnected ? 'Connect Carlinkit adapter' : 'Enable CarPlay on iPhone'}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            {[0, 1, 2].map(i => (
              <div
                key={i}
                className="animate-pulse"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: 'rgba(255,255,255,0.22)',
                  animationDelay: `${i * 0.18}s`,
                }}
              />
            ))}
          </div>
        </div>
      )}
      <div
        id="videoContainer"
        onPointerDown={sendTouchEvent}
        onPointerMove={sendTouchEvent}
        onPointerUp={sendTouchEvent}
        onPointerCancel={sendTouchEvent}
        onPointerOut={sendTouchEvent}
        style={{
          height: '100%',
          width: '100%',
          padding: 0,
          margin: 0,
          display: 'flex',
          // Keep the live canvas flat/unclipped. Rounded clipping here was the
          // main source of CarPlay touch latency on the Pi compositor path.
          borderRadius: roundedClipMode ? 36 : 0,
          overflow: roundedClipMode ? 'hidden' : 'visible',
          visibility: receivingVideo ? 'visible' : 'hidden',
          zIndex: receivingVideo ? 1 : -1
        }}
      >
        <canvas
          ref={canvasRef}
          id="video"
          style={{
            width: receivingVideo ? '100%' : '0',
            height: receivingVideo ? '100%' : '0',
          }}
        />
      </div>
    </div>
  )
}

export default React.memo(Carplay)
