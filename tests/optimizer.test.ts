import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  anisotropicFactor,
  classifyFaces,
  evaluate,
  loadStresses,
  optimize,
  prepareMesh,
  rotationForUp,
} from '../src/analysis/optimizer';
import { DEFAULT_SETTINGS, type OptimizerSettings } from '../src/analysis/types';
import type { Vec3 } from '../src/analysis/vec';

function box(x: number, y: number, z: number): Float32Array {
  const g = new THREE.BoxGeometry(x, y, z).toNonIndexed();
  return Float32Array.from(g.getAttribute('position').array);
}

const strengthOnly: OptimizerSettings = {
  ...DEFAULT_SETTINGS,
  weights: { strength: 1, support: 0, height: 0, adhesion: 0 },
  samples: 300,
};

describe('prepareMesh', () => {
  it('computes area and volume of a box', () => {
    const m = prepareMesh(box(10, 20, 30));
    expect(m.totalArea).toBeCloseTo(2 * (10 * 20 + 20 * 30 + 10 * 30), 3);
    expect(m.volume).toBeCloseTo(6000, 3);
    expect(m.triCount).toBe(12);
  });
});

describe('rotationForUp', () => {
  it.each<Vec3>([[1, 0, 0], [0, -1, 0], [0, 0, -1], [0.3, -0.5, 0.81]])('brings %j to +Z', (...up) => {
    const r = rotationForUp(up);
    const v = new THREE.Vector3(...up).normalize();
    // Extrinsic rotation: X first, then Y (world axes).
    v.applyAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(r.x));
    v.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(r.y));
    expect(v.z).toBeCloseTo(1, 2);
  });
});

describe('anisotropicFactor', () => {
  it('is 1 for in-layer stress and 1/ratio for stress across layers', () => {
    expect(anisotropicFactor(0, 0.5)).toBeCloseTo(1);
    expect(anisotropicFactor(1, 0.5)).toBeCloseTo(2);
    expect(anisotropicFactor(0.7, 0.5)).toBeGreaterThan(1);
  });
});

describe('optimize', () => {
  it('lays a thin plate flat when there are no loads', () => {
    const res = optimize(box(100, 80, 3), [], [], { ...DEFAULT_SETTINGS, samples: 300 });
    const best = res.candidates[0];
    expect(Math.abs(best.up[2])).toBeGreaterThan(0.99);
    expect(best.metrics.height).toBeCloseTo(3, 1);
    expect(best.metrics.overhangArea).toBeLessThan(1);
  });

  it('keeps a cantilever beam lying in the layer plane (bending load)', () => {
    // 100 mm bar along X, clamped at x = -50, pushed down at the free end.
    const positions = box(100, 10, 10);
    const loads = [{ id: 1, point: [50, 0, 5] as Vec3, normal: [0, 0, 1] as Vec3, direction: [0, 0, -1] as Vec3, magnitude: 20 }];
    const fixtures = [{ id: 2, point: [-50, 0, 0] as Vec3 }];
    const res = optimize(positions, loads, fixtures, strengthOnly);
    const best = res.candidates[0];
    expect(Math.abs(best.up[0])).toBeLessThan(0.1); // build axis ⟂ beam axis
    expect(best.metrics.strengthEfficiency).toBeGreaterThan(0.97);
  });

  it('never stands a tension rod upright when strength matters', () => {
    const positions = box(10, 10, 80);
    const loads = [{ id: 1, point: [0, 0, 40] as Vec3, normal: [0, 0, 1] as Vec3, direction: [0, 0, 1] as Vec3, magnitude: 100 }];
    const fixtures = [{ id: 2, point: [0, 0, -40] as Vec3 }];
    const mesh = prepareMesh(positions);
    const st = loadStresses(loads, fixtures, mesh);
    const upright = evaluate(mesh, [0, 0, 1], st, strengthOnly);
    const lying = evaluate(mesh, [1, 0, 0], st, strengthOnly);
    expect(upright.strengthEfficiency).toBeCloseTo(0.5, 2); // 1 / layer ratio
    expect(lying.strengthEfficiency).toBeCloseTo(1, 5);
    const best = optimize(positions, loads, fixtures, strengthOnly).candidates[0];
    expect(Math.abs(best.up[2])).toBeLessThan(0.1);
  });
});

describe('classifyFaces', () => {
  it('marks the bottom as bed contact and nothing as overhang for a box', () => {
    const mesh = prepareMesh(box(10, 10, 10));
    const cls = classifyFaces(mesh, [0, 0, 1], 45);
    expect([...cls].filter((c) => c === 2).length).toBe(2);
    expect([...cls].filter((c) => c === 1).length).toBe(0);
  });

  it('flags the underside of a bridge as overhang', () => {
    // A thin slab floating beside a box needs support under its bottom face.
    const a = box(10, 10, 10);
    const b = new THREE.BoxGeometry(10, 10, 2).toNonIndexed();
    b.translate(20, 0, 10);
    const combined = new Float32Array([...a, ...b.getAttribute('position').array]);
    const mesh = prepareMesh(combined);
    const cls = classifyFaces(mesh, [0, 0, 1], 45);
    expect([...cls].filter((c) => c === 1).length).toBe(2);
  });
});
