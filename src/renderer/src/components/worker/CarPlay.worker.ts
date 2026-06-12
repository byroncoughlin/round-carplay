import { decodeTypeMap } from '../../../../main/carplay/messages/readable'
import { AudioPlayerKey } from './types'
import { RingBuffer } from 'ringbuf.js'
import { createAudioPlayerKey } from './utils'

const audioBuffers: Record<AudioPlayerKey, RingBuffer> = {}
const pendingAudio: Record<AudioPlayerKey, Int16Array[]> = {}
const MAX_PENDING_AUDIO_BUFFERS = 12

let microphonePort: MessagePort | undefined

let isNewStream = true
let lastPcmTimestamp = Date.now()
let pcmEnabled = false
const PCM_TIMEOUT = 2000

function processAudioData(audioData: any) {
  const { decodeType, audioType } = audioData;
  const meta = decodeTypeMap[decodeType];
  if (!meta) {
    console.warn('[CARPLAY.WORKER] Dropping audio with unknown decodeType:', decodeType)
    return
  }

  let int16: Int16Array;

  if (audioData.data instanceof Int16Array) {
    int16 = audioData.data.byteOffset % 2 === 0 && audioData.data.buffer.byteLength >= audioData.data.byteOffset + audioData.data.byteLength
      ? audioData.data
      : new Int16Array(audioData.data);
  } else if (audioData.buffer instanceof ArrayBuffer) {
    int16 = new Int16Array(audioData.buffer);
  } else {
    console.error('[CARPLAY.WORKER] PCM - Cannot interpret PCM data:', audioData);
    return;
  }

  const currentTime = Date.now();
  if (currentTime - lastPcmTimestamp > PCM_TIMEOUT) {
    isNewStream = true; 
  }

  if (isNewStream) {
    isNewStream = false;

    const newAudioInfo = {
      codec: meta.format ?? meta.mimeType ?? String(decodeType),
      sampleRate: meta.frequency,
      channels: meta.channel,
      bitDepth: meta.bitDepth,
    };

    self.postMessage({
      type: 'audioInfo',
      payload: newAudioInfo,
    });
  }

  // PCM FFT/Mono is only needed by the Info screen's spectrum view. Keep it
  // off during normal CarPlay so audio chunks do not generate extra worker
  // CPU, main-thread messages, and Zustand updates.
  if (pcmEnabled) {
    const channels = Math.max(1, meta.channel ?? 2);
    const frames = Math.floor(int16.length / channels);
    const float32 = new Float32Array(frames);

    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        sum += int16[i * channels + c] || 0
      }
      float32[i] = (sum / channels) / 32768
    }
    self.postMessage(
      { type: 'pcmData', payload: float32.buffer, decodeType },
      [float32.buffer]
    );
  }

  const key = createAudioPlayerKey(decodeType, audioType);
  if (audioBuffers[key]) {
    audioBuffers[key].push(int16);
  } else {
    pendingAudio[key] = pendingAudio[key] || [];
    pendingAudio[key].push(int16);
    while (pendingAudio[key].length > MAX_PENDING_AUDIO_BUFFERS) {
      pendingAudio[key].shift()
    }
    self.postMessage({ type: 'requestBuffer', message: { decodeType, audioType } });
  }

  lastPcmTimestamp = currentTime;
}

function setupPorts(mPort: MessagePort) {
  try {
    mPort.onmessage = ev => {
      try {
        const data = ev.data as any
        if (data.type === 'audio' && data.buffer) {
          processAudioData(data);
        }
      } catch (e) {
        console.error('[CARPLAY.WORKER] Error processing audio message:', e);
      }
    }

    mPort.start?.();
  } catch (e) {
    console.error('[CARPLAY.WORKER] Error setting up ports:', e);
    self.postMessage({ type: 'failure', error: 'Port setup failed' });
  }
}

self.onmessage = ev => {
  const data = ev.data as any
  switch (data.type) {
    case 'initialise': {
      microphonePort = data.payload.microphonePort
      if (microphonePort) {
        setupPorts(microphonePort)
      } else {
        console.error('[CARPLAY.WORKER] Missing microphonePort in initialise payload!')
      }
      break
    }
    case 'audioPlayer': {
      const { sab, decodeType, audioType } = data.payload as {
        sab: SharedArrayBuffer
        decodeType: number
        audioType: number
      }
      const key = createAudioPlayerKey(decodeType, audioType)
      audioBuffers[key] = new RingBuffer(sab, Int16Array)
      const pend = pendingAudio[key] || []
      pend.forEach(buf => audioBuffers[key].push(buf))
      delete pendingAudio[key]
      break
    }
    case 'stop':
      isNewStream = true;
      break
    case 'setPcmEnabled':
      pcmEnabled = data.payload?.enabled === true
      break
    default:
      break
  }
}

export {}
