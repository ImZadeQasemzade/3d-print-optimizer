// Minimal 3D vector helpers on plain tuples so the analysis code stays
// framework-free (usable from a Web Worker and from unit tests).

export type Vec3 = [number, number, number];

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
};

/** Rotate vector v around unit axis k by angle (radians) — Rodrigues' formula. */
export const rotateAround = (v: Vec3, k: Vec3, angle: number): Vec3 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kv = cross(k, v);
  const kd = dot(k, v) * (1 - c);
  return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
};

/** Any unit vector perpendicular to the unit vector v. */
export const perpendicular = (v: Vec3): Vec3 =>
  Math.abs(v[0]) < 0.9 ? normalize(cross(v, [1, 0, 0])) : normalize(cross(v, [0, 1, 0]));
