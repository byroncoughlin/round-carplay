import { useEffect, useState } from "react";
import { HashRouter as Router, Route, Routes, useLocation } from "react-router-dom";
import Settings from "./components/Settings";
import SysMonitor from "./components/SysMonitor";
import Info from "./components/Info";
import Home from "./components/Home";
import HomeView from "./components/HomeView";
import Nav from "./components/Nav";
import Carplay from './components/Carplay';
import Camera from './components/Camera';
import SpeedDisplay from './components/SpeedDisplay';
import LeanAngle from './components/LeanAngle';
import CHTGauge from './components/CHTGauge';
import DevPanel from './components/DevPanel';
import MetricGraph from './components/MetricGraph';
import BackdropGlow from './components/BackdropGlow';
import { Box, Modal } from '@mui/material';
import { useCarplayStore, useStatusStore } from "./store/store";
import type { KeyCommand } from "./components/worker/types";

const DEFAULT_AMBIENT_FILL_COLOR = '#142321'
const normalizeHexColor = (value?: string) =>
  /^#[0-9a-fA-F]{6}$/.test(value ?? '') ? value! : DEFAULT_AMBIENT_FILL_COLOR

const style = {
  position: 'absolute',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  height: '95%',
  width: '95%',
  boxShadow: 24,
  display: "flex"
};

function AppContent() {
  const [receivingVideo, setReceivingVideo] = useState(false);
  const [commandCounter, setCommandCounter] = useState(0);
  const [keyCommand, setKeyCommand] = useState('');
  const { pathname } = useLocation();

  const reverse      = useStatusStore(state => state.reverse);
  const setReverse   = useStatusStore(state => state.setReverse);
  const activeGraph  = useStatusStore(state => state.activeGraph);
  const setActiveGraph = useStatusStore(state => state.setActiveGraph);

  const settings = useCarplayStore(state => state.settings);
  const diagnosticPlainCarplay = settings?.diagnosticPlainCarplay === true;
  const diagnosticRoundedCarplayClip = settings?.diagnosticRoundedCarplayClip === true;
  const backdropEnabled = settings?.backdropEnabled === true;
  const ambientFillEnabled = settings?.ambientFillEnabled === true && !backdropEnabled;
  const ambientFillColor = normalizeHexColor(settings?.ambientFillColor)
  const routeIsRoot = pathname === '/';
  const arcPointerEvents = routeIsRoot ? 'auto' : 'none';

  useEffect(() => {
    if (!routeIsRoot && activeGraph) setActiveGraph(null);
  }, [routeIsRoot, activeGraph, setActiveGraph]);

  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return;
    if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;

    let lastLog = 0;
    const observer = new PerformanceObserver((list) => {
      const slow = list.getEntries().filter((entry) => entry.duration >= 100);
      if (!slow.length) return;

      const now = Date.now();
      if (now - lastLog < 1000) return;
      lastLog = now;

      const durations = slow.map((entry) => Math.round(entry.duration));
      window.carplay.diagnostics?.log('long-task', {
        count: slow.length,
        max: Math.max(...durations),
        total: durations.reduce((sum, duration) => sum + duration, 0),
        route: window.location.hash || '#/'
      });
    });

    observer.observe({ entryTypes: ['longtask'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [settings]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (!settings) return;

    if (Object.values(settings.bindings).includes(event.code)) {
      const action = Object.keys(settings.bindings).find(
        key => settings.bindings[key] === event.code
      );
      if (action !== undefined) {
        setKeyCommand(action);
        setCommandCounter(prev => prev + 1);
        if (action === 'selectDown') {
          setTimeout(() => {
            setKeyCommand('selectUp');
            setCommandCounter(prev => prev + 1);
          }, 200);
        }
      }
    }
  };

  // 565/800 = 70.625% — the largest square inscribed in the 800px circle
  const SQUARE = '70.625%'
  // 117/800 = 14.625% — the arc height/width outside the square
  const ARC = '14.625%'

  return (
      <div
        className="w-screen h-screen flex items-center justify-center bg-black"
        style={{ touchAction: 'none' }}
      >
        {/* Outer circle — clips everything to the round display */}
        <div
          style={{
            position: 'relative',
            width: 'min(100vw, 100vh)',
            height: 'min(100vw, 100vh)',
            borderRadius: '50%',
            overflow: 'hidden',
            backgroundColor: ambientFillEnabled ? ambientFillColor : 'black',
          }}
        >
          {diagnosticPlainCarplay ? (
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: SQUARE,
                height: SQUARE,
                backgroundColor: 'black',
                zIndex: 5,
                overflow: 'hidden',
              }}
            >
              <div className="w-full h-full flex items-center justify-center" style={{ position: 'relative' }}>
                {settings && (
                  <Carplay
                    receivingVideo={receivingVideo}
                    setReceivingVideo={setReceivingVideo}
                    settings={settings}
                    command={keyCommand as KeyCommand}
                    commandCounter={commandCounter}
                  />
                )}
              </div>
            </div>
          ) : (
            <>
              {/* Ambient blurred-video fill — sits behind the center square (z5)
                  and gauges (z10), filling the round display with on-screen color */}
              {routeIsRoot && backdropEnabled && <BackdropGlow />}

              {/* Hidden Pi CPU/RAM monitor — two-finger press-and-hold to open */}
              <SysMonitor />

              {/* Top arc — GPS Speed */}
              <div style={{
                position: 'absolute',
                top: 0,
                left: '50%',
                transform: 'translateX(-50%)',
                width: SQUARE,
                height: ARC,
                zIndex: 10,
                pointerEvents: arcPointerEvents,
                backgroundColor: ambientFillEnabled ? ambientFillColor : 'transparent',
              }}>
                <SpeedDisplay />
              </div>

              {/* Bottom arc — lean bar with inline alt/G */}
              <div style={{
                position: 'absolute',
                bottom: 0,
                left: '50%',
                transform: 'translateX(-50%)',
                width: SQUARE,
                height: ARC,
                zIndex: 10,
                pointerEvents: arcPointerEvents,
                backgroundColor: ambientFillEnabled ? ambientFillColor : 'transparent',
              }}>
                <LeanAngle />
              </div>

              {/* Left arc — CHT Left cylinder */}
              <div style={{
                position: 'absolute',
                left: 0,
                top: '50%',
                transform: 'translateY(-50%)',
                width: ARC,
                height: SQUARE,
                zIndex: 10,
                pointerEvents: arcPointerEvents,
                backgroundColor: ambientFillEnabled ? ambientFillColor : 'transparent',
              }}>
                <CHTGauge side="L" />
              </div>

              {/* Right arc — CHT Right cylinder */}
              <div style={{
                position: 'absolute',
                right: 0,
                top: '50%',
                transform: 'translateY(-50%)',
                width: ARC,
                height: SQUARE,
                zIndex: 10,
                pointerEvents: arcPointerEvents,
                backgroundColor: ambientFillEnabled ? ambientFillColor : 'transparent',
              }}>
                <CHTGauge side="R" />
              </div>

              {/* DevPanel — floats over bottom arc, outside center square */}
              <DevPanel />

              {/* Center square — CarPlay (565×565, perfectly centered) */}
              <div
                style={{
                  position: 'absolute',
                  top: '50%',
                  left: '50%',
                  transform: 'translate(-50%, -50%)',
                  width: SQUARE,
                  height: SQUARE,
                  backgroundColor: 'transparent',
                  zIndex: routeIsRoot ? 5 : 20,
                  // Do not clip this square in normal mode. The fast A/B kept
                  // the entire CarPlay host surface flat; even conditional
                  // rounded clipping here can put the live canvas back onto the
                  // expensive compositor path on the Pi.
                  borderRadius: diagnosticRoundedCarplayClip ? 36 : 0,
                  overflow: diagnosticRoundedCarplayClip ? 'hidden' : 'visible',
                }}
              >
                <div className="w-full h-full flex items-center justify-center" style={{ position: 'relative' }}>
                  <Nav receivingVideo={receivingVideo} settings={settings} />
                  {settings && (
                    <Carplay
                      receivingVideo={receivingVideo}
                      setReceivingVideo={setReceivingVideo}
                      settings={settings}
                      command={keyCommand as KeyCommand}
                      commandCounter={commandCounter}
                    />
                  )}
                  <Routes>
                    <Route path="/" element={<Home />} />
                    <Route path="/settings" element={<Settings settings={settings!} />} />
                    <Route path="/info" element={<Info />} />
                    <Route path="/camera" element={<Camera settings={settings!} />} />
                  </Routes>
                  <Modal open={reverse} onClick={() => setReverse(false)}>
                    <Box sx={style}>
                      <Camera settings={settings} />
                    </Box>
                  </Modal>
                  <HomeView />
                  {activeGraph && (
                    <MetricGraph
                      metricKey={activeGraph}
                      onClose={() => setActiveGraph(null)}
                    />
                  )}
                </div>
              </div>

            </>
          )}
        </div>
      </div>
  );
}

function App() {
  return (
    <Router>
      <AppContent />
    </Router>
  );
}

export default App;
