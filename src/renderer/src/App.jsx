import { useState } from 'react'
import Sidebar from './components/Sidebar'
import TitleBar from './components/TitleBar'
import Dashboard from './pages/Dashboard'
import Accounts from './pages/Accounts'
import FarmGroups from './pages/FarmGroups'
import Drops from './pages/Drops'
import Proxies from './pages/Proxies'
import Settings from './pages/Settings'

const PAGES = {
  dashboard:  Dashboard,
  accounts:   Accounts,
  farm:       FarmGroups,
  drops:      Drops,
  proxies:    Proxies,
  settings:   Settings,
}

export default function App() {
  const [page, setPage] = useState('dashboard')
  const Page = PAGES[page] || Dashboard

  return (
    <div className="flex flex-col h-screen bg-bg-primary overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar active={page} onNavigate={setPage} />
        <main className="flex-1 overflow-y-auto p-6">
          <Page />
        </main>
      </div>
    </div>
  )
}
