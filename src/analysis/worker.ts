/// <reference lib="webworker" />
import { optimize } from './optimizer';
import type { Fixture, Load, OptimizeResult, OptimizerSettings } from './types';

export interface WorkerRequest {
  positions: Float32Array;
  loads: Load[];
  fixtures: Fixture[];
  settings: OptimizerSettings;
}

export type WorkerResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; result: OptimizeResult }
  | { type: 'error'; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { positions, loads, fixtures, settings } = e.data;
  try {
    const result = optimize(positions, loads, fixtures, settings, (fraction) =>
      ctx.postMessage({ type: 'progress', fraction } satisfies WorkerResponse),
    );
    ctx.postMessage({ type: 'done', result } satisfies WorkerResponse);
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse);
  }
};
