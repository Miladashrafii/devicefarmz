import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './state/auth'
import { LoginPage } from './pages/LoginPage'
import { DevicesPage } from './pages/DevicesPage'
import { ControlPage } from './pages/ControlPage'
import { GroupsPage } from './pages/GroupsPage'
import { UsersPage } from './pages/UsersPage'
import { SessionsPage } from './pages/SessionsPage'
import { SettingsPage } from './pages/SettingsPage'

function Shell({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth()
  return (
    <div className="app-shell">
      <header className="topbar">
        <NavLink to="/" className="brand">
          Device<span>Farmz</span>
        </NavLink>
        <nav className="nav">
          <NavLink to="/" end>
            Devices
          </NavLink>
          <NavLink to="/groups">Groups</NavLink>
          <NavLink to="/sessions">Sessions</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          {user?.role === 'admin' && <NavLink to="/users">Users</NavLink>}
        </nav>
        <div className="user-chip">
          {user?.name} · {user?.email}
        </div>
        <button className="btn ghost small" onClick={logout}>
          Logout
        </button>
      </header>
      <main className="main">{children}</main>
    </div>
  )
}

function Private({ children }: { children: React.ReactNode }) {
  const { token } = useAuth()
  if (!token) return <Navigate to="/login" replace />
  return <Shell>{children}</Shell>
}

export function App() {
  const { token } = useAuth()
  return (
    <Routes>
      <Route path="/login" element={token ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route
        path="/"
        element={
          <Private>
            <DevicesPage />
          </Private>
        }
      />
      <Route
        path="/device/:serial"
        element={
          <Private>
            <ControlPage />
          </Private>
        }
      />
      <Route
        path="/groups"
        element={
          <Private>
            <GroupsPage />
          </Private>
        }
      />
      <Route
        path="/users"
        element={
          <Private>
            <UsersPage />
          </Private>
        }
      />
      <Route
        path="/sessions"
        element={
          <Private>
            <SessionsPage />
          </Private>
        }
      />
      <Route
        path="/settings"
        element={
          <Private>
            <SettingsPage />
          </Private>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
