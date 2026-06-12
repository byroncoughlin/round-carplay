import type { DongleConfig } from '@carplay/messages'

export type ExtraConfig = DongleConfig & {
  kiosk: boolean,
  camera: string,
  microphone: string,
  bindings: KeyBindings,
  audioVolume: number;
  navVolume: number;
  // IMU tilt calibration — raw lean/pitch captured while the bike is held
  // level; subtracted from live readings so a non-level mount reads zero.
  leanOffset: number;
  pitchOffset: number;
  // Blurred ambient backdrop behind the gauges. Explicit opt-in: true = on,
  // false/undefined = off (frees the CSS filter + worker frame tap).
  backdropEnabled?: boolean;
  // Static low-cost color fill behind the gauges. Separate from the blurred
  // live backdrop: no canvas, frame taps, filters, or animation.
  ambientFillEnabled?: boolean;
  ambientFillColor?: string;
  // Diagnostic mode: render only the CarPlay surface on black, with overlays,
  // graphs, nav, and backdrop disabled. This is intentionally hidden from the
  // settings UI and toggled from config.json for quick isolation tests.
  diagnosticPlainCarplay?: boolean;
  // Rounded/clipped center CarPlay square. Exposed as a toggle because this
  // hides CarPlay's black square corners, but it can be compositor-sensitive on
  // the Pi and should remain easy to disable.
  diagnosticRoundedCarplayClip?: boolean;
  // Diagnostic mode: prefer WebCodecs hardware H.264 decode on Linux for an
  // app-start A/B test. Default off because software decode has been stable.
  diagnosticHardwareDecode?: boolean;
  // Keep an active touch stream captured by the CarPlay surface even if the
  // pointer slides over a masked/edge pixel. This avoids fake pointerout->up
  // events during real drags on the round display.
  pointerCaptureTouch?: boolean;
  // Diagnostic mode: enable pointer capture for CarPlay touch handling.
  diagnosticPointerCaptureTouch?: boolean;
  // Diagnostic mode: send explicit `frame` commands after touch events.
  // Default off; tests showed command pumping does not improve touch latency.
  diagnosticTouchFrameKick?: boolean;
}

export interface KeyBindings {
  'selectUp': string,
  'selectDown': string,
  'up': string,
  'left': string,
  'right': string,
  'down': string,
  'back': string,
  'home': string,
  'play': string,
  'pause': string,
  'next': string,
  'prev': string
}

export interface CanMessage {
  canId: number,
  byte: number,
  mask: number
}

export interface CanConfig {
  reverse?: CanMessage,
  lights?: CanMessage
}
