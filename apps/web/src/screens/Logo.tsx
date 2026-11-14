import { useId } from 'react'

/** The ReelForge mark (same geometry as public/icons/icon.svg), inline so it never flashes. */
export function Logo({ className }: { className?: string }) {
  const id = useId()
  return (
    <svg viewBox="0 0 512 512" aria-hidden className={className}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#ff2d7a" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill={`url(#${id})`} />
      <rect
        x="157"
        y="80"
        width="198"
        height="352"
        rx="46"
        fill="none"
        stroke="#fff"
        strokeWidth="30"
      />
      <path d="M228 198L228 314L322 256Z" fill="#fff" />
    </svg>
  )
}
