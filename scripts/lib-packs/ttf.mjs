/**
 * Just enough of the OpenType/TrueType format to read what libass matches on:
 * name ID 1 (legacy family), name ID 4 (full name), OS/2.usWeightClass and the italic bit.
 */

/** Decode a name-table string (Windows/Unicode = UTF-16BE, Macintosh Roman ≈ latin1). */
function decodeName(buf, platformId) {
  if (platformId === 3 || platformId === 0) {
    let s = ''
    for (let i = 0; i + 1 < buf.length; i += 2) s += String.fromCharCode(buf.readUInt16BE(i))
    return s
  }
  return buf.toString('latin1')
}

/**
 * @param {Buffer} buf font file bytes
 * @returns {{ family: string, fullName: string, postscriptName: string, weight: number, italic: boolean, variable: boolean }}
 */
export function readFontInfo(buf) {
  const tag = buf.readUInt32BE(0)
  if (tag !== 0x00010000 && tag !== 0x4f54544f /* OTTO */ && tag !== 0x74727565 /* true */) {
    throw new Error('not a TrueType/OpenType font')
  }
  const numTables = buf.readUInt16BE(4)
  /** @type {Record<string, number>} */
  const tables = {}
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    tables[buf.toString('latin1', rec, rec + 4)] = buf.readUInt32BE(rec + 8)
  }
  const nameOff = tables.name
  const os2Off = tables['OS/2']
  if (nameOff === undefined || os2Off === undefined) throw new Error('font lacks name or OS/2')

  const count = buf.readUInt16BE(nameOff + 2)
  const strings = nameOff + buf.readUInt16BE(nameOff + 4)
  /** best (Windows en-US preferred) string per name id */
  const names = new Map()
  for (let i = 0; i < count; i++) {
    const r = nameOff + 6 + i * 12
    const platformId = buf.readUInt16BE(r)
    const languageId = buf.readUInt16BE(r + 4)
    const nameId = buf.readUInt16BE(r + 6)
    const len = buf.readUInt16BE(r + 8)
    const off = strings + buf.readUInt16BE(r + 10)
    const rank = platformId === 3 && languageId === 0x409 ? 2 : platformId === 3 ? 1 : 0
    const prev = names.get(nameId)
    if (!prev || rank > prev.rank)
      names.set(nameId, { rank, value: decodeName(buf.subarray(off, off + len), platformId) })
  }
  return {
    family: names.get(1)?.value ?? '',
    fullName: names.get(4)?.value ?? '',
    postscriptName: names.get(6)?.value ?? '',
    weight: buf.readUInt16BE(os2Off + 4),
    italic: (buf.readUInt16BE(os2Off + 62) & 1) === 1,
    variable: tables.fvar !== undefined,
  }
}
