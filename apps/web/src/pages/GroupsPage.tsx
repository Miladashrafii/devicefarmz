import { useEffect, useState, type FormEvent } from 'react'
import type { Group } from '@devicefarmz/core'
import { api } from '../lib/api'

export function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([])
  const [name, setName] = useState('')
  const [klass, setKlass] = useState<'bookable' | 'standard' | 'once'>('bookable')
  const [error, setError] = useState('')

  async function load() {
    const r = await api.groups()
    setGroups(r.groups)
  }

  useEffect(() => {
    void load().catch((e) => setError(String(e)))
  }, [])

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setError('')
    try {
      const start = new Date()
      const stop = new Date(start.getTime() + 2 * 60 * 60 * 1000)
      await api.createGroup({
        name,
        class: klass,
        startTime: start.toISOString(),
        stopTime: stop.toISOString(),
        deviceSerials: [],
        userEmails: [],
      })
      setName('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div>
      <h2 style={{ fontFamily: 'var(--display)', marginTop: 0 }}>Booking & partitions</h2>
      <p className="meta" style={{ marginBottom: '1rem' }}>
        Groups associate devices, users, and a time window — for partitions (standard) or bookings
        (bookable / once).
      </p>

      <form className="toolbar" onSubmit={onCreate}>
        <input
          placeholder="Group name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          style={{ minWidth: 200 }}
        />
        <select value={klass} onChange={(e) => setKlass(e.target.value as typeof klass)}>
          <option value="bookable">Bookable</option>
          <option value="once">Once</option>
          <option value="standard">Standard partition</option>
        </select>
        <button className="btn small">Create</button>
      </form>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Class</th>
            <th>State</th>
            <th>Owner</th>
            <th>Devices</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.id}>
              <td>{g.name}</td>
              <td>{g.class}</td>
              <td>{g.state}</td>
              <td>{g.ownerEmail}</td>
              <td>{g.deviceSerials.length}</td>
              <td>
                <button
                  className="btn danger small"
                  onClick={() => void api.deleteGroup(g.id).then(load).catch((e) => setError(String(e)))}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
