/**
 * Print-orientation optimizer.
 *
 * For a candidate "up" (build) direction b, each orientation is scored on:
 *
 *  1. Strength — FDM parts are anisotropic: layers bond to each other far more
 *     weakly than the extruded lines within a layer. Each load is turned into a
 *     principal stress along the lever arm between the load and its nearest
 *     fixture (bending + axial), then the stress is resolved against the layer
 *     planes with a Tsai-Hill style failure index. Loads carried in-plane score
 *     best; loads that pull layers apart score worst.
 *  2. Support — faces overhanging more than the allowed angle need support; the
 *     support volume is approximated by projected area × height above the bed.
 *  3. Height — taller prints take longer and are more likely to wobble.
 *  4. Adhesion — a large flat first layer sticks better and needs no brim.
 *
 * It is a fast engineering heuristic (not FEA): good for ranking orientations,
 * not for predicting absolute failure loads.
 */
import type { Candidate, Fixture, Load, Metrics, OptimizeResult, OptimizerSettings } from './types';
import { cross, dot, length, normalize, perpendicular, rotateAround, scale, sub, type Vec3 } from './vec';

export interface PreparedMesh {
  triCount: number;
  /** 9 floats per triangle (three vertices). */
  positions: Float32Array;
  /** Unit normal per triangle. */
  normals: Float32Array;
  /** Area per triangle (scaled up when the mesh is a subsample). */
  areas: Float32Array;
  centroids: Float32Array;
  totalArea: number;
  volume: number;
  /** Area-weighted surface centroid. */
  center: Vec3;
  /** Characteristic wall/section thickness estimate (mm). */
  thickness: number;
  diagonal: number;
}

/** Build per-triangle data from a non-indexed position array (9 floats per triangle). */
export function prepareMesh(positions: Float32Array): PreparedMesh {
  const triCount = Math.floor(positions.length / 9);
  const normals = new Float32Array(triCount * 3);
  const areas = new Float32Array(triCount);
  const centroids = new Float32Array(triCount * 3);
  let totalArea = 0;
  let volume = 0;
  let cx = 0, cy = 0, cz = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const qx = positions[o + 6], qy = positions[o + 7], qz = positions[o + 8];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = qx - ax, e2y = qy - ay, e2z = qz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz);
    const area = len / 2;
    areas[t] = area;
    if (len > 0) {
      normals[t * 3] = nx / len;
      normals[t * 3 + 1] = ny / len;
      normals[t * 3 + 2] = nz / len;
    }
    const gx = (ax + bx + qx) / 3, gy = (ay + by + qy) / 3, gz = (az + bz + qz) / 3;
    centroids[t * 3] = gx;
    centroids[t * 3 + 1] = gy;
    centroids[t * 3 + 2] = gz;
    totalArea += area;
    cx += gx * area;
    cy += gy * area;
    cz += gz * area;
    // Signed tetrahedron volume (divergence theorem).
    volume += (ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx)) / 6;
    minX = Math.min(minX, ax, bx, qx); maxX = Math.max(maxX, ax, bx, qx);
    minY = Math.min(minY, ay, by, qy); maxY = Math.max(maxY, ay, by, qy);
    minZ = Math.min(minZ, az, bz, qz); maxZ = Math.max(maxZ, az, bz, qz);
  }

  volume = Math.abs(volume);
  const center: Vec3 = totalArea > 0 ? [cx / totalArea, cy / totalArea, cz / totalArea] : [0, 0, 0];
  const diagonal = triCount > 0 ? Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) : 1;
  // For a plate of thickness t: V/A ≈ t/2, so 2V/A is a decent section-thickness proxy.
  const thickness = totalArea > 0 && volume > 0 ? Math.max((2 * volume) / totalArea, diagonal * 1e-3) : diagonal * 0.1;

  return { triCount, positions, normals, areas, centroids, totalArea, volume, center, thickness, diagonal };
}

/** Deterministic stride subsample used for the fast global sweep on huge meshes. */
export function subsampleMesh(mesh: PreparedMesh, maxTris: number): PreparedMesh {
  if (mesh.triCount <= maxTris) return mesh;
  const stride = mesh.triCount / maxTris;
  const n = Math.floor(mesh.triCount / stride);
  const positions = new Float32Array(n * 9);
  const normals = new Float32Array(n * 3);
  const areas = new Float32Array(n);
  const centroids = new Float32Array(n * 3);
  let sampledArea = 0;
  for (let i = 0; i < n; i++) {
    const t = Math.floor(i * stride);
    positions.set(mesh.positions.subarray(t * 9, t * 9 + 9), i * 9);
    normals.set(mesh.normals.subarray(t * 3, t * 3 + 3), i * 3);
    centroids.set(mesh.centroids.subarray(t * 3, t * 3 + 3), i * 3);
    areas[i] = mesh.areas[t];
    sampledArea += mesh.areas[t];
  }
  const k = sampledArea > 0 ? mesh.totalArea / sampledArea : 1;
  for (let i = 0; i < n; i++) areas[i] *= k;
  return { ...mesh, triCount: n, positions, normals, areas, centroids };
}

/** Rotation (degrees) that brings `up` to +Z: rotate about world X first, then world Y. */
export function rotationForUp(up: Vec3): { x: number; y: number } {
  const [bx, by, bz] = normalize(up);
  const alpha = Math.atan2(by, bz);
  const beta = Math.atan2(-bx, Math.hypot(by, bz));
  const round = (r: number) => Math.round(((r * 180) / Math.PI) * 10) / 10 || 0;
  return { x: round(alpha), y: round(beta) };
}

/** Evenly distributed unit vectors on the sphere (Fibonacci lattice). */
export function fibonacciSphere(n: number): Vec3[] {
  const out: Vec3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    out.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  return out;
}

/**
 * Up-directions that put a large flat face on the bed. Faces are grouped by
 * quantised normal; the biggest groups are returned as `up = -normal`.
 */
export function flatFaceCandidates(mesh: PreparedMesh, count = 24): Vec3[] {
  const buckets = new Map<string, { area: number; n: Vec3 }>();
  const q = 20; // ~3° buckets
  for (let t = 0; t < mesh.triCount; t++) {
    const nx = mesh.normals[t * 3], ny = mesh.normals[t * 3 + 1], nz = mesh.normals[t * 3 + 2];
    const key = `${Math.round(nx * q)},${Math.round(ny * q)},${Math.round(nz * q)}`;
    const a = mesh.areas[t];
    const b = buckets.get(key);
    if (b) {
      b.area += a;
      b.n[0] += nx * a; b.n[1] += ny * a; b.n[2] += nz * a;
    } else {
      buckets.set(key, { area: a, n: [nx * a, ny * a, nz * a] });
    }
  }
  return [...buckets.values()]
    .sort((a, b) => b.area - a.area)
    .slice(0, count)
    .map((b) => scale(normalize(b.n), -1));
}

/** Per-load principal stress (relative units) and its direction in the model frame. */
interface LoadStress {
  sigma: number;
  dir: Vec3;
}

export function loadStresses(loads: Load[], fixtures: Fixture[], mesh: PreparedMesh): LoadStress[] {
  const s = mesh.thickness;
  return loads.map((load) => {
    const F = scale(normalize(load.direction), load.magnitude ?? 1);
    const Fmag = length(F);
    let anchor = mesh.center;
    if (fixtures.length > 0) {
      let best = Infinity;
      for (const f of fixtures) {
        const d = length(sub(load.point, f.point));
        if (d < best) { best = d; anchor = f.point; }
      }
    }
    const r = sub(load.point, anchor);
    const L = length(r);
    if (L < s * 0.5 || Fmag === 0) {
      // Load acts (almost) on its support: pure direct stress along the force.
      return { sigma: Fmag / (s * s), dir: Fmag > 0 ? normalize(F) : [0, 0, 1] };
    }
    const rh = scale(r, 1 / L);
    const axial = dot(F, rh); // > 0: pulls away from the support (tension)
    const transverse = length(cross(rh, F));
    // Bending σ = M·c/I ≈ 6·M/s³ for a square section of side s; axial σ = F/A.
    const bending = (6 * transverse * L) / (s * s * s);
    const direct = (axial > 0 ? axial : 0.2 * -axial) / (s * s);
    return { sigma: bending + direct, dir: rh };
  });
}

/** Tsai-Hill style failure index of a uniaxial stress σ at angle φ to the build axis. */
export function anisotropicFactor(cosToBuildAxis: number, layerRatio: number): number {
  const c2 = cosToBuildAxis * cosToBuildAxis;
  const s2 = 1 - c2;
  const rz = Math.max(layerRatio, 0.05);
  const rs = Math.min(1, rz * 1.2); // interlayer shear strength ratio
  return Math.sqrt(s2 * s2 + (c2 / rz) ** 2 + (s2 * c2) / (rs * rs));
}

function maxVertexHeight(P: Float32Array, t: number, up: Vec3): number {
  const o = t * 9;
  return Math.max(
    P[o] * up[0] + P[o + 1] * up[1] + P[o + 2] * up[2],
    P[o + 3] * up[0] + P[o + 4] * up[1] + P[o + 5] * up[2],
    P[o + 6] * up[0] + P[o + 7] * up[1] + P[o + 8] * up[2],
  );
}

export function evaluate(
  mesh: PreparedMesh,
  upIn: Vec3,
  stresses: LoadStress[],
  settings: OptimizerSettings,
): Metrics {
  const up = normalize(upIn);
  const [ux, uy, uz] = up;
  const P = mesh.positions;
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const h = P[i] * ux + P[i + 1] * uy + P[i + 2] * uz;
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  const height = maxH - minH;
  const tol = Math.max(0.05, mesh.diagonal * 2e-3);
  const overhangLimit = -Math.sin((settings.overhangAngleDeg * Math.PI) / 180);
  const N = mesh.normals, A = mesh.areas, C = mesh.centroids;

  let overhangArea = 0, supportVolume = 0, contactArea = 0;
  for (let t = 0; t < mesh.triCount; t++) {
    const c = N[t * 3] * ux + N[t * 3 + 1] * uy + N[t * 3 + 2] * uz;
    if (c >= overhangLimit) continue;
    const above = C[t * 3] * ux + C[t * 3 + 1] * uy + C[t * 3 + 2] * uz - minH;
    if (above <= tol) {
      if (c < -0.985 && maxVertexHeight(P, t, up) - minH <= tol) contactArea += A[t];
      continue; // resting on the bed, needs no support
    }
    overhangArea += A[t];
    supportVolume += A[t] * -c * above;
  }

  let fi = 0, ideal = 0;
  for (const st of stresses) {
    fi += st.sigma * anisotropicFactor(dot(st.dir, up), settings.layerStrengthRatio);
    ideal += st.sigma;
  }
  return {
    failureIndex: fi,
    strengthEfficiency: fi > 0 ? ideal / fi : 1,
    overhangArea,
    supportVolume,
    height,
    contactArea,
  };
}

/** Normalisation constants derived from the global sweep so scores are comparable. */
interface Scale {
  maxSupport: number;
  minHeight: number;
  maxHeight: number;
  maxContact: number;
  hasLoads: boolean;
  layerRatio: number;
}

export function combinedScore(m: Metrics, sc: Scale, settings: OptimizerSettings): number {
  const w = settings.weights;
  const terms: [number, number][] = [];
  if (sc.hasLoads) {
    // efficiency spans [min possible, 1]; map to [1, 0]
    const worstEff = 1 / anisotropicFactor(1, sc.layerRatio);
    terms.push([w.strength, Math.min(1, Math.max(0, (1 - m.strengthEfficiency) / (1 - worstEff || 1)))]);
  }
  terms.push([w.support, sc.maxSupport > 0 ? m.supportVolume / sc.maxSupport : 0]);
  const hr = sc.maxHeight - sc.minHeight;
  terms.push([w.height, hr > 1e-9 ? (m.height - sc.minHeight) / hr : 0]);
  terms.push([w.adhesion, sc.maxContact > 0 ? 1 - m.contactArea / sc.maxContact : 0]);
  let num = 0, den = 0;
  for (const [weight, v] of terms) { num += weight * v; den += weight; }
  return den > 0 ? num / den : 0;
}

const angleBetween = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, Math.max(-1, dot(a, b))));

export function optimize(
  positions: Float32Array,
  loads: Load[],
  fixtures: Fixture[],
  settings: OptimizerSettings,
  onProgress?: (fraction: number) => void,
  resultCount = 5,
): OptimizeResult {
  const t0 = performance.now();
  const full = prepareMesh(positions);
  const fast = subsampleMesh(full, 40000);
  const stresses = loadStresses(loads, fixtures, full);

  const snapTargets: Vec3[] = [
    [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0],
    ...flatFaceCandidates(full),
  ];
  const dirs: Vec3[] = [...snapTargets, ...fibonacciSphere(settings.samples)];

  // 1) Global sweep on the (possibly subsampled) mesh.
  const sweep = dirs.map((up, i) => {
    if (onProgress && i % 50 === 0) onProgress((0.7 * i) / dirs.length);
    return { up, m: evaluate(fast, up, stresses, settings) };
  });
  const sc: Scale = {
    maxSupport: Math.max(...sweep.map((s) => s.m.supportVolume)),
    minHeight: Math.min(...sweep.map((s) => s.m.height)),
    maxHeight: Math.max(...sweep.map((s) => s.m.height)),
    maxContact: Math.max(...sweep.map((s) => s.m.contactArea)),
    hasLoads: loads.length > 0,
    layerRatio: settings.layerStrengthRatio,
  };
  const scored = sweep.map((s) => ({ ...s, score: combinedScore(s.m, sc, settings) }));
  scored.sort((a, b) => a.score - b.score);

  // 2) Keep distinct seeds and refine each with a shrinking pattern search.
  const seeds: typeof scored = [];
  for (const s of scored) {
    if (seeds.every((k) => angleBetween(k.up, s.up) > (12 * Math.PI) / 180)) seeds.push(s);
    if (seeds.length >= resultCount * 2) break;
  }
  const refined = seeds.map((seed, si) => {
    onProgress?.(0.7 + (0.25 * si) / seeds.length);
    let best = seed;
    for (const stepDeg of [6, 3, 1.5, 0.75]) {
      const step = (stepDeg * Math.PI) / 180;
      let improved = true;
      while (improved) {
        improved = false;
        const p = perpendicular(best.up);
        for (let k = 0; k < 8; k++) {
          const axis = rotateAround(p, best.up, (k * Math.PI) / 4);
          const up = normalize(rotateAround(best.up, axis, step));
          const m = evaluate(fast, up, stresses, settings);
          const score = combinedScore(m, sc, settings);
          if (score < best.score - 1e-6) { best = { up, m, score }; improved = true; }
        }
      }
    }
    // Prefer a "clean" orientation (flat face down / axis aligned) within a few
    // degrees if it is practically as good — easier to reproduce in a slicer.
    for (const target of snapTargets) {
      if (angleBetween(target, best.up) > (5 * Math.PI) / 180) continue;
      const m = evaluate(fast, target, stresses, settings);
      const score = combinedScore(m, sc, settings);
      if (score <= best.score + 0.01) { best = { up: target, m, score }; break; }
    }
    return best;
  });

  // 3) Exact re-evaluation on the full mesh, then de-duplicate.
  const finals = refined.map((r) => {
    const m = evaluate(full, r.up, stresses, settings);
    return { up: r.up, m, score: combinedScore(m, sc, settings) };
  });
  finals.sort((a, b) => a.score - b.score);
  const out: Candidate[] = [];
  for (const f of finals) {
    if (out.every((o) => angleBetween(o.up, f.up) > (10 * Math.PI) / 180)) {
      out.push({ up: f.up, score: f.score, metrics: f.m, rotation: rotationForUp(f.up) });
    }
    if (out.length >= resultCount) break;
  }
  onProgress?.(1);
  return { candidates: out, evaluated: dirs.length, elapsedMs: performance.now() - t0 };
}

/** Face classes for display: 0 = normal, 1 = needs support, 2 = on the build plate. */
export function classifyFaces(mesh: PreparedMesh, upIn: Vec3, overhangAngleDeg: number): Uint8Array {
  const up = normalize(upIn);
  const P = mesh.positions;
  let minH = Infinity;
  for (let i = 0; i < P.length; i += 3) minH = Math.min(minH, P[i] * up[0] + P[i + 1] * up[1] + P[i + 2] * up[2]);
  const tol = Math.max(0.05, mesh.diagonal * 2e-3);
  const limit = -Math.sin((overhangAngleDeg * Math.PI) / 180);
  const out = new Uint8Array(mesh.triCount);
  for (let t = 0; t < mesh.triCount; t++) {
    const c = mesh.normals[t * 3] * up[0] + mesh.normals[t * 3 + 1] * up[1] + mesh.normals[t * 3 + 2] * up[2];
    if (c >= limit) continue;
    const above = mesh.centroids[t * 3] * up[0] + mesh.centroids[t * 3 + 1] * up[1] + mesh.centroids[t * 3 + 2] * up[2] - minH;
    out[t] = above <= tol ? (c < -0.985 && maxVertexHeight(mesh.positions, t, up) - minH <= tol ? 2 : 0) : 1;
  }
  return out;
}
