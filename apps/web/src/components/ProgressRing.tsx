import { cn } from '@/lib/cn.ts'

export interface ProgressRingProps {
  /** 0..1; undefined renders an indeterminate (spinning) ring. */
  value: number | undefined
  size?: number
  stroke?: number
  label: string
  /** Show the percentage in the centre (sizes ≥ 36 px). */
  showLabel?: boolean
  className?: string
}

/** Circular progress (uploads, proxies, exports). Animates stroke-dashoffset only. */
export function ProgressRing({
  value,
  size = 40,
  stroke = 4,
  label,
  showLabel = false,
  className,
}: ProgressRingProps) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const v = value === undefined ? undefined : Math.min(1, Math.max(0, value))
  const pct = v === undefined ? undefined : Math.round(v * 100)
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={cn('relative inline-grid shrink-0 place-items-center', className)}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className={cn('-rotate-90', v === undefined && 'animate-spin')}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.2}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={v === undefined ? c * 0.7 : c * (1 - v)}
          className="transition-[stroke-dashoffset] duration-300"
        />
      </svg>
      {showLabel && pct !== undefined && size >= 36 && (
        <span className="absolute text-[10px] font-semibold tabular-nums">{pct}%</span>
      )}
    </span>
  )
}
