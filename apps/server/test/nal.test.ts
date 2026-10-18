import assert from 'node:assert/strict'
import test from 'node:test'
import { NalSplitter } from '../src/scrcpy.js'

const sc3 = [0, 0, 1]
const sc4 = [0, 0, 0, 1]

test('splits Annex-B streams into NAL units regardless of chunking', () => {
  const stream = Buffer.from([
    ...sc4, 0x67, 1, 2, 3, // SPS
    ...sc4, 0x68, 4, 5, // PPS
    ...sc3, 0x65, 9, 9, 9, 9, // IDR with a 3-byte start code
    ...sc4, 0x41, 7, 7, // P-frame (left pending until the next start code)
    ...sc4, 0x41, 8,
  ])

  for (const chunkSize of [1, 2, 3, 5, 100]) {
    const splitter = new NalSplitter()
    const out: Buffer[] = []
    for (let i = 0; i < stream.length; i += chunkSize) out.push(...splitter.push(stream.subarray(i, i + chunkSize)))
    const types = out.map((n) => n[4] & 0x1f)
    assert.deepEqual(types, [7, 8, 5, 1], `chunkSize=${chunkSize}`)
    for (const nal of out) assert.deepEqual([...nal.subarray(0, 4)], sc4)
    assert.deepEqual([...out[2].subarray(4)], [0x65, 9, 9, 9, 9])
  }
})

test('does not emit a NAL until the next start code arrives', () => {
  const splitter = new NalSplitter()
  assert.deepEqual(splitter.push(Buffer.from([...sc4, 0x65, 1, 2])), [])
  const out = splitter.push(Buffer.from([...sc4, 0x41, 3]))
  assert.equal(out.length, 1)
  assert.deepEqual([...out[0].subarray(4)], [0x65, 1, 2])
})
