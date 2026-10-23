# 3D Print Orientation Optimizer

A browser app that finds the best angle to 3D-print a part. You import it, mark where forces act on it, and it tells you which orientation makes it strongest.

FDM prints are **anisotropic**: the bond between layers is much weaker than the plastic inside a layer, often only 40–70 % as strong. A part that survives a load when printed lying down can snap along a layer line when printed standing up. This app puts your real load cases into the orientation choice, along with support material, print height and bed adhesion.

## Features

- **Import STL or 3MF.** Drag and drop a file or browse for one. Binary and ASCII STL both work, as do multi-object 3MF files. There is also a built-in sample L-bracket.
- **Mark forces.** Click the part where a load acts. Each force has an **optional magnitude in newtons** and a direction: push into the surface, pull away from it, downward (weight), or a custom vector. Arrows are drawn to scale with the magnitude.
- **Mark fixtures.** Click where the part is bolted, clamped or resting. Each force is resisted by the fixture nearest to it.
- **Set priorities.** Sliders control how much weight goes to strength, support material, print height and bed adhesion. Overhang angle and layer-bond ratio can be changed for your material.
- **Get recommendations.** You get the top five orientations. Each shows:
  - the rotation to type into your slicer (**rotate X by α°, then Y by β°**)
  - a strength efficiency score, support area, height and bed contact area
  - a plain-language explanation
- **3D preview.** Click a result to see the part on the build plate in that orientation. Faces that need support are shown in red and faces touching the bed in green.
- **Export.** Download the part already rotated as an STL, ready for the slicer.

## Quick start

```bash
npm install
npm run dev        # open the printed URL (default http://localhost:5173)
```

Other scripts:

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `npm run build`     | Type-check and build a static site into `dist/`     |
| `npm run preview`   | Serve the production build locally                  |
| `npm test`          | Run the optimizer unit tests (Vitest)               |
| `npm run typecheck` | TypeScript check only                               |

`dist/` is fully static, with relative paths, so it can be hosted anywhere (GitHub Pages, Netlify, a USB stick).

## How to use it

1. **Import** your `.stl` / `.3mf` file. Units are assumed to be millimetres.
2. Choose **+ Force** and click each spot where a load is applied. Enter a force in N if you know it. If you don't, the forces are weighted equally.
3. Choose **+ Fixture** and click where the part is held, such as screw holes, clamped faces or the resting surface. *Recommended*: without fixtures, loads are assumed to be resisted at the part's centre.
4. Adjust **Priorities** if needed. Open *Material & printer* to set the overhang limit and layer-bond ratio (PLA ≈ 0.5–0.7, PETG ≈ 0.6–0.8, ABS/ASA ≈ 0.4–0.6, CF-filled ≈ 0.3–0.5).
5. Click **Find best orientation**. Compare the results by clicking them, then either apply the rotation in your slicer or **Download oriented STL**.

Keyboard: `Esc` switches back to *Rotate view*. `Delete` removes the selected force or fixture.

## How the optimizer works

The engine is in `src/analysis/optimizer.ts` and runs in a Web Worker, so the UI stays responsive. For each candidate **up (build) direction** it computes:

| Criterion    | Model |
| ------------ | ----- |
| **Strength** | Each force is turned into a principal stress along the lever arm from its nearest fixture. This covers bending (`σ ≈ 6·F·L / s³`) and axial tension or compression (`σ ≈ F / s²`). Here `s` is an estimated section thickness (`2·volume / surface area`). The stress is then resolved against the layer planes with a Tsai-Hill-style failure index, using your Z/XY strength ratio. The *strength efficiency* is the ideal stress (all loads carried within layers) divided by the actual failure index, so 100 % means no load pulls layers apart. |
| **Support**  | Faces that overhang more than the allowed angle and are not on the bed. Support volume ≈ Σ projected area × height above the bed. |
| **Height**   | Extent along the build direction, which drives print time and wobble risk. |
| **Adhesion** | Area of faces lying flat on the build plate. |

Each metric is normalised and combined using your priority weights. The search runs in four steps:

1. **Global sweep** over about 800 evenly spread directions (Fibonacci sphere), plus the six axis directions and every large flat face placed down.
2. **Local refinement** of the best distinct candidates, using a pattern search that narrows from 6° to 0.75°.
3. **Snapping** to a nearby flat face or axis when that costs (almost) nothing, so the angles are clean and easy to type into a slicer.
4. **Exact re-scoring** on the full mesh. Meshes over 40k triangles are subsampled during the sweep only.

A 400k-triangle model takes about 1 s.

### Limitations

This is a fast **engineering heuristic, not FEA**. It is good for *ranking* orientations, but it does not predict absolute failure loads. Some specific limits:

- Each load uses a single lever arm to its nearest fixture. Complex load paths, stress concentrations at holes or fillets, and buckling are not modelled.
- Wall thickness is a single global estimate for the whole part.
- Overhangs are judged per face, so bridges are treated as overhangs.

## Project structure

```
index.html              UI layout
src/main.ts             UI state, lists, results, export
src/viewer.ts           Three.js scene: build plate, part, force/fixture markers, picking
src/loaders.ts          STL / 3MF import → single centred geometry
src/sample.ts           Built-in sample L-bracket
src/analysis/optimizer.ts  Orientation scoring & search (framework-free)
src/analysis/worker.ts  Web Worker wrapper
src/analysis/types.ts   Shared types and default settings
tests/                  Vitest unit tests for the optimizer
```
