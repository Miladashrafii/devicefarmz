import { useEffect, useState, type FormEvent } from 'react'
import type { User } from '@devicefarmz/core'
import { api } from '../lib/api'
import { useAuth } from '../state/auth'
import { Navigate } from 'react-router-dom'

export function UsersPage() {
  const { user } = useAuth()
  const [users, setUsers] = useState<User[]>([])
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')

  if (user?.role !== 'admin') return <Navigate to="/" replace />

  async function load() {
    const r = await api.users()
    setUsers(r.users)
  }

  useEffect(() => {
    void load().catch((e) => setError(String(e)))
  }, [])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    try {
      await api.createUser({ name, email })
      setName('')
      setEmail('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div>
      <h2 style={{ fontFamily: 'var(--display)', marginTop: 0 }}>Users</h2>
      <form className="toolbar" onSubmit={onCreate}>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <input
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <button className="btn small">Add user</button>
      </form>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Quota</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>{u.role}</td>
              <td>{u.groupQuota}</td>
              <td>
                {u.id !== user?.id && (
                  <button
                    className="btn danger small"
                    onClick={() => void api.deleteUser(u.id).then(load)}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
