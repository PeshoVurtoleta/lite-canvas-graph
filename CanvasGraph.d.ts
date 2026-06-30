/**
 * @zakkster/lite-canvas-graph
 * Zero-GC canvas rendering for time-series telemetry.
 */

import { RingBuffer } from '@zakkster/lite-ring-buffer';

/** Constructor options for {@link CanvasGraph}. */
export interface CanvasGraphOptions {
    /**
     * Override `globalThis.devicePixelRatio`.
     * Required in OffscreenCanvas / Worker contexts where DPR is undefined.
     * @default globalThis.devicePixelRatio || 1
     */
    dpr?: number;
    /**
     * Background fill (rendered with `alpha: false`, so this is opaque).
     * @default '#111'
     */
    background?: string;
    /**
     * Trace stroke style.
     * @default '#00ffcc'
     */
    stroke?: string;
    /**
     * Trace stroke width in CSS pixels.
     * @default 1
     */
    lineWidth?: number;
}

/** Per-call options for {@link CanvasGraph.render}. */
export interface RenderOptions {
    /**
     * When `true` and `ringBuffer.count > width`, render a per-column
     * min/max envelope (oscilloscope/audio-waveform style). When `false`,
     * always render a polyline regardless of sample count.
     * @default true
     */
    decimate?: boolean;
    /**
     * Lower bound of the value range. Anything below is clamped to this.
     * @default 0
     */
    minValue?: number;
}

/**
 * Optional post-render hook signature. Anything drawn here lands ON TOP of
 * the trace — useful for axis labels, units, peak markers, etc.
 */
export type LabelBitmapHook = (
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    maxValue: number,
    width: number,
    height: number,
) => void;

/**
 * Zero-GC canvas renderer for time-series ring buffers.
 *
 * One scratch allocation per resize, nothing per-frame. Reads samples
 * directly from a {@link RingBuffer} via `copyTo` — no array conversion,
 * no `Array.from`, no `[].slice()`.
 *
 * Time flows LEFT → RIGHT: oldest sample on the left edge, newest on the right.
 *
 * @example
 * ```ts
 * import { RingBuffer }  from '@zakkster/lite-ring-buffer';
 * import { CanvasGraph } from '@zakkster/lite-canvas-graph';
 *
 * const ring  = new RingBuffer(1024);
 * const graph = new CanvasGraph(canvas, 400, 120, { stroke: '#0ff' });
 *
 * function frame(t: number) {
 *   ring.push(Math.sin(t / 200));
 *   graph.render(ring, 1, { minValue: -1 });
 *   requestAnimationFrame(frame);
 * }
 * requestAnimationFrame(frame);
 * ```
 */
export class CanvasGraph {
    /** The bound canvas (HTMLCanvasElement in the main thread, OffscreenCanvas in workers). */
    canvas: HTMLCanvasElement | OffscreenCanvas | null;
    /** Live 2D context. Becomes `null` after {@link destroy}. */
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    /** Logical (CSS) width in pixels. */
    width: number;
    /** Logical (CSS) height in pixels. */
    height: number;
    /** Background fill colour. Mutate freely between frames. */
    background: string;
    /** Trace stroke style. Mutate freely between frames. */
    stroke: string;
    /** Trace stroke width in CSS pixels. Mutate freely between frames. */
    lineWidth: number;
    /**
     * Optional post-render hook. Draws ON TOP of the trace.
     * Set to `null` (default) to skip. Mutate freely between frames.
     */
    labelBitmapHook: LabelBitmapHook | null;

    /**
     * @param canvas  Render target.
     * @param width   Logical (CSS) width in pixels, >= 1.
     * @param height  Logical (CSS) height in pixels, >= 1.
     * @param options See {@link CanvasGraphOptions}.
     * @throws {TypeError}  if `canvas` is missing.
     * @throws {RangeError} if `width` or `height` is < 1 or non-finite.
     */
    constructor(
        canvas: HTMLCanvasElement | OffscreenCanvas,
        width: number,
        height: number,
        options?: CanvasGraphOptions,
    );

    /**
     * Resize logical drawing area. Forces backing-store reconfig and pixel
     * scratchpad reallocation on the next {@link render} call.
     * No-op if dimensions are unchanged.
     */
    resize(width: number, height: number): void;

    /**
     * Draw the current contents of `ringBuffer` to the canvas.
     * Allocation-free in the steady state.
     */
    render(ringBuffer: RingBuffer, maxValue: number, options?: RenderOptions): void;

    /** Release internal scratchpads and the canvas reference. Idempotent. */
    destroy(): void;
}
