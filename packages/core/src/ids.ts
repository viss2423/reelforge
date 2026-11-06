/** Short, URL-safe, collision-resistant ids (122 bits of randomness, base36-ish). */
export const newId = (prefix = ''): string => {
  const raw = crypto.randomUUID().replaceAll('-', '')
  return `${prefix}${BigInt(`0x${raw}`).toString(36)}`
}
