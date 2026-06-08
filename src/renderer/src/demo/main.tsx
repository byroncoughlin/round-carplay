// DEMO web entry point. Installs browser stubs BEFORE anything else imports the
// preload bridge, then mounts the same App used on the Pi. Sensor data comes
// from the aliased fake socket (demo/mockSocket.ts).
import './stubs'

import ReactDOM from 'react-dom/client'
import App from '../App'
import { ThemeProvider, CssBaseline } from '@mui/material'
import { useCarplayStore, useStatusStore } from '../store/store'
import { useBackdrop } from '../store/backdrop'
import { darkTheme, lightTheme, initCursorHider } from '../theme'
import '@fontsource/roboto/300.css'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'
import './demo.css'

initCursorHider()

// Hide the static CarPlay map whenever a metric graph is open (the graph lives
// inside the center square; the map would otherwise sit on top of it).
const cpMap = document.getElementById('cp-map')
const cpBadge = document.getElementById('cp-badge')
if (cpMap) {
  useStatusStore.subscribe((state) => {
    const hidden = state.activeGraph !== null
    cpMap.classList.toggle('cp-map--hidden', hidden)
    cpBadge?.classList.toggle('cp-map--hidden', hidden)
  })
}

// Ambient round backdrop, like the Pi: BackdropGlow paints a blurred, scaled-up
// copy of the center screen behind the gauges. On the Pi the render worker feeds
// live video frames and the glow is gated on `isStreaming`. Here we flip that
// flag on and feed the static CarPlay map once, so the dead space around the
// center square bleeds the map's color instead of sitting on black.
useStatusStore.setState({ isStreaming: true, homeMode: false })
{
  const bg = new Image()
  bg.onload = () => {
    createImageBitmap(bg)
      .then((bmp) => useBackdrop.getState().setFrame(bmp))
      .catch(() => {})
  }
  bg.src = './carplay-map.png?v=2'
}

const Root = () => {
  const settings = useCarplayStore((state) => state.settings)
  const theme = settings ? (settings.nightMode ? darkTheme : lightTheme) : darkTheme

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<Root />)
