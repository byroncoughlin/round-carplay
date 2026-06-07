import { create } from 'zustand'

// Latest low-res CarPlay frame used by <BackdropGlow> to paint the blurred
// "ambient" fill behind the gauges. The render worker posts a small ImageBitmap
// ~5fps; we hold only the most recent one and close the previous to avoid leaks.
interface BackdropStore {
  frame: ImageBitmap | null
  setFrame: (f: ImageBitmap | null) => void
}

export const useBackdrop = create<BackdropStore>((set, get) => ({
  frame: null,
  setFrame: (f) => {
    const prev = get().frame
    if (prev && prev !== f) prev.close()
    set({ frame: f })
  },
}))
