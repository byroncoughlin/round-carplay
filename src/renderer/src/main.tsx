import ReactDOM from 'react-dom/client'
import App from './App'
import { ThemeProvider, CssBaseline } from '@mui/material'
import { useCarplayStore } from './store/store'
import { darkTheme, lightTheme, initCursorHider } from './theme'
import '@fontsource/roboto/300.css'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'

initCursorHider();

const Root = () => {
  const settings = useCarplayStore(state => state.settings);
  const theme = settings ? (settings.nightMode ? darkTheme : lightTheme) : darkTheme;

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  );
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <Root />
);

// Fade out the boot splash once the dashboard has mounted and painted.
// A short minimum keeps the logo from flashing by on a fast boot.
const splash = document.getElementById('splash');
if (splash) {
  const MIN_SHOW_MS = 1200;
  const start = performance.now();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const wait = Math.max(0, MIN_SHOW_MS - (performance.now() - start));
      window.setTimeout(() => {
        splash.classList.add('hide');
        window.setTimeout(() => splash.remove(), 700);
      }, wait);
    })
  );
}

