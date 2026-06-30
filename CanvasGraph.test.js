/**
 * @zakkster/lite-canvas-graph — test suite
 *
 * Strategy: stub a minimal Canvas2D context that records every call, then
 * assert against the recorded log. Avoids pulling in jsdom/happy-dom while
 * still verifying every meaningful drawing decision.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CanvasGraph } from './CanvasGraph.js';
import { RingBuffer } from '@zakkster/lite-ring-buffer';

// ── Recording stubs ───────────────────────────────────────────────────────

function makeStubContext() {
    const calls = [];
    const ctx = {
        // properties
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        lineCap: 'butt',
        // methods
        setTransform(...a) { calls.push(['setTransform', ...a]); },
        fillRect(...a)     { calls.push(['fillRect', ...a]); },
        beginPath()        { calls.push(['beginPath']); },
        moveTo(...a)       { calls.push(['moveTo', ...a]); },
        lineTo(...a)       { calls.push(['lineTo', ...a]); },
        stroke()           { calls.push(['stroke']); },
        _calls: calls,
    };
    return ctx;
}

function makeStubCanvas(failContext = false) {
    const ctx = makeStubContext();
    const canvas = {
        width: 0,
        height: 0,
        style: { width: '', height: '' },
        getContext(type, opts) {
            if (failContext) return null;
            canvas._lastGetContextOpts = opts;
            return ctx;
        },
        _ctx: ctx,
    };
    return canvas;
}

const countCalls = (ctx, name) => ctx._calls.filter(c => c[0] === name).length;
const findCalls  = (ctx, name) => ctx._calls.filter(c => c[0] === name);

// Force a deterministic DPR for every test by passing options.dpr.
const DPR = 2;

// ── Construction ──────────────────────────────────────────────────────────

describe('construction', () => {
    it('creates and gets an alpha:false 2D context', () => {
        const canvas = makeStubCanvas();
        new CanvasGraph(canvas, 100, 50, { dpr: DPR });
        expect(canvas._lastGetContextOpts).toEqual({ alpha: false });
    });

    it('throws on missing canvas', () => {
        expect(() => new CanvasGraph(null, 100, 50)).toThrow(TypeError);
    });

    it('throws on invalid dimensions', () => {
        const canvas = makeStubCanvas();
        expect(() => new CanvasGraph(canvas, 0,   100)).toThrow(RangeError);
        expect(() => new CanvasGraph(canvas, 100, 0)).toThrow(RangeError);
        expect(() => new CanvasGraph(canvas, NaN, 100)).toThrow(RangeError);
        expect(() => new CanvasGraph(canvas, 100, Infinity)).toThrow(RangeError);
    });

    it('throws when getContext returns null', () => {
        const canvas = makeStubCanvas(true);
        expect(() => new CanvasGraph(canvas, 100, 50)).toThrow(/2d context/i);
    });

    it('floors fractional dimensions', () => {
        const canvas = makeStubCanvas();
        const g = new CanvasGraph(canvas, 100.7, 50.9, { dpr: DPR });
        expect(g.width).toBe(100);
        expect(g.height).toBe(50);
    });

    it('honours custom style options', () => {
        const canvas = makeStubCanvas();
        const g = new CanvasGraph(canvas, 100, 50, {
            dpr: DPR, background: '#abc', stroke: '#def', lineWidth: 3,
        });
        expect(g.background).toBe('#abc');
        expect(g.stroke).toBe('#def');
        expect(g.lineWidth).toBe(3);
    });
});

// ── DPR & backing store ───────────────────────────────────────────────────

describe('DPR + backing-store reconfig', () => {
    let canvas, g, ring;
    beforeEach(() => {
        canvas = makeStubCanvas();
        g = new CanvasGraph(canvas, 100, 50, { dpr: 2 });
        ring = new RingBuffer(8);
    });

    it('configures backing store on first render', () => {
        for (let i = 0; i < 4; i++) ring.push(i);
        g.render(ring, 10);

        expect(canvas.width).toBe(200);          // 100 * 2
        expect(canvas.height).toBe(100);         // 50  * 2
        expect(canvas.style.width).toBe('100px');
        expect(canvas.style.height).toBe('50px');

        const transforms = findCalls(canvas._ctx, 'setTransform');
        expect(transforms.length).toBe(1);
        expect(transforms[0]).toEqual(['setTransform', 2, 0, 0, 2, 0, 0]);
    });

    it('does NOT reconfigure backing store across consecutive renders at same DPR', () => {
        for (let i = 0; i < 4; i++) ring.push(i);
        g.render(ring, 10);
        g.render(ring, 10);
        g.render(ring, 10);
        expect(countCalls(canvas._ctx, 'setTransform')).toBe(1);
    });

    it('reconfigures after resize', () => {
        for (let i = 0; i < 4; i++) ring.push(i);
        g.render(ring, 10);
        g.resize(200, 80);
        g.render(ring, 10);
        expect(countCalls(canvas._ctx, 'setTransform')).toBe(2);
        expect(canvas.width).toBe(400);
        expect(canvas.height).toBe(160);
    });

    it('resize is no-op when dimensions unchanged', () => {
        for (let i = 0; i < 4; i++) ring.push(i);
        g.render(ring, 10);
        g.resize(100, 50);     // same → should not invalidate DPR
        g.render(ring, 10);
        expect(countCalls(canvas._ctx, 'setTransform')).toBe(1);
    });
});

// ── Empty / degenerate ────────────────────────────────────────────────────

describe('empty + degenerate inputs', () => {
    it('renders empty buffer with only clear (+ optional hook)', () => {
        const canvas = makeStubCanvas();
        const g = new CanvasGraph(canvas, 100, 50, { dpr: DPR });
        const ring = new RingBuffer(8);

        g.render(ring, 10);
        expect(countCalls(canvas._ctx, 'fillRect')).toBe(1);
        expect(countCalls(canvas._ctx, 'beginPath')).toBe(0);
    });

    it('bails on degenerate range (max <= min)', () => {
        const canvas = makeStubCanvas();
        const g = new CanvasGraph(canvas, 100, 50, { dpr: DPR });
        const ring = new RingBuffer(8);
        ring.push(5); ring.push(7);

        g.render(ring, 0);                              // range = 0
        expect(countCalls(canvas._ctx, 'beginPath')).toBe(0);

        g.render(ring, -1);                             // range < 0
        expect(countCalls(canvas._ctx, 'beginPath')).toBe(0);
    });

    it('still calls labelBitmapHook on empty / degenerate', () => {
        const canvas = makeStubCanvas();
        const g = new CanvasGraph(canvas, 100, 50, { dpr: DPR });
        const ring = new RingBuffer(8);
        let hookCalls = 0;
        g.labelBitmapHook = () => { hookCalls++; };

        g.render(ring, 10);                             // empty
        ring.push(1);
        g.render(ring, 0);                              // degenerate
        expect(hookCalls).toBe(2);
    });
});

// ── Direct (polyline) rendering ───────────────────────────────────────────

describe('direct rendering (n <= width)', () => {
    it('draws moveTo + lineTo for each sample, oldest at x=0', () => {
        const canvas = makeStubCanvas();
        const g = new CanvasGraph(canvas, 100, 50, { dpr: DPR });
        const ring = new RingBuffer(8);
        ring.push(1); ring.push(2); ring.push(3); ring.push(4);

        g.render(ring, 10);
        const moves = findCalls(canvas._ctx, 'moveTo');
        const lines = findCalls(canvas._ctx, 'lineTo');
        expect(moves.length).toBe(1);
        expect(lines.length).toBe(3);
        // First point (oldest = 1) anchored at x=0
        expect(moves[0][1]).toBe(0);
        // Last point (newest = 4) anchored at x = width-1 = 99
        expect(lines[lines.length - 1][1]).toBe(99);
    });

    it('breaks the line on NaN samples', () => {
        const canvas = makeStubCanvas();
        const g = new CanvasGraph(canvas, 100, 50, { dpr: DPR });
        const ring = new RingBuffer(8);
        ring.push(1); ring.push(NaN); ring.push(3); ring.push(NaN); ring.push(5);

        g.render(ring, 10);
        // 3 numeric segments started → 3 moveTo calls
        expect(countCalls(canvas._ctx, 'moveTo')).toBe(3);
    });

    it('clamps values to [minValue, maxValue]', () => {
        const canvas = makeStubCanvas();
        const g = new CanvasGraph(canvas, 100, 50, { dpr: DPR });
        const ring = new RingBuffer(8);
        ring.push(-100); ring.push(100); ring.push(200);

        g.render(ring, 10, { minValue: 0 });
        // y for clamped(-100) → maps to 0 → y = 50 (h)
        // y for clamped(200) → maps to 10 → y = 0
        const ys = [
            ...findCalls(canvas._ctx, 'moveTo').map(c => c[2]),
            ...findCalls(canvas._ctx, 'lineTo').map(c => c[2]),
        ];
        for (const y of ys) {
            expect(y).toBeGreaterThanOrEqual(0);
            expect(y).toBeLessThanOrEqual(50);
        }
    });

    it('emits a visible dot for n === 1 (square cap on degenerate line)', () => {
        const canvas = makeStubCanvas();
        const g = new CanvasGraph(canvas, 100, 50, { dpr: DPR });
        const ring = new RingBuffer(8);
        ring.push(5);

        g.render(ring, 10);
        // Without the fix this would be 1 moveTo + 0 lineTo → invisible
        expect(countCalls(canvas._ctx, 'moveTo')).toBe(1);
        expect(countCalls(canvas._ctx, 'lineTo')).toBe(1);
    });
});

// ── Decimated rendering (n > width) ───────────────────────────────────────

describe('decimated rendering (n > width)', () => {
    it('draws one moveTo+lineTo per occupied column when n >> width', () => {
        const canvas = makeStubCanvas();
        const w = 50;
        const g = new CanvasGraph(canvas, w, 30, { dpr: DPR });
        const ring = new RingBuffer(1024);
        for (let i = 0; i < 1024; i++) ring.push(i);

        g.render(ring, 1024);
        // Every column should have at least one sample (1024 >> 50).
        expect(countCalls(canvas._ctx, 'moveTo')).toBe(w);
        expect(countCalls(canvas._ctx, 'lineTo')).toBe(w);
    });

    it('decimated columns use crisp 0.5 pixel offsets', () => {
        const canvas = makeStubCanvas();
        const g = new CanvasGraph(canvas, 10, 30, { dpr: DPR });
        const ring = new RingBuffer(128);
        for (let i = 0; i < 128; i++) ring.push(i);

        g.render(ring, 128);
        const xs = findCalls(canvas._ctx, 'moveTo').map(c => c[1]);
        for (const x of xs) {
            // every x should be of the form bi + 0.5
            expect(x % 1).toBeCloseTo(0.5, 10);
        }
    });

    it('decimate:false forces polyline even when n > width', () => {
        const canvas = makeStubCanvas();
        const g = new CanvasGraph(canvas, 10, 30, { dpr: DPR });
        const ring = new RingBuffer(128);
        for (let i = 0; i < 128; i++) ring.push(i);

        g.render(ring, 128, { decimate: false });
        // Direct mode: 1 moveTo + (n-1) lineTo
        expect(countCalls(canvas._ctx, 'moveTo')).toBe(1);
        expect(countCalls(canvas._ctx, 'lineTo')).toBe(127);
    });

    it('decimated mode skips NaN-only columns', () => {
        const canvas = makeStubCanvas();
        const g = new CanvasGraph(canvas, 10, 30, { dpr: DPR });
        const ring = new RingBuffer(64);
        for (let i = 0; i < 64; i++) ring.push(NaN);

        g.render(ring, 100);
        // No columns occupied
        expect(countCalls(canvas._ctx, 'moveTo')).toBe(0);
        expect(countCalls(canvas._ctx, 'lineTo')).toBe(0);
    });
});

// ── labelBitmapHook ──────────────────────────────────────────────────────

describe('labelBitmapHook', () => {
    it('runs after the trace, with current ctx + dimensions', () => {
        const canvas = makeStubCanvas();
        const g = new CanvasGraph(canvas, 100, 50, { dpr: DPR });
        const ring = new RingBuffer(8);
        for (let i = 0; i < 4; i++) ring.push(i);

        let captured = null;
        g.labelBitmapHook = (ctx, maxValue, w, h) => {
            captured = { ctx, maxValue, w, h, callsBefore: ctx._calls.length };
        };

        g.render(ring, 99);
        expect(captured.maxValue).toBe(99);
        expect(captured.w).toBe(100);
        expect(captured.h).toBe(50);
        expect(captured.ctx).toBe(canvas._ctx);
    });
});

// ── destroy ──────────────────────────────────────────────────────────────

describe('destroy', () => {
    it('clears references and is idempotent', () => {
        const canvas = makeStubCanvas();
        const g = new CanvasGraph(canvas, 100, 50, { dpr: DPR });
        g.destroy();
        expect(g.canvas).toBeNull();
        expect(g.ctx).toBeNull();
        // Idempotent
        expect(() => g.destroy()).not.toThrow();
    });
});

// ── Hot-path zero-GC smoke ────────────────────────────────────────────────

describe('hot-path zero-GC smoke (best-effort)', () => {
    it.skipIf(typeof global.gc !== 'function')(
        'allocates < 2MB across 1000 renders', () => {
            const canvas = makeStubCanvas();
            const g = new CanvasGraph(canvas, 200, 100, { dpr: DPR });
            const ring = new RingBuffer(1024);
            for (let i = 0; i < 1024; i++) ring.push(Math.random());

            // Warmup — first render allocates the scratchpads.
            for (let i = 0; i < 10; i++) g.render(ring, 1);

            global.gc();
            const before = process.memoryUsage().heapUsed;
            for (let i = 0; i < 1000; i++) {
                ring.push(Math.random());
                g.render(ring, 1);
            }
            global.gc();
            const after = process.memoryUsage().heapUsed;

            expect(after - before).toBeLessThan(2 * 1024 * 1024);
        },
    );
});
