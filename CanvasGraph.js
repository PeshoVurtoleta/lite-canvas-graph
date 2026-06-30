/**
 * @zakkster/lite-canvas-graph
 *
 * Zero-GC canvas rendering for time-series telemetry.
 *
 * Time flows LEFT → RIGHT: oldest sample on the left edge, newest on the right.
 * One scratchpad allocation per resize (or capacity change), nothing in the
 * hot path. Renders directly from a `RingBuffer` via `copyTo` — no array
 * conversion, no per-frame `[].slice()`, no `Array.from`.
 *
 * Decimation strategy (when sample count exceeds pixel width):
 *   Each pixel column collects min/max of all samples that map to it, and the
 *   renderer draws a single vertical line per column from min to max. No
 *   diagonals between columns — the output reads as a clean envelope/barcode,
 *   which is the standard convention for oscilloscopes and audio waveform
 *   views. Empty columns leave a gap rather than fake-filling with neighbours.
 *
 * Worker-friendly:
 *   `window` is not referenced. Pass `options.dpr` in OffscreenCanvas/Worker
 *   contexts where `globalThis.devicePixelRatio` is undefined.
 */
export class CanvasGraph {
    /**
     * @param {HTMLCanvasElement|OffscreenCanvas} canvas
     * @param {number} width   logical (CSS) width in pixels, >= 1
     * @param {number} height  logical (CSS) height in pixels, >= 1
     * @param {object} [options]
     * @param {number} [options.dpr]              override devicePixelRatio (required in Workers)
     * @param {string} [options.background='#111']
     * @param {string} [options.stroke='#00ffcc']
     * @param {number} [options.lineWidth=1]
     */
    constructor(canvas, width, height, options = {}) {
        if (!canvas) throw new TypeError('LiteCanvasGraph: canvas is required');
        if (!Number.isFinite(width) || width < 1) {
            throw new RangeError(`LiteCanvasGraph: width must be >= 1 (got ${width})`);
        }
        if (!Number.isFinite(height) || height < 1) {
            throw new RangeError(`LiteCanvasGraph: height must be >= 1 (got ${height})`);
        }

        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', {alpha: false});
        if (!this.ctx) throw new Error('LiteCanvasGraph: failed to get 2d context');

        this.width = Math.floor(width);
        this.height = Math.floor(height);

        this._dprOverride = options.dpr;
        this._dpr = 0; // sentinel: forces backing-store reconfig on first render
        this.background = options.background ?? '#111';
        this.stroke = options.stroke ?? '#00ffcc';
        this.lineWidth = options.lineWidth ?? 1;

        /** @type {Float32Array|null} sample copy scratchpad */
        this._scratch = null;
        /** @type {Float32Array|null} per-column [min, max] pairs (length = width * 2) */
        this._pixelScratch = null;

        /**
         * Optional hook called at the end of each `render()`. Useful for
         * overlaying axis labels, units, or peak markers without forcing them
         * into the core renderer. Called with the live 2D context — anything
         * you draw will appear ON TOP of the trace.
         *
         * @type {((ctx: CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D, maxValue: number, width: number, height: number) => void) | null}
         */
        this.labelBitmapHook = null;
    }

    /**
     * Resize logical drawing area. Forces backing-store reconfig and pixel
     * scratchpad reallocation on the next `render()` call. Cheap to call when
     * dimensions are unchanged — DPR sentinel only resets if values shifted.
     *
     * @param {number} width  >= 1
     * @param {number} height >= 1
     */
    resize(width, height) {
        if (!Number.isFinite(width) || width < 1) {
            throw new RangeError(`LiteCanvasGraph.resize: width must be >= 1 (got ${width})`);
        }
        if (!Number.isFinite(height) || height < 1) {
            throw new RangeError(`LiteCanvasGraph.resize: height must be >= 1 (got ${height})`);
        }
        const w = Math.floor(width);
        const h = Math.floor(height);
        if (w === this.width && h === this.height) return;

        this.width = w;
        this.height = h;
        this._dpr = 0;            // force backing-store reconfig
        this._pixelScratch = null; // force decimation scratch reallocation
    }

    _resolveDpr() {
        if (this._dprOverride !== undefined) return this._dprOverride;
        if (typeof globalThis !== 'undefined' && globalThis.devicePixelRatio) {
            return globalThis.devicePixelRatio;
        }
        return 1;
    }

    /**
     * Draw the current contents of `ringBuffer` to the canvas.
     *
     * Hot path is allocation-free after the first call: the sample scratch
     * grows once to `ringBuffer.capacity`, the pixel scratch grows once to
     * `width * 2`, and both are reused forever.
     *
     * @param {import('@zakkster/lite-ring-buffer').RingBuffer} ringBuffer
     * @param {number} maxValue   upper bound of the value range
     * @param {object} [options]
     * @param {boolean} [options.decimate=true]   aggregate to per-column min/max when n > width
     * @param {number}  [options.minValue=0]      lower bound of the value range
     */
    render(ringBuffer, maxValue, options) {
        // Property access (no destructuring default) keeps this allocation-free
        // when `options` is omitted.
        const decimate = options ? options.decimate !== false : true;
        const minValue = options && options.minValue !== undefined ? options.minValue : 0;

        // Reconfigure backing store on DPR change (or first render).
        const dpr = this._resolveDpr();
        if (this._dpr !== dpr) {
            this._dpr = dpr;
            this.canvas.width = Math.floor(this.width * dpr);
            this.canvas.height = Math.floor(this.height * dpr);
            if (this.canvas.style) {
                this.canvas.style.width = `${this.width}px`;
                this.canvas.style.height = `${this.height}px`;
            }
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        // Clear with solid background (alpha: false context, so this is opaque).
        this.ctx.fillStyle = this.background;
        this.ctx.fillRect(0, 0, this.width, this.height);

        const count = ringBuffer.count;
        if (count === 0) {
            if (this.labelBitmapHook) this.labelBitmapHook(this.ctx, maxValue, this.width, this.height);
            return;
        }

        const range = maxValue - minValue;
        if (!(range > 0)) {
            // Degenerate range: cannot map values to pixels. Bail honestly.
            if (this.labelBitmapHook) this.labelBitmapHook(this.ctx, maxValue, this.width, this.height);
            return;
        }

        // Lazy / grow scratch. Grow-only — never shrinks across frames.
        if (!this._scratch || this._scratch.length < ringBuffer.capacity) {
            this._scratch = new Float32Array(ringBuffer.capacity);
        }
        const n = ringBuffer.copyTo(this._scratch, 0); // oldest-first

        this.ctx.strokeStyle = this.stroke;
        this.ctx.lineWidth = this.lineWidth;
        this.ctx.lineCap = 'square'; // ensures single-sample columns render visibly

        const usableX = this.width - 1; // last drawable pixel column
        const yScale = this.height / range;

        if (decimate && n > this.width) {
            this._renderDecimated(this._scratch, n, minValue, maxValue, yScale);
        } else {
            this._renderDirect(this._scratch, n, minValue, maxValue, yScale, usableX);
        }

        if (this.labelBitmapHook) {
            this.labelBitmapHook(this.ctx, maxValue, this.width, this.height);
        }
    }

    _renderDirect(samples, n, minValue, maxValue, yScale, usableX) {
        const ctx = this.ctx;
        const h = this.height;
        const stepX = n > 1 ? usableX / (n - 1) : 0;

        ctx.beginPath();
        let started = false;
        let lastX = 0, lastY = 0;
        for (let i = 0; i < n; i++) {
            const raw = samples[i];
            if (raw !== raw) {
                started = false;
                continue;
            } // NaN → break the line

            const v = raw < minValue ? minValue : (raw > maxValue ? maxValue : raw);
            const x = i * stepX;                       // index 0 → x=0 (oldest, left)
            const y = h - (v - minValue) * yScale;     // (newest is at x=usableX, right)

            if (!started) {
                ctx.moveTo(x, y);
                started = true;
                lastX = x;
                lastY = y;
            } else {
                ctx.lineTo(x, y);
                lastX = x;
                lastY = y;
            }
        }

        // Single-sample edge case: a lone moveTo() draws nothing. Emit a
        // tiny lineTo so lineCap='square' produces a visible dot at lineWidth.
        if (started && n === 1) {
            ctx.lineTo(lastX, lastY);
        }
        ctx.stroke();
    }

    _renderDecimated(samples, n, minValue, maxValue, yScale) {
        const ctx = this.ctx;
        const h = this.height;
        const w = this.width;

        if (!this._pixelScratch || this._pixelScratch.length !== w * 2) {
            this._pixelScratch = new Float32Array(w * 2);
        }
        const px = this._pixelScratch;
        for (let i = 0; i < w; i++) {
            px[i * 2] = Infinity;
            px[i * 2 + 1] = -Infinity;
        }

        // Map sample index i ∈ [0, n-1] → bucket bi ∈ [0, w-1].
        // Endpoints land exactly on the first/last column.
        const denom = n - 1;
        for (let i = 0; i < n; i++) {
            const sample = samples[i];
            if (sample !== sample) continue; // NaN
            const bi = denom > 0 ? Math.floor((i * (w - 1)) / denom) : 0;
            const mi = bi * 2;
            if (sample < px[mi]) px[mi] = sample;
            if (sample > px[mi + 1]) px[mi + 1] = sample;
        }

        // One vertical span per column. Each column is a discrete subpath
        // (moveTo + lineTo); empty columns leave a gap rather than fake-filling.
        ctx.beginPath();
        for (let bi = 0; bi < w; bi++) {
            const mn = px[bi * 2];
            const mx = px[bi * 2 + 1];
            if (mn === Infinity) continue; // no samples in this column

            const lo = mn < minValue ? minValue : (mn > maxValue ? maxValue : mn);
            const hi = mx < minValue ? minValue : (mx > maxValue ? maxValue : mx);

            const yLo = h - (lo - minValue) * yScale;
            const yHi = h - (hi - minValue) * yScale;
            const xPx = bi + 0.5; // crisp 1px-aligned vertical

            ctx.moveTo(xPx, yHi);
            // For a single-sample bucket (yLo === yHi) the line is degenerate;
            // lineCap='square' guarantees a visible mark at lineWidth pixels.
            ctx.lineTo(xPx, yLo);
        }
        ctx.stroke();
    }

    /** Release internal scratchpads and the canvas reference. Idempotent. */
    destroy() {
        this.ctx = null;
        this.canvas = null;
        this._scratch = null;
        this._pixelScratch = null;
        this.labelBitmapHook = null;
    }
}
