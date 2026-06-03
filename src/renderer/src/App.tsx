import { useEffect, useState } from "react";
import { HashRouter as Router, Route, Routes } from "react-router-dom";
import Settings from "./components/Settings";
import Info from "./components/Info";
import Home from "./components/Home";
import Nav from "./components/Nav";
import Carplay from './components/Carplay';
import Camera from './components/Camera';
import SpeedDisplay from './components/SpeedDisplay';
import LeanAngle from './components/LeanAngle';
import CHTGauge from './components/CHTGauge';
import DevPanel from './components/DevPanel';
import { Box, Modal } from '@mui/material';
import { useCarplayStore, useStatusStore } from "./store/store";
import type { KeyCommand } from "./components/worker/types";
import { updateCameras } from "./utils/cameraDetection";

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

function App() {
  const [receivingVideo, setReceivingVideo] = useState(false);
  const [commandCounter, setCommandCounter] = useState(0);
  const [keyCommand, setKeyCommand] = useState('');

  const reverse = useStatusStore(state => state.reverse);
  const setReverse = useStatusStore(state => state.setReverse);

  const settings = useCarplayStore(state => state.settings);
  const saveSettings = useCarplayStore(state => state.saveSettings);
  const setCameraFound = useStatusStore(state => state.setCameraFound);

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

  useEffect(() => {
    if (!settings) return;

    updateCameras(setCameraFound, saveSettings, settings);

    const usbHandler = (_: any, data: { type: string }) => {
      if (['attach', 'plugged', 'detach', 'unplugged'].includes(data.type)) {
        updateCameras(setCameraFound, saveSettings, settings);
      }
    };

    window.carplay.usb.listenForEvents(usbHandler);
    return () => window.carplay.usb.unlistenForEvents?.(usbHandler);
  }, [settings]);

  // 565/800 = 70.625% — the largest square inscribed in the 800px circle
  const SQUARE = '70.625%'
  // 117/800 = 14.625% — the arc height/width outside the square
  const ARC = '14.625%'

  return (
    <Router>
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
            backgroundColor: 'black',
          }}
        >
          {/* Top arc — GPS Speed */}
          <div style={{
            position: 'absolute',
            top: 0,
            left: '50%',
            transform: 'translateX(-50%)',
            width: SQUARE,
            height: ARC,
            zIndex: 10,
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
          }}>
            <LeanAngle />
          </div>

          {/* Left arc — CHT Left cylinder (nudged 1px toward center) */}
          <div style={{
            position: 'absolute',
            left: 1,
            top: '50%',
            transform: 'translateY(-50%)',
            width: ARC,
            height: SQUARE,
            zIndex: 10,
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
              backgroundColor: 'black',
              zIndex: 5,
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
            </div>
          </div>
        </div>
      </div>
    </Router>
  );
}

export default App;
