import { app } from 'electron'
import fs from 'fs'
import path from 'path'

const MAX_LOG_BYTES = 512 * 1024
const KEEP_LOG_BYTES = 256 * 1024
const ROTATE_CHECK_INTERVAL_MS = 5000
const MAX_QUEUE_BYTES = 256 * 1024

let queue: string[] = []
let queuedBytes = 0
let flushing = false
let rotating = false
let lastRotateCheck = 0

const safeStringify = (data: unknown): string => {
  if (data === undefined) return ''
  try {
    return ` ${JSON.stringify(data)}`
  } catch {
    return ` ${String(data)}`
  }
}

export const diagnosticsLogPath = (): string =>
  path.join(app.getPath('userData'), 'diagnostics.log')

const trimQueue = (): void => {
  while (queuedBytes > MAX_QUEUE_BYTES && queue.length > 1) {
    const dropped = queue.shift()
    if (dropped) queuedBytes -= Buffer.byteLength(dropped)
  }
}

const rotateIfNeeded = (file: string): void => {
  const now = Date.now()
  if (rotating || now - lastRotateCheck < ROTATE_CHECK_INTERVAL_MS) return
  lastRotateCheck = now
  rotating = true

  fs.stat(file, (statErr, stat) => {
    if (statErr || stat.size <= MAX_LOG_BYTES) {
      rotating = false
      return
    }

    const keep = Math.min(KEEP_LOG_BYTES, stat.size)
    const buf = Buffer.alloc(keep)
    fs.open(file, 'r', (openErr, fd) => {
      if (openErr) {
        rotating = false
        return
      }

      fs.read(fd, buf, 0, keep, stat.size - keep, (readErr) => {
        fs.close(fd, () => {
          if (readErr) {
            rotating = false
            return
          }

          fs.writeFile(file, buf, () => {
            rotating = false
          })
        })
      })
    })
  })
}

const flushQueue = (): void => {
  const file = diagnosticsLogPath()
  const batch = queue.join('')
  queue = []
  queuedBytes = 0

  fs.appendFile(file, batch, 'utf8', () => {
    rotateIfNeeded(file)
    flushing = false
    if (queue.length) scheduleFlush()
  })
}

const scheduleFlush = (): void => {
  if (flushing) return
  flushing = true
  setImmediate(flushQueue)
}

export const diagLog = (scope: string, message: string, data?: unknown): void => {
  try {
    const line = `${new Date().toISOString()} [${scope}] ${message}${safeStringify(data)}\n`
    queue.push(line)
    queuedBytes += Buffer.byteLength(line)
    trimQueue()
    scheduleFlush()
  } catch {
    /* diagnostics must never affect the kiosk */
  }
}
