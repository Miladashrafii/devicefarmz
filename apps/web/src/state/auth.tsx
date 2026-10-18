import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { SessionInfo, User } from '@devicefarmz/core'
import { api, TOKEN_KEY } from '../lib/api'

interface AuthState {
  token: string | null
  user: User | null
  login: (name: string, email: string) => Promise<void>
  ldapLogin: (username: string, password: string) => Promise<void>
  /** Used by the SSO redirect: the hub hands the session token back in the URL fragment */
  loginWithToken: (token: string) => Promise<void>
  logout: () => void
}

const Ctx = createContext<AuthState | null>(null)
const USER_KEY = 'devicefarmz_user'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY))
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  })

  const accept = useCallback((session: SessionInfo) => {
    localStorage.setItem(TOKEN_KEY, session.token)
    localStorage.setItem(USER_KEY, JSON.stringify(session.user))
    setToken(session.token)
    setUser(session.user)
  }, [])

  const login = useCallback(async (name: string, email: string) => accept(await api.mockLogin(name, email)), [accept])
  const ldapLogin = useCallback(
    async (username: string, password: string) => accept(await api.ldapLogin(username, password)),
    [accept],
  )

  const loginWithToken = useCallback(
    async (t: string) => {
      localStorage.setItem(TOKEN_KEY, t)
      try {
        const me = await api.me()
        accept({ token: t, user: me, expiresAt: '' })
      } catch (err) {
        localStorage.removeItem(TOKEN_KEY)
        throw err
      }
    },
    [accept],
  )

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    setToken(null)
    setUser(null)
  }, [])

  const value = useMemo(
    () => ({ token, user, login, ldapLogin, loginWithToken, logout }),
    [token, user, login, ldapLogin, loginWithToken, logout],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('AuthProvider missing')
  return ctx
}
