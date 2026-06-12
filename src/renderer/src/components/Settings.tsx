import type { ExtraConfig } from "../../../main/Globals"
import React, { useEffect, useMemo, useState } from "react"
import {
  Box,
  FormControlLabel,
  Radio,
  RadioGroup,
  TextField,
  Checkbox,
  FormLabel,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  Slide,
  Stack,
  Grid,
  Slider,
  CircularProgress,
  Typography,
  Divider,
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { TransitionProps } from '@mui/material/transitions'
import { KeyBindings } from "./KeyBindings"
import { useCarplayStore, useStatusStore } from "../store/store"
import { useDataLog } from "../store/dataLog"
import debounce from 'lodash.debounce'

interface SettingsProps {
  settings: ExtraConfig | null
}

const DEFAULT_AMBIENT_FILL_COLOR = '#142321'
const AMBIENT_FILL_SWATCHES = [
  '#142321',
  '#083f38',
  '#1f2f44',
  '#2f2438',
  '#382716',
  '#202020',
]

const Transition = React.forwardRef(function Transition(
  props: TransitionProps & { children: React.ReactElement },
  ref: React.Ref<unknown>,
) {
  return <Slide direction="up" ref={ref} {...props} />
})

const cap = (s: string) => (
  <Typography variant="caption" sx={{ fontSize: 11 }}>{s}</Typography>
)

const Rule = () => <Divider sx={{ opacity: 0.15, my: 0.75 }} />

const Settings: React.FC<SettingsProps> = ({ settings }) => {
  if (!settings) return null

  const [activeSettings, setActiveSettings] = useState<ExtraConfig>({
    ...settings,
    kiosk: true,
    nightMode: true,
    audioTransferMode: true,
    micType: 'os',
    microphone: '',
    audioVolume: settings.audioVolume ?? 1.0,
    navVolume: settings.navVolume ?? 1.0,
    ambientFillColor: settings.ambientFillColor ?? DEFAULT_AMBIENT_FILL_COLOR,
  })
  const [openBindings, setOpenBindings] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [resetMessage, setResetMessage] = useState("")
  const [closeCountdown, setCloseCountdown] = useState(0)
  const [hasChanges, setHasChanges] = useState(false)
  const [confirmClearLog, setConfirmClearLog] = useState(false)

  const saveSettings = useCarplayStore(s => s.saveSettings)
  const isDongleConnected = useStatusStore(s => s.isDongleConnected)
  const showDiagnostics = useStatusStore(s => s.showDiagnostics)
  const setShowDiagnostics = useStatusStore(s => s.setShowDiagnostics)
  const clearAllLog = useDataLog(s => s.clearAll)
  const theme = useTheme()

  const debouncedSave = useMemo(() => debounce((s: ExtraConfig) => saveSettings(s), 300), [saveSettings])
  useEffect(() => () => debouncedSave.cancel(), [debouncedSave])

  const requiresRestartParams: (keyof ExtraConfig)[] = [
    'width', 'height', 'fps', 'dpi', 'format', 'mediaDelay', 'phoneWorkMode', 'wifiType'
  ]

  const withFixedSettings = (s: ExtraConfig): ExtraConfig => ({
    ...s,
    kiosk: true,
    nightMode: true,
    audioTransferMode: true,
    micType: 'os',
    microphone: '',
  })

  const settingsChange = (key: keyof ExtraConfig, value: any) => {
    const updated = withFixedSettings({ ...activeSettings, [key]: value })
    if (key === 'backdropEnabled' && value === true) {
      updated.ambientFillEnabled = false
    } else if (key === 'ambientFillEnabled' && value === true) {
      updated.backdropEnabled = false
    }
    setActiveSettings(updated)
    if (['audioVolume', 'navVolume'].includes(key)) {
      debouncedSave(updated)
    } else if (['kiosk', 'nightMode'].includes(key)) {
      saveSettings(updated)
    } else if (requiresRestartParams.includes(key)) {
      setHasChanges(requiresRestartParams.some(p => updated[p] !== settings[p]))
    } else {
      saveSettings(updated)
    }
  }

  // Capture the current raw lean/pitch as the "level" zero offsets.
  const calibrateTilt = () => {
    const { leanAngle, pitchAngle } = useCarplayStore.getState()
    const lean  = leanAngle  ?? 0
    const pitch = pitchAngle ?? 0
    const updated = { ...activeSettings, leanOffset: lean, pitchOffset: pitch }
    setActiveSettings(updated)
    saveSettings(updated)
    setResetMessage(`Tilt zeroed — lean ${lean.toFixed(1)}°, pitch ${pitch.toFixed(1)}°`)
    setCloseCountdown(3)
  }

  const resetTilt = () => {
    const updated = { ...activeSettings, leanOffset: 0, pitchOffset: 0 }
    setActiveSettings(updated)
    saveSettings(updated)
    setResetMessage('Tilt calibration reset')
    setCloseCountdown(3)
  }

  const handleSave = async () => {
    setIsResetting(true)
    setCloseCountdown(3)
    let msg = ""
    try {
      setResetMessage("Saving...")
      const fixed = withFixedSettings(activeSettings)
      setActiveSettings(fixed)
      await saveSettings(fixed)
      if (isDongleConnected) {
        setResetMessage("Resetting...")
        const ok = await window.carplay.usb.forceReset()
        msg = ok ? "Saved" : "Saved, reset failed"
      } else { msg = "Saved" }
      setHasChanges(false)
    } catch (err) {
      console.error('[Settings] Save failed', err)
      msg = "Error"
    } finally {
      setIsResetting(false)
      setResetMessage(msg)
    }
  }

  useEffect(() => {
    if (!resetMessage) return
    const t = setInterval(() => {
      setCloseCountdown(prev => {
        if (prev <= 1) { clearInterval(t); setResetMessage(""); return 0 }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [resetMessage])

  const numField = (label: string, key: keyof ExtraConfig, min?: number) => (
    <Grid size={{ xs: 3 }} key={String(key)}>
      <TextField
        label={label} type="number" fullWidth size="small"
        inputProps={{ ...(min != null && { min }) }}
        value={activeSettings[key] as number | string}
        onChange={e => settingsChange(key, Number(e.target.value))}
        sx={{ '& .MuiInputLabel-root': { fontSize: 10, letterSpacing: 0.5 } }}
      />
    </Grid>
  )

  return (
    <Box
      className={theme.palette.mode === 'dark' ? 'App-header-dark' : 'App-header-light'}
      p={1.5} display="flex" flexDirection="column" height="100%"
      sx={{ boxSizing: 'border-box' }}
    >
      <Box sx={{ overflowY: 'auto', flex: '0 1 auto', minHeight: 0 }}>

        {/* ── VIDEO ── */}
        <Grid container spacing={1} sx={{ pt: 1 }}>
          {numField('WIDTH',      'width')}
          {numField('HEIGHT',     'height')}
          {numField('FPS',        'fps', 10)}
          {numField('DPI',        'dpi')}
          {numField('FORMAT',     'format')}
          {numField('IBOX VER',   'iBoxVersion')}
          {numField('DELAY ms',   'mediaDelay')}
          {numField('PHONE MODE', 'phoneWorkMode')}
        </Grid>

        <Rule />

        {/* ── AUDIO — two sliders side by side ── */}
        <Grid container spacing={2} sx={{ px: 0.5 }}>
          <Grid size={{ xs: 6 }}>
            <FormLabel sx={{ fontSize: 10, letterSpacing: 1 }}>AUDIO VOL</FormLabel>
            <Slider size="small"
              value={Math.round((activeSettings.audioVolume ?? 1) * 100)}
              min={0} max={100} step={5} valueLabelDisplay="auto"
              onChange={(_, v) => typeof v === 'number' && settingsChange('audioVolume', v / 100)}
            />
          </Grid>
          <Grid size={{ xs: 6 }}>
            <FormLabel sx={{ fontSize: 10, letterSpacing: 1 }}>NAV VOL</FormLabel>
            <Slider size="small"
              value={Math.round((activeSettings.navVolume ?? 1) * 100)}
              min={0} max={100} step={5} valueLabelDisplay="auto"
              onChange={(_, v) => typeof v === 'number' && settingsChange('navVolume', v / 100)}
            />
          </Grid>
        </Grid>

        <Rule />

        {/* ── TOGGLES — all horizontal ── */}
        <Stack direction="row" flexWrap="wrap" sx={{ mx: -0.5 }}>
          {[
            { label: 'BACKDROP',    key: 'backdropEnabled',    val: activeSettings.backdropEnabled === true },
            { label: 'AMBIENT FILL', key: 'ambientFillEnabled', val: activeSettings.ambientFillEnabled === true },
            { label: 'ROUND CORNERS', key: 'diagnosticRoundedCarplayClip', val: activeSettings.diagnosticRoundedCarplayClip === true },
            { label: 'SAMPLE DATA', key: null,                 val: showDiagnostics },
          ].map(({ label, key, val }) => (
            <FormControlLabel key={label}
              sx={{ mx: 0.5, my: 0 }}
              control={
                <Checkbox size="small" checked={!!val} onChange={e => {
                  if (key) settingsChange(key as keyof ExtraConfig, e.target.checked)
                  else setShowDiagnostics(e.target.checked)
                }} />
              }
              label={cap(label)}
            />
          ))}
        </Stack>

        <Box sx={{ px: 0.5, mt: 0.25 }}>
          <FormLabel sx={{ fontSize: 10, letterSpacing: 1 }}>FILL COLOR</FormLabel>
          <Stack direction="row" gap={0.75} sx={{ mt: 0.5 }}>
            {AMBIENT_FILL_SWATCHES.map(color => (
              <Button
                key={color}
                size="small"
                variant="outlined"
                onClick={() => settingsChange('ambientFillColor', color)}
                sx={{
                  width: 28,
                  minWidth: 28,
                  height: 28,
                  p: 0,
                  backgroundColor: color,
                  borderColor:
                    (activeSettings.ambientFillColor ?? DEFAULT_AMBIENT_FILL_COLOR).toLowerCase() === color
                      ? 'rgba(255,255,255,0.9)'
                      : 'rgba(255,255,255,0.22)',
                  '&:hover': { backgroundColor: color, borderColor: 'rgba(255,255,255,0.9)' },
                }}
              />
            ))}
          </Stack>
        </Box>

        <Rule />

        {/* ── CONNECTIVITY ── */}
        <Grid container spacing={1} sx={{ px: 0.5 }}>
          <Grid size={{ xs: 12 }}>
            <FormLabel sx={{ fontSize: 10, letterSpacing: 1 }}>WIFI</FormLabel>
            <RadioGroup row value={activeSettings.wifiType}
              onChange={e => settingsChange('wifiType', e.target.value)}>
              <FormControlLabel value="2.4ghz" control={<Radio size="small" />} label={cap('2.4G')} />
              <FormControlLabel value="5ghz"   control={<Radio size="small" />} label={cap('5G')} />
            </RadioGroup>
          </Grid>
        </Grid>

        <Rule />

        {/* ── TILT CALIBRATION ── */}
        <FormLabel sx={{ fontSize: 10, letterSpacing: 1 }}>TILT CALIBRATION</FormLabel>
        <Stack direction="row" gap={1} alignItems="center" sx={{ mt: 0.5 }}>
          <Button size="small" variant="outlined" onClick={calibrateTilt}>SET LEVEL</Button>
          <Button size="small" variant="outlined" color="warning" onClick={resetTilt}>RESET</Button>
          <Typography variant="caption" sx={{ fontSize: 10, color: 'text.secondary', ml: 0.5 }}>
            offset&nbsp; lean {(activeSettings.leanOffset ?? 0).toFixed(1)}°&nbsp;·&nbsp;pitch {(activeSettings.pitchOffset ?? 0).toFixed(1)}°
          </Typography>
        </Stack>
        <Typography sx={{ fontSize: 9, opacity: 0.55, mt: 0.25 }}>
          Hold the bike upright &amp; level, then tap SET LEVEL to zero the lean/pitch readout.
        </Typography>

      </Box>

      {/* ── BUTTONS ── */}
      <Stack direction="row" justifyContent="center" gap={1.5} pt={1}>
        <Button size="small" variant="contained"
          color={hasChanges ? 'primary' : 'inherit'}
          disabled={!hasChanges || isResetting}
          onClick={hasChanges ? handleSave : undefined}>
          {isResetting ? <CircularProgress size={16} /> : 'SAVE'}
        </Button>
        <Button size="small" variant="outlined" onClick={() => setOpenBindings(true)}>
          BINDINGS
        </Button>
        <Button size="small" variant="outlined" color="error"
          onClick={() => setConfirmClearLog(true)}>
          CLEAR LOG
        </Button>
      </Stack>

      <Dialog open={!!resetMessage} onClose={() => { setResetMessage(""); setCloseCountdown(0) }}>
        <DialogTitle>Status</DialogTitle>
        <DialogContent sx={{ textAlign: 'center' }}>
          <Typography sx={{ mb: 2 }}>{resetMessage}</Typography>
          <Button variant="outlined" onClick={() => { setResetMessage(""); setCloseCountdown(0) }}>
            Close{closeCountdown > 0 ? ` (${closeCountdown})` : ''}
          </Button>
        </DialogContent>
      </Dialog>

      <Dialog open={openBindings} TransitionComponent={Transition} keepMounted
        PaperProps={{ sx: { minHeight: '50%', minWidth: '50%' } }}
        onClose={() => setOpenBindings(false)}>
        <DialogTitle>Key Bindings</DialogTitle>
        <DialogContent><KeyBindings settings={activeSettings} updateKey={settingsChange} /></DialogContent>
      </Dialog>

      <Dialog open={confirmClearLog} onClose={() => setConfirmClearLog(false)}>
        <DialogTitle>Clear All Log Data?</DialogTitle>
        <DialogContent sx={{ textAlign: 'center' }}>
          <Typography sx={{ mb: 2 }}>This will erase all recorded sensor history.</Typography>
          <Stack direction="row" justifyContent="center" gap={2}>
            <Button variant="outlined" onClick={() => setConfirmClearLog(false)}>Cancel</Button>
            <Button variant="contained" color="error" onClick={() => { clearAllLog(); setConfirmClearLog(false) }}>
              Clear All
            </Button>
          </Stack>
        </DialogContent>
      </Dialog>
    </Box>
  )
}

export default Settings
