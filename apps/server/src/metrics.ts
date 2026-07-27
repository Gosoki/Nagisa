/**
 * In-process metrics.
 * ===================
 *
 * A minimal counters/gauges/histograms registry with a Prometheus text exposition
 * renderer, so `GET /metrics` can be scraped without pulling in `prom-client`. Every
 * metric type here is intentionally small:
 *
 * - **Counter**: monotonically increasing (connections opened, messages seen, errors).
 * - **Gauge**: a point-in-time value that can go up or down (current connections, room
 *   population).
 * - **Histogram**: fixed-bucket distribution, used here for tick duration. We only ever
 *   need cheap p50/p95/p99 for one series (tick time), so a full quantile sketch would
 *   be overkill — a small ring buffer of recent samples plus a sort is fast enough at
 *   10 ticks/sec.
 *
 * All metric state lives in module-level maps so any file can `import { metrics }` and
 * record without threading a registry object through every function signature.
 */

/** Sanitises a metric/label name fragment into something Prometheus-safe. */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_:]/g, '_');
}

function formatLabels(labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return '';
  const parts = Object.entries(labels).map(([k, v]) => `${sanitize(k)}="${String(v).replace(/"/g, '\\"')}"`);
  return `{${parts.join(',')}}`;
}

/** Composite key for a metric name + label set, used to store distinct label series. */
function seriesKey(name: string, labels?: Record<string, string>): string {
  if (!labels) return name;
  const sorted = Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`);
  return `${name}{${sorted.join(',')}}`;
}

interface Series {
  name: string;
  labels?: Record<string, string>;
}

class Counter {
  private values = new Map<string, number>();
  private series = new Map<string, Series>();

  inc(labels?: Record<string, string>, by = 1): void {
    const key = seriesKey(this.name, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
    this.series.set(key, { name: this.name, labels });
  }

  constructor(private readonly name: string, private readonly help: string) {}

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) {
      const s = this.series.get(key)!;
      lines.push(`${this.name}${formatLabels(s.labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

class Gauge {
  private values = new Map<string, number>();
  private series = new Map<string, Series>();

  set(value: number, labels?: Record<string, string>): void {
    const key = seriesKey(this.name, labels);
    this.values.set(key, value);
    this.series.set(key, { name: this.name, labels });
  }

  inc(labels?: Record<string, string>, by = 1): void {
    const key = seriesKey(this.name, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
    this.series.set(key, { name: this.name, labels });
  }

  dec(labels?: Record<string, string>, by = 1): void {
    this.inc(labels, -by);
  }

  constructor(private readonly name: string, private readonly help: string) {}

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const [key, value] of this.values) {
      const s = this.series.get(key)!;
      lines.push(`${this.name}${formatLabels(s.labels)} ${value}`);
    }
    return lines.join('\n');
  }
}

/**
 * Fixed-capacity ring buffer of recent sample values, used for cheap quantile
 * estimation. Bounded memory regardless of run length — we only ever care about
 * "recent" tick durations, not the all-time history.
 */
class Histogram {
  private samples: number[] = [];
  private readonly capacity = 1000;
  private cursor = 0;
  private count = 0;

  constructor(private readonly name: string, private readonly help: string) {}

  observe(value: number): void {
    if (this.samples.length < this.capacity) {
      this.samples.push(value);
    } else {
      this.samples[this.cursor] = value;
    }
    this.cursor = (this.cursor + 1) % this.capacity;
    this.count++;
  }

  private quantile(q: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[idx];
  }

  p50(): number {
    return this.quantile(0.5);
  }
  p95(): number {
    return this.quantile(0.95);
  }
  p99(): number {
    return this.quantile(0.99);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} summary`];
    lines.push(`${this.name}{quantile="0.5"} ${this.p50()}`);
    lines.push(`${this.name}{quantile="0.95"} ${this.p95()}`);
    lines.push(`${this.name}{quantile="0.99"} ${this.p99()}`);
    lines.push(`${this.name}_count ${this.count}`);
    return lines.join('\n');
  }
}

/**
 * The process-wide metrics registry. Grouped by concern so call sites read naturally,
 * e.g. `metrics.messagesIn.inc({ type: 'move' })`.
 */
class Metrics {
  readonly connectionsTotal = new Counter('nagisa_connections_total', 'Total WebSocket connections accepted.');
  readonly connectionsCurrent = new Gauge('nagisa_connections_current', 'Currently open WebSocket connections.');
  readonly messagesIn = new Counter('nagisa_messages_in_total', 'Inbound client messages, by type.');
  readonly messagesOut = new Counter('nagisa_messages_out_total', 'Outbound server messages, by type.');
  readonly messagesDropped = new Counter(
    'nagisa_messages_dropped_total',
    'Outbound messages dropped due to backpressure, by type.',
  );
  readonly errorsTotal = new Counter('nagisa_errors_total', 'Errors, by kind.');
  readonly rateLimited = new Counter('nagisa_rate_limited_total', 'Messages rejected by rate limiting, by type.');
  readonly tickDurationMs = new Histogram('nagisa_tick_duration_ms', 'Room tick loop duration, milliseconds.');
  readonly roomPopulation = new Gauge('nagisa_room_population', 'Current population, by room.');
  readonly roomsCurrent = new Gauge('nagisa_rooms_current', 'Number of active room shards.');
  readonly activitiesCurrent = new Gauge('nagisa_activities_current', 'Number of activities, by state.');

  private readonly all = [
    this.connectionsTotal,
    this.connectionsCurrent,
    this.messagesIn,
    this.messagesOut,
    this.messagesDropped,
    this.errorsTotal,
    this.rateLimited,
    this.tickDurationMs,
    this.roomPopulation,
    this.roomsCurrent,
    this.activitiesCurrent,
  ];

  /** Render every registered metric as Prometheus text exposition format. */
  renderPrometheus(): string {
    return this.all.map((m) => m.render()).join('\n') + '\n';
  }
}

/** The process-wide metrics singleton. Import and use directly; there is only ever one. */
export const metrics = new Metrics();
