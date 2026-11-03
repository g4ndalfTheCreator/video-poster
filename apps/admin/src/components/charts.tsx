import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Area,
  AreaChart,
} from 'recharts';
import { parseSpriteVtt, cueAt, type SpriteCue } from '@vs/shared/sprite';
import { fmtDuration, fmtNum, fmtPct } from '../lib/format';
import { cn } from './ui';

const axisProps = { stroke: 'var(--muted-fg)', fontSize: 11, tickLine: false, axisLine: false } as const;

function TooltipBox({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs shadow-sm">{children}</div>
  );
}

/** Two-series daily trend (sessions, views): legend + direct end labels; crosshair tooltip. */
export function TrendChart({
  data,
  series,
}: {
  data: Record<string, number | string>[];
  series: { key: string; label: string; color: string }[];
}) {
  const last = data[data.length - 1];
  return (
    <div>
      <div className="mb-2 flex gap-4 text-xs text-muted-fg" aria-hidden>
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded" style={{ background: s.color }} />
            {s.label}
            {last && <span className="tabular-nums text-fg">{fmtNum(Number(last[s.key] ?? 0))}</span>}
          </span>
        ))}
      </div>
      <div className="h-56">
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis
              dataKey="date"
              {...axisProps}
              minTickGap={24}
              tickFormatter={(d: string) => d.slice(5).split('-').reverse().join('.')}
            />
            <YAxis {...axisProps} allowDecimals={false} width={44} />
            <Tooltip
              cursor={{ stroke: 'var(--muted-fg)', strokeDasharray: '3 3' }}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <TooltipBox>
                    <div className="mb-1 font-medium">{String(label)}</div>
                    {series.map((s) => (
                      <div key={s.key} className="flex items-center gap-2">
                        <span className="inline-block size-2 rounded-full" style={{ background: s.color }} />
                        <span className="text-muted-fg">{s.label}</span>
                        <span className="ml-auto pl-3 tabular-nums">
                          {fmtNum(Number(payload.find((p) => p.dataKey === s.key)?.value ?? 0))}
                        </span>
                      </div>
                    ))}
                  </TooltipBox>
                ) : null
              }
            />
            {series.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function useSpriteCues(vttUrl: string | null | undefined): SpriteCue[] {
  const [cues, setCues] = useState<SpriteCue[]>([]);
  useEffect(() => {
    if (!vttUrl) return;
    let cancelled = false;
    void fetch(vttUrl)
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => !cancelled && setCues(parseSpriteVtt(t, new URL(vttUrl, location.href).toString())));
    return () => {
      cancelled = true;
    };
  }, [vttUrl]);
  return cues;
}

function SpriteThumb({ cue, scale = 1 }: { cue: SpriteCue | undefined; scale?: number }) {
  if (!cue) return null;
  return (
    <div
      className="overflow-hidden rounded-sm"
      style={{
        width: cue.w,
        height: cue.h,
        backgroundImage: `url("${cue.url}")`,
        backgroundPosition: `-${cue.x}px -${cue.y}px`,
        zoom: scale,
      }}
    />
  );
}

/**
 * Retention curve (share of viewers at each 1 % of the video) with sprite thumbnails in the tooltip
 * and a thumbnail strip on the x-axis. Click a point to jump there.
 */
export function RetentionChart({
  retention,
  durationMs,
  cues,
  onSeek,
  labels,
}: {
  retention: number[];
  durationMs: number;
  cues: SpriteCue[];
  onSeek?: (ms: number) => void;
  labels: { position: string; share: string };
}) {
  const data = useMemo(
    () =>
      retention.map((v, i) => ({
        i,
        pos: Math.round(((i + 0.5) / retention.length) * durationMs),
        v: Math.round(v * 1000) / 10,
      })),
    [retention, durationMs],
  );
  const strip = useMemo(
    () => Array.from({ length: 8 }, (_, k) => cueAt(cues, ((k + 0.5) / 8) * (durationMs / 1000))),
    [cues, durationMs],
  );
  return (
    <div>
      <div className="h-60">
        <ResponsiveContainer>
          <AreaChart
            data={data}
            margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
            onClick={(e) => {
              const idx = (e as { activeTooltipIndex?: number })?.activeTooltipIndex;
              if (onSeek && idx !== undefined) onSeek(data[idx]!.pos);
            }}
          >
            <defs>
              <linearGradient id="ret" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.25} />
                <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis
              dataKey="pos"
              {...axisProps}
              type="number"
              domain={[0, durationMs]}
              tickFormatter={(ms: number) => fmtDuration(ms)}
              tickCount={8}
            />
            <YAxis {...axisProps} domain={[0, 100]} tickFormatter={(v: number) => `${v} %`} width={52} />
            <Tooltip
              cursor={{ stroke: 'var(--muted-fg)', strokeDasharray: '3 3' }}
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload as { pos: number; v: number } | undefined;
                return active && p ? (
                  <TooltipBox>
                    <SpriteThumb cue={cueAt(cues, p.pos / 1000)} />
                    <div className="mt-1 flex justify-between gap-4">
                      <span className="text-muted-fg">{labels.position}</span>
                      <span className="tabular-nums">{fmtDuration(p.pos)}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-fg">{labels.share}</span>
                      <span className="tabular-nums">{fmtPct(p.v, 1)}</span>
                    </div>
                  </TooltipBox>
                ) : null;
              }}
            />
            <Area
              dataKey="v"
              type="monotone"
              stroke="var(--series-1)"
              strokeWidth={2}
              fill="url(#ret)"
              isAnimationActive={false}
              activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {cues.length > 0 && (
        <div className="ml-[52px] mr-3 mt-1 grid grid-cols-8 gap-0.5" aria-hidden>
          {strip.map((c, k) => (
            <div key={k} className="flex justify-center overflow-hidden">
              <SpriteThumb cue={c} scale={0.5} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One-hue sequential strip (rewatch heatmap) on the same 0–100 % axis as the retention curve. */
export function HeatStrip({
  values,
  durationMs,
  label,
}: {
  values: number[];
  durationMs: number;
  label: string;
}) {
  const max = Math.max(0.0001, ...values);
  const step = (v: number) => (v <= 0 ? 0 : Math.min(6, 1 + Math.floor((v / max) * 5.999)));
  return (
    <div className="ml-[52px] mr-3">
      <div className="flex h-6 gap-px" role="img" aria-label={label}>
        {values.map((v, i) => (
          <div
            key={i}
            className="flex-1 rounded-[2px]"
            style={{ background: `var(--seq-${step(v)})` }}
            title={`${fmtDuration(((i + 0.5) / values.length) * durationMs)} · ${fmtPct(v * 100, 1)}`}
          />
        ))}
      </div>
    </div>
  );
}

/** Ranked horizontal bars (single hue), labels in text tokens, values right-aligned. */
export function BarList({
  items,
  total,
  format = (n) => fmtNum(n),
  labelOf = (k) => k,
}: {
  items: { key: string; count: number }[];
  total?: number;
  format?: (n: number) => string;
  labelOf?: (k: string) => string;
}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  const sum = total ?? items.reduce((a, i) => a + i.count, 0);
  if (!items.length) return <p className="text-sm text-muted-fg">–</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((i) => (
        <li
          key={i.key}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 text-sm"
          title={`${labelOf(i.key)}: ${format(i.count)}`}
        >
          <div className="relative min-w-0">
            <div
              className="absolute inset-y-0 left-0 rounded-r-[4px] bg-[var(--series-1)] opacity-20"
              style={{ width: `${(i.count / max) * 100}%` }}
            />
            <span className="relative block truncate px-2 py-0.5">{labelOf(i.key)}</span>
          </div>
          <span className="tabular-nums text-muted-fg">
            {format(i.count)} <span className="text-xs">({fmtPct(sum ? (i.count / sum) * 100 : 0)})</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function KpiGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6', className)}>{children}</div>
  );
}

export const delta = (cur: number, prev: number) => (prev > 0 ? (cur - prev) / prev : null);
