import React from 'react'
import Tabs from '@mui/material/Tabs'
import Tab from '@mui/material/Tab'
import TuneIcon from '@mui/icons-material/Tune'

// BMW Airhead boxer — two horizontal cylinders are the signature
function AirheadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" style={{ display: 'block' }}>
      {/* Rear wheel */}
      <circle cx="5.5" cy="18.5" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
      {/* Front wheel */}
      <circle cx="18.5" cy="18.5" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
      {/* Left boxer cylinder — the airhead "ear" */}
      <rect x="1.5" y="13.2" width="5.5" height="2.2" rx="0.9" fill="currentColor" />
      {/* Engine centre block */}
      <rect x="7" y="12.2" width="10" height="3.8" rx="0.5" fill="currentColor" />
      {/* Right boxer cylinder */}
      <rect x="17" y="13.2" width="5.5" height="2.2" rx="0.9" fill="currentColor" />
      {/* Frame */}
      <polyline points="5.5,15.7 8.5,12 15.5,12 18.5,15.7"
        fill="none" stroke="currentColor" strokeWidth="1.4"
        strokeLinecap="round" strokeLinejoin="round" />
      {/* Seat arc */}
      <path d="M9 12 Q12 9.5 15.5 12"
        fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      {/* Handlebar */}
      <line x1="16" y1="10.5" x2="20.5" y2="9.5"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
import HelpCenterIcon from '@mui/icons-material/HelpCenter'
import CameraIcon from '@mui/icons-material/Camera'
import CloseIcon from '@mui/icons-material/Close'
import { Link, useLocation } from 'react-router-dom'
import { useStatusStore } from '../store/store'
import { useTheme } from '@mui/material/styles'
import { ExtraConfig } from '../../../main/Globals'

interface NavProps {
  settings: ExtraConfig | null
  receivingVideo: boolean
}

export default function Nav({ receivingVideo }: NavProps) {
  const theme = useTheme()
  const { pathname } = useLocation()

  const isDongleConnected = useStatusStore(s => s.isDongleConnected)
  const isStreaming       = useStatusStore(s => s.isStreaming)
  const cameraFound       = useStatusStore(s => s.cameraFound)

  if (isStreaming && pathname === '/') {
    return null
  }

  const routeToIndex: Record<string, number> = {
    '/':         0,
    '/settings': 1,
    '/info':     2,
    '/camera':   3,
  }
  const value = routeToIndex[pathname] ?? 0

  let icon: React.ReactNode
  let color: string

  if (!isDongleConnected) {
    icon  = <AirheadIcon />
    color = theme.palette.text.disabled
  } else if (!isStreaming) {
    icon  = <AirheadIcon />
    color = theme.palette.text.primary
  } else if (receivingVideo) {
    icon  = <AirheadIcon />
    color = theme.palette.success.main
  } else {
    icon  = <AirheadIcon />
    color = theme.palette.text.primary
  }

  const quit = () => {
    window.carplay.quit().catch(err => console.error('Quit failed:', err))
  }

  return (
    <Tabs
      value={value}
      aria-label="Navigation Tabs"
      variant="fullWidth"
      textColor="inherit"
      indicatorColor="secondary"
    >
      <Tab
        icon={icon}
        component={Link}
        to="/"
        sx={{ '& svg': { color } }}
      />
      <Tab icon={<TuneIcon />}       component={Link} to="/settings" />
      <Tab icon={<HelpCenterIcon />} component={Link} to="/info" />
      <Tab
        icon={<CameraIcon />}
        component={Link}
        to="/camera"
        disabled={!cameraFound}
        sx={{
          '& svg': {
            color: cameraFound
              ? theme.palette.common.white
              : theme.palette.text.disabled
          }
        }}
      />
      <Tab icon={<CloseIcon />} onClick={quit} />
    </Tabs>
  )
}
