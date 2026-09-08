import { extentOf, pathFor, toSeries, type Reading } from '../api/history';

/**
 * A small line chart, drawn in the panel's own materials.
 *
 * The one thing it does that a naive chart does not: **it lifts the pen across
 * a reporting gap.** The app only uploads while a technician is linked, so a
 * series can jump hours between points. Joining those with a straight line
 * would assert a state of charge for a period nobody measured — the same
 * dishonesty the fleet list avoids by printing an age beside every number.
 */

const WIDTH = 620;
const HEIGHT = 120;

export function Sparkline({
  readings,
  pick,
  label,
  unit,
  floor,
  ceiling,
  tone = 'var(--accent)',
}: {
  readings: Reading[];
  pick: (r: Reading) => number;
  label: string;
  unit: string;
  floor?: number;
  ceiling?: number;
  tone?: string;
}) {
  if (readings.length === 0) {
    return <p className="empty">No readings for {label.toLowerCase()} yet.</p>;
  }

  const series = toSeries(readings, pick);
  const extent = extentOf(series.points, floor, ceiling);
  const path = pathFor(series, extent, WIDTH, HEIGHT);

  const latest = series.points[series.points.length - 1]!;
  const first = series.points[0]!;

  return (
    <figure style={{ margin: '0 0 22px' }}>
      <figcaption
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}
      >
        <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>{label}</span>
        <span className="figure" style={{ fontSize: 15, color: 'var(--ink-strong)' }}>
          {latest.value.toFixed(unit === 'V' ? 2 : 1)} {unit}
        </span>
      </figcaption>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        height={HEIGHT}
        role="img"
        /*
          The accessible name carries the numbers, not the shape. Someone who
          cannot see the line still needs the range and the reading — and the
          count of breaks, because a series with gaps means something.
        */
        aria-label={
          `${label}: ${series.points.length} readings, ` +
          `${first.value.toFixed(1)} to ${latest.value.toFixed(1)} ${unit}` +
          (series.breaks.length > 0
            ? `, with ${series.breaks.length} gap${series.breaks.length === 1 ? '' : 's'} where nothing was reported`
            : '')
        }
        style={{ display: 'block', marginTop: 6 }}
      >
        <rect
          x={0}
          y={0}
          width={WIDTH}
          height={HEIGHT}
          fill="var(--panel-alt)"
          rx={8}
          stroke="var(--panel-stitch)"
          strokeDasharray="3 3"
        />
        <path d={path} fill="none" stroke={tone} strokeWidth={1.75} strokeLinejoin="round" />
      </svg>

      {series.breaks.length > 0 ? (
        <p className="panel-note" style={{ marginTop: 4 }}>
          {series.breaks.length} gap{series.breaks.length === 1 ? '' : 's'} where nothing was
          reported. The line is broken there rather than drawn through.
        </p>
      ) : null}
    </figure>
  );
}
