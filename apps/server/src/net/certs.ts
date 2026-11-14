/**
 * Local certificate authority + server certificate, so phones can use the PWA over HTTPS
 * (service workers, installability, camera/clipboard APIs all need a secure context).
 *
 * - CA: ECDSA P-256, 10 years, "ReelForge Local CA (<hostname>)". Installed once per phone
 *   from the pairing page (/ca.crt). Its key never leaves `<data>/certs`.
 * - Leaf: ECDSA P-256, 397 days (Apple's limit for TLS server certs), EKU serverAuth, SANs for
 *   localhost, loopback IPs, the host name (+ .local), every LAN IPv4 and the Tailscale
 *   MagicDNS name / 100.x addresses. When interfaces change (new Wi-Fi, DHCP lease) a new leaf
 *   is issued and hot-swapped into the running server — no restart, no new CA install.
 *
 * ECDSA P-256 because key generation is ~1 ms (RSA-2048 is ~100 ms+) and handshakes are cheaper.
 */
import 'reflect-metadata'
import * as x509 from '@peculiar/x509'
import { createPrivateKey, X509Certificate as NodeX509, randomBytes, webcrypto } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import path from 'node:path'
import type { Logger } from '../contracts.ts'

x509.cryptoProvider.set(webcrypto)

const ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const
const DAY = 86_400_000
export const CA_VALIDITY_DAYS = 3650
export const LEAF_VALIDITY_DAYS = 397
/** Re-issue the leaf when it expires within this window. */
const RENEW_BEFORE_MS = 30 * DAY

export interface SanSet {
  dns: string[]
  ips: string[]
}

export interface TlsMaterial {
  /** Leaf private key (PKCS#8 PEM). */
  key: string
  /** Leaf certificate followed by the CA certificate (PEM chain). */
  cert: string
  /** CA certificate (PEM). */
  ca: string
  /** CA certificate (DER) for /ca.crt. */
  caDer: Buffer
  notAfter: Date
  sans: SanSet
}

interface CaMaterial {
  cert: x509.X509Certificate
  pem: string
  key: CryptoKey
  publicKey: CryptoKey
  /** SHA-256 fingerprint; ties a leaf to the CA that issued it. */
  fingerprint: string
}

const pemFromDer = (label: string, der: ArrayBuffer): string => {
  const b64 = Buffer.from(der).toString('base64')
  return `-----BEGIN ${label}-----\n${b64.replace(/.{1,64}/g, '$&\n')}-----END ${label}-----\n`
}

/** PEM with a trailing newline so certificates can be concatenated into a chain. */
const certPem = (cert: x509.X509Certificate): string => `${cert.toString('pem').trimEnd()}\n`

const serial = (): string => {
  const bytes = randomBytes(16)
  bytes[0] = bytes[0]! & 0x7f // positive INTEGER
  return bytes.toString('hex')
}

const generateKeys = (): Promise<webcrypto.CryptoKeyPair> =>
  webcrypto.subtle.generateKey(ALG, true, ['sign', 'verify'])

const exportKeyPem = async (key: CryptoKey): Promise<string> =>
  pemFromDer('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', key))

/** Normalises and de-duplicates SANs (DNS lower-cased, sorted) so sets compare stably. */
export const normalizeSans = (sans: SanSet): SanSet => ({
  dns: [...new Set(sans.dns.map((d) => d.toLowerCase().replace(/\.$/, '')))]
    .filter((d) => /^[a-z0-9*]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(d))
    .toSorted(),
  ips: [...new Set(sans.ips)].filter((ip) => isIP(ip) !== 0).toSorted(),
})

/** True when every name in `wanted` is covered by `have`. */
export const coversSans = (have: SanSet, wanted: SanSet): boolean => {
  const dns = new Set(have.dns)
  const ips = new Set(have.ips)
  return wanted.dns.every((d) => dns.has(d)) && wanted.ips.every((ip) => ips.has(ip))
}

/** SANs for this host: loopback, host name (+ .local), LAN/Tailscale IPs and MagicDNS name. */
export const hostSans = (opts: { hostname: string; ips: string[]; extraDns?: string[] }): SanSet =>
  normalizeSans({
    dns: [
      'localhost',
      opts.hostname,
      `${opts.hostname}.local`,
      'reelforge.local',
      ...(opts.extraDns ?? []),
    ],
    ips: ['127.0.0.1', '::1', ...opts.ips],
  })

/** Creates a new self-signed CA. */
export const createCa = async (hostname: string, now = new Date()): Promise<CaMaterial> => {
  const keys = await generateKeys()
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: [{ CN: [`ReelForge Local CA (${hostname})`] }, { O: ['ReelForge'] }],
    notBefore: new Date(now.getTime() - DAY),
    notAfter: new Date(now.getTime() + CA_VALIDITY_DAYS * DAY),
    signingAlgorithm: ALG,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  })
  const pem = certPem(cert)
  return {
    cert,
    pem,
    key: keys.privateKey,
    publicKey: keys.publicKey,
    fingerprint: new NodeX509(pem).fingerprint256,
  }
}

/** Issues a server certificate for `sans`, signed by `ca`. */
export const issueLeaf = async (
  ca: CaMaterial,
  sans: SanSet,
  now = new Date(),
): Promise<{ key: string; cert: string; notAfter: Date }> => {
  const keys = await generateKeys()
  const notAfter = new Date(now.getTime() + LEAF_VALIDITY_DAYS * DAY)
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: serial(),
    subject: [
      { CN: [sans.dns.find((d) => d !== 'localhost') ?? 'localhost'] },
      { O: ['ReelForge'] },
    ],
    issuer: ca.cert.subject,
    notBefore: new Date(now.getTime() - DAY),
    notAfter,
    signingAlgorithm: ALG,
    publicKey: keys.publicKey,
    signingKey: ca.key,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
      new x509.SubjectAlternativeNameExtension([
        ...sans.dns.map((value) => ({ type: 'dns' as const, value })),
        ...sans.ips.map((value) => ({ type: 'ip' as const, value })),
      ]),
      await x509.AuthorityKeyIdentifierExtension.create(ca.publicKey),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  })
  return { key: await exportKeyPem(keys.privateKey), cert: certPem(cert), notAfter }
}

const writeAtomic = async (file: string, data: string, mode = 0o644): Promise<void> => {
  await writeFile(`${file}.tmp`, data, { mode })
  await rename(`${file}.tmp`, file)
}

const readIfExists = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

export interface CertManagerOptions {
  dir: string
  hostname: string
  /** Current SANs wanted for the leaf (re-evaluated on every `refresh`). */
  sans: () => SanSet | Promise<SanSet>
  log?: Logger
  now?: () => Date
}

/**
 * Owns the CA + leaf on disk (`<data>/certs`): loads or creates them and re-issues the leaf
 * when the wanted SANs are not covered any more or it is about to expire.
 */
export class CertManager {
  readonly #opts: CertManagerOptions
  #ca: CaMaterial | undefined
  #tls: TlsMaterial | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #refreshing: Promise<boolean> | undefined

  constructor(opts: CertManagerOptions) {
    this.#opts = opts
  }

  #file(name: string): string {
    return path.join(this.#opts.dir, name)
  }

  #now(): Date {
    return this.#opts.now?.() ?? new Date()
  }

  /** Current TLS material (after `init`). */
  get tls(): TlsMaterial {
    if (!this.#tls) throw new Error('CertManager not initialised')
    return this.#tls
  }

  async #loadOrCreateCa(): Promise<CaMaterial> {
    const [pem, keyPem] = await Promise.all([
      readIfExists(this.#file('ca.crt')),
      readIfExists(this.#file('ca.key')),
    ])
    if (pem && keyPem) {
      const cert = new x509.X509Certificate(pem)
      if (cert.notAfter.getTime() - this.#now().getTime() > RENEW_BEFORE_MS) {
        const keyObject = createPrivateKey(keyPem)
        const key = keyObject.toCryptoKey(ALG, false, ['sign'])
        const publicKey = await cert.publicKey.export(ALG, ['verify'], webcrypto)
        return { cert, pem, key, publicKey, fingerprint: new NodeX509(pem).fingerprint256 }
      }
      this.#opts.log?.warn({ notAfter: cert.notAfter }, 'local CA expiring; creating a new one')
    }
    const ca = await createCa(this.#opts.hostname, this.#now())
    await mkdir(this.#opts.dir, { recursive: true })
    await writeAtomic(this.#file('ca.key'), await exportKeyPem(ca.key), 0o600)
    await writeAtomic(this.#file('ca.crt'), ca.pem)
    // Leaf of the previous CA is useless now.
    await writeAtomic(this.#file('server.json'), '{}')
    this.#opts.log?.info({ subject: ca.cert.subject }, 'created local certificate authority')
    return ca
  }

  /** Loads (or creates) CA and leaf. Returns the TLS material for the HTTPS server. */
  async init(): Promise<TlsMaterial> {
    await mkdir(this.#opts.dir, { recursive: true })
    this.#ca = await this.#loadOrCreateCa()
    const wanted = normalizeSans(await this.#opts.sans())
    const [key, cert, metaText] = await Promise.all([
      readIfExists(this.#file('server.key')),
      readIfExists(this.#file('server.crt')),
      readIfExists(this.#file('server.json')),
    ])
    if (key && cert && metaText) {
      const meta = JSON.parse(metaText) as { sans?: SanSet; notAfter?: string; ca?: string }
      const leaf = new NodeX509(cert)
      const valid =
        meta.sans !== undefined &&
        meta.ca === this.#ca.fingerprint &&
        new Date(leaf.validTo).getTime() - this.#now().getTime() > RENEW_BEFORE_MS &&
        coversSans(meta.sans, wanted)
      if (valid) {
        this.#tls = this.#material(key, cert, new Date(leaf.validTo), meta.sans!)
        return this.#tls
      }
    }
    await this.#issue(wanted)
    return this.tls
  }

  #material(key: string, cert: string, notAfter: Date, sans: SanSet): TlsMaterial {
    const ca = this.#ca!
    return {
      key,
      cert: cert + ca.pem,
      ca: ca.pem,
      caDer: Buffer.from(ca.cert.rawData),
      notAfter,
      sans,
    }
  }

  async #issue(sans: SanSet): Promise<void> {
    const ca = this.#ca!
    const leaf = await issueLeaf(ca, sans, this.#now())
    await writeAtomic(this.#file('server.key'), leaf.key, 0o600)
    await writeAtomic(this.#file('server.crt'), leaf.cert)
    await writeAtomic(
      this.#file('server.json'),
      JSON.stringify({ sans, notAfter: leaf.notAfter, ca: ca.fingerprint }),
    )
    this.#tls = this.#material(leaf.key, leaf.cert, leaf.notAfter, sans)
    this.#opts.log?.info({ sans }, 'issued server certificate')
  }

  /**
   * Re-issues the leaf if SANs changed or it expires soon. Returns true when a new leaf was
   * issued (the caller then hot-swaps it with `server.setSecureContext`).
   */
  refresh(): Promise<boolean> {
    this.#refreshing ??= (async () => {
      try {
        const wanted = normalizeSans(await this.#opts.sans())
        const tls = this.tls
        const expiring = tls.notAfter.getTime() - this.#now().getTime() < RENEW_BEFORE_MS
        if (!expiring && coversSans(tls.sans, wanted)) return false
        await this.#issue(wanted)
        return true
      } finally {
        this.#refreshing = undefined
      }
    })()
    return this.#refreshing
  }

  /** Polls for interface changes; `onChange` receives the new material. */
  watch(intervalMs: number, onChange: (tls: TlsMaterial) => void): void {
    this.stop()
    this.#timer = setInterval(() => {
      this.refresh().then(
        (changed) => {
          if (changed) onChange(this.tls)
        },
        (err: unknown) => this.#opts.log?.warn({ err }, 'certificate refresh failed'),
      )
    }, intervalMs)
    this.#timer.unref()
  }

  stop(): void {
    clearInterval(this.#timer)
    this.#timer = undefined
  }
}
