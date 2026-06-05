import { DongleConfig } from '@carplay/messages'

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
