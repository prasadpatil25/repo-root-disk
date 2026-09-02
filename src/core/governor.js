// Rate governor for write traffic.
//
// Encodes what the host actually enforces rather than what it documents. The
// published ceilings of 80 per minute and 500 per hour never fired: 145 per
// minute sustained passed cleanly and 841 writes completed inside one hourly
// window. What does fire is a points system, five points per write against 900
// per minute, so the real ceiling is 180 writes per minute. A sustained 541 per
// minute was refused after 40 seconds with retry-after 60.
//
// Two behaviours follow. We target 150 per minute, comfortably under 180. And
// because the service applies backpressure before refusing (628 ms median under
// sustained eight-way concurrency against 386 ms for the same concurrency in
// short bursts), rising latency is treated as an early warning and concurrency
// is reduced before a refusal arrives.

const DEFAULTS = {
  ratePerMin: 150,
  concurrency: 8,
  minConcurrency: 1,
  backpressureRatio: 1.6,   // sustained median this much above baseline means slow down
  sampleWindow: 12          // requests per latency sample
};

export class RateLimited extends Error {
  constructor(retryAfterSeconds) {
    super(`rate limited, retry after ${retryAfterSeconds}s`);
    this.name = "RateLimited";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class Governor {
  constructor(options = {}) {
    const config = { ...DEFAULTS, ...options };
    this.ratePerMin = config.ratePerMin;
    this.concurrency = config.concurrency;
    this.minConcurrency = config.minConcurrency;
    this.backpressureRatio = config.backpressureRatio;
    this.sampleWindow = config.sampleWindow;
    this.onEvent = options.onEvent || (() => {});

    this._tokens = this.ratePerMin;
    this._lastRefill = Date.now();
    this._latencies = [];
    this._baseline = null;
    this.stats = { issued: 0, refused: 0, waitedMs: 0, backoffs: 0 };
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this._lastRefill) / 60000;
    if (elapsed <= 0) return;
    this._tokens = Math.min(this.ratePerMin, this._tokens + elapsed * this.ratePerMin);
    this._lastRefill = now;
  }

  /** Block until a write token is available. */
  async _takeToken() {
    for (;;) {
      this._refill();
      if (this._tokens >= 1) {
        this._tokens -= 1;
        return;
      }
      const deficit = 1 - this._tokens;
      const waitMs = Math.ceil((deficit / this.ratePerMin) * 60000);
      this.stats.waitedMs += waitMs;
      await sleep(waitMs);
    }
  }

  _observe(ms) {
    this._latencies.push(ms);
    if (this._latencies.length < this.sampleWindow) return;
    const median = quantile(this._latencies, 0.5);
    this._latencies = [];
    if (this._baseline === null) {
      this._baseline = median;
      return;
    }
    if (median > this._baseline * this.backpressureRatio && this.concurrency > this.minConcurrency) {
      this.concurrency = Math.max(this.minConcurrency, Math.floor(this.concurrency / 2));
      this.onEvent({
        type: "backpressure",
        medianMs: Math.round(median),
        baselineMs: Math.round(this._baseline),
        concurrency: this.concurrency
      });
    } else if (median < this._baseline * 1.1) {
      this._baseline = Math.min(this._baseline, median);
    }
  }

  /**
   * Run one governed write. `fn` should throw RateLimited on a 403 or 429 so the
   * governor can honour retry-after rather than hammering.
   */
  async write(fn, { retries = 3 } = {}) {
    for (let attempt = 0; ; attempt++) {
      await this._takeToken();
      const started = Date.now();
      try {
        const result = await fn();
        this.stats.issued++;
        this._observe(Date.now() - started);
        return result;
      } catch (err) {
        if (!(err instanceof RateLimited) || attempt >= retries) throw err;
        this.stats.refused++;
        this.stats.backoffs++;
        this.concurrency = Math.max(this.minConcurrency, Math.floor(this.concurrency / 2));
        const waitMs = Math.max(1000, err.retryAfterSeconds * 1000);
        this.onEvent({
          type: "refused",
          retryAfterSeconds: err.retryAfterSeconds,
          concurrency: this.concurrency,
          attempt: attempt + 1
        });
        this._tokens = 0;
        await sleep(waitMs);
      }
    }
  }

  /**
   * Run many governed writes, respecting the current concurrency. Concurrency
   * is re-read between tasks so backpressure takes effect mid-batch.
   */
  async all(taskFns) {
    const tasks = [...taskFns];
    const results = new Array(tasks.length);
    let next = 0;
    let failure = null;

    const worker = async () => {
      for (;;) {
        if (failure) return;
        const index = next++;
        if (index >= tasks.length) return;
        try {
          results[index] = await this.write(tasks[index]);
        } catch (err) {
          failure = failure || err;
          return;
        }
      }
    };

    const workers = [];
    for (let i = 0; i < Math.max(1, this.concurrency); i++) workers.push(worker());
    await Promise.all(workers);
    if (failure) throw failure;
    return results;
  }

  /** Seconds a batch of this size will take at the current sustained rate. */
  estimateSeconds(writeCount) {
    return (writeCount / this.ratePerMin) * 60;
  }
}

function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
