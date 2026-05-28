import { useState, useEffect } from 'react'
import Sidebar      from './components/Sidebar'
import TitleBar     from './components/TitleBar'
import SetupModal   from './components/SetupModal'
import UpdateModal  from './components/UpdateModal'
import Dashboard   from './pages/Dashboard'
import Accounts    from './pages/Accounts'
import FarmGroups  from './pages/FarmGroups'
import Drops       from './pages/Drops'
import Proxies     from './pages/Proxies'
import Settings    from './pages/Settings'
import AutomationWindow from './pages/AutomationWindow'
import TrackingWindow   from './pages/TrackingWindow'

const PAGES = {
  dashboard:  Dashboard,
  accounts:   Accounts,
  farm:       FarmGroups,
  drops:      Drops,
  proxies:    Proxies,
  settings:   Settings,
}

// Standalone-окна (hash-routing):
//   #/automation/<accountId> → AutomationWindow (имитация движения)
//   #/tracking/<groupId>     → TrackingWindow (трекинг фарм-группы)
function parseHashRoute() {
  const hash = window.location.hash || ''
  let m = hash.match(/^#\/automation\/(\d+)$/)
  if (m) return { type: 'automation', id: m[1] }
  m = hash.match(/^#\/tracking\/(\d+)$/)
  if (m) return { type: 'tracking', id: m[1] }
  return null
}

export default function App() {
  const route = parseHashRoute()
  if (route?.type === 'automation') return <AutomationWindow accountId={route.id} />
  if (route?.type === 'tracking')   return <TrackingWindow groupId={route.id} />
  return <MainApp />
}

function MainApp() {
  const [page, setPage]           = useState('dashboard')
  const [setupDone, setSetupDone] = useState(false)
  const [updateInfo, setUpdateInfo] = useState(null)
  const Page = PAGES[page] || Dashboard

  useEffect(() => {
    window.api.updater.onAvailable(info => setUpdateInfo(info))
  }, [])

  return (
    <div className="flex flex-col h-screen bg-bg-primary overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar active={page} onNavigate={setPage} />
        <main className="flex-1 overflow-y-auto p-6">
          <Page />
        </main>
      </div>
      {!setupDone && <SetupModal onDone={() => setSetupDone(true)} />}
      {updateInfo && <UpdateModal info={updateInfo} onDismiss={() => setUpdateInfo(null)} />}
    </div>
  )
}
