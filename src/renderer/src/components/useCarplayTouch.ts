import { useCallback, useRef } from 'react'
import { TouchAction } from '../../../main/carplay/messages/sendable'

export const useCarplayTouch = (
  usePointerCapture = false
): React.PointerEventHandler<HTMLDivElement> => {
  const pressedRef = useRef(false)
  const rectRef = useRef<DOMRect | null>(null)

  return useCallback((e) => {
    if (usePointerCapture) e.preventDefault()

    let action: TouchAction
    let clearRectAfterSend = false
    switch (e.type) {
      case 'pointerdown':
        pressedRef.current = true
        rectRef.current = e.currentTarget.getBoundingClientRect()
        if (usePointerCapture) e.currentTarget.setPointerCapture?.(e.pointerId)
        action = TouchAction.Down
        break
      case 'pointermove':
        if (!pressedRef.current) return
        action = TouchAction.Move
        break
      case 'pointerup':
      case 'pointercancel':
        if (!pressedRef.current) return
        pressedRef.current = false
        clearRectAfterSend = true
        if (usePointerCapture && e.currentTarget.hasPointerCapture?.(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId)
        }
        action = TouchAction.Up
        break
      case 'pointerout':
        if (!pressedRef.current) return
        if (usePointerCapture) {
          action = TouchAction.Move
          break
        }
        pressedRef.current = false
        clearRectAfterSend = true
        action = TouchAction.Up
        break
      default:
        return
    }

    const rect = rectRef.current ?? e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height

    window.carplay.ipc.sendTouch(x, y, action)
    if (clearRectAfterSend) rectRef.current = null
  }, [usePointerCapture])
}
