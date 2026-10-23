import type { Vec3 } from './vec';

/** A force applied to the part, expressed in the model's own coordinate frame. */
export interface Load {
  id: number;
  /** Point on the surface where the force acts (mm). */
  point: Vec3;
  /** Outward surface normal at the point (unit). */
  normal: Vec3;
  /** Direction the force acts in (unit). */
  direction: Vec3;
  /** Force in newtons. `null` means "unknown" and is treated as 1 N (relative weighting only). */
  magnitude: number | null;
}

/** A point where the part is held / bolted / clamped (reaction point). */
export interface Fixture {
  id: number;
  point: Vec3;
}

export interface Weights {
  /** Importance of layer-line strength against the applied loads. */
  strength: number;
  /** Importance of minimising support material. */
  support: number;
  /** Importance of a low build height (print time). */
  height: number;
  /** Importance of a large, stable first-layer contact area. */
  adhesion: number;
}

export interface OptimizerSettings {
  weights: Weights;
  /** Max printable overhang measured from vertical, degrees (typ. 45). */
  overhangAngleDeg: number;
  /** Interlayer (Z) tensile strength divided by in-plane (XY) strength, typ. 0.4–0.7. */
  layerStrengthRatio: number;
  /** Number of directions sampled on the sphere in the global sweep. */
  samples: number;
}

export interface Metrics {
  /** Combined failure index of all loads (lower = stronger). */
  failureIndex: number;
  /** 0–1: how well the loads are carried along strong in-plane directions (1 = ideal). */
  strengthEfficiency: number;
  /** Area of faces that need support (mm²). */
  overhangArea: number;
  /** Approximate support volume (mm³). */
  supportVolume: number;
  /** Build height along the up direction (mm). */
  height: number;
  /** Area of faces resting flat on the build plate (mm²). */
  contactArea: number;
}

export interface Candidate {
  /** Model-frame direction that becomes "up" (+Z) on the printer. */
  up: Vec3;
  /** Normalised combined score, 0 = best possible within the evaluated set, 1 = worst. */
  score: number;
  metrics: Metrics;
  /** Rotation to apply in a slicer: first around X, then around Y (world axes), degrees. */
  rotation: { x: number; y: number };
}

export interface OptimizeResult {
  candidates: Candidate[];
  evaluated: number;
  elapsedMs: number;
}

export const DEFAULT_SETTINGS: OptimizerSettings = {
  weights: { strength: 1, support: 0.5, height: 0.2, adhesion: 0.3 },
  overhangAngleDeg: 45,
  layerStrengthRatio: 0.5,
  samples: 800,
};
