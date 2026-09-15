import * as THREE from 'three'

// Printable screw threads, emitted as a manifold-by-construction mesh.
//
// A thread is a RADIAL HEIGHTFIELD ON A CYLINDER: r(θ,z) = core + tooth(phase),
// where phase = z − (θ/2π)·pitch advances exactly one pitch per turn — which is
// a helix. The tooth profile is periodic in the pitch, so r(θ+2π, z) = r(θ, z)
// and the tube closes seamlessly around the axis. It is the same trick as
// `heightfieldMesh` in `relief.ts`, wrapped round an axis instead of laid over a
// rectangle, and it is emitted directly as a closed indexed mesh: side grid,
// plus a fan cap at each end.
//
// Doing it this way avoids sweeping a profile along a helix, which is where
// hand-rolled thread generators usually produce self-intersecting or
// non-manifold junk that Manifold then refuses.
//
// **Both halves of a pair come from this one function.** The male screw is the
// rod itself; the female thread is the same rod `grow`n radially by `THREAD.FIT`
// and subtracted from the part. Growing the core radius shifts the whole profile
// outward while preserving the helix, so a mating pair has FIT of radial
// clearance everywhere along the engagement.

export const THREAD = {
  // Below roughly a 4mm crest diameter an FDM thread is mostly extrusion width:
  // the teeth are a line or two wide and strip under any real load.
  MIN_MAJOR: 4,
  // Fractions of the half-pitch left FLAT at crest and root. A sharp V crest
  // prints as a ragged single-extrusion knife edge and its matching root traps a
  // void that never fills; truncating both gives a trapezoidal tooth that prints
  // cleanly and carries far more load.
  CREST_FLAT: 0.18,
  ROOT_FLAT: 0.18,
  // Tooth height as a fraction of pitch. ISO is ~0.61×; shallower is better on
  // FDM — fewer, chunkier teeth, and much more tolerant of a fit error.
  DEPTH_RATIO: 0.4,
  // Radial clearance between male and female. 0.2–0.3mm is the printed-thread
  // sweet spot, the same window as the print-in-place hinge: less and the pair
  // welds itself shut, more and it rattles.
  FIT: 0.25,
  SEG: 64, // samples around the axis
  PER_PITCH: 10, // samples along the axis per pitch
}

export interface ThreadSpec {
  majorD: number // crest diameter of the MALE thread
  pitch: number
  depth: number // radial tooth height
}

// A coarse thread for a given crest diameter. Coarse on purpose: a fine pitch at
// these diameters gives teeth an FDM nozzle can't resolve.
export function threadSpec(majorD: number): ThreadSpec {
  const pitch = Math.min(2.5, Math.max(1, majorD / 3.5))
  return { majorD, pitch, depth: pitch * THREAD.DEPTH_RATIO }
}

// A threaded rod along +Z, centred on the axis, spanning z ∈ [z0, z0+length].
//
// `grow` offsets the profile outward (use THREAD.FIT to make the female tool).
// `leadStart`/`leadEnd` taper the tooth to nothing over the last pitch at that
// end: on a male tip that is the lead-in that lets the screw start, and it also
// leaves the end face a clean circle instead of a knife edge. Turn an end's lead
// OFF where it is buried inside another solid, and instead let a bore tool
// OVERSHOOT the opening it is cutting, so the thread reaches full depth right at
// the mouth of the hole.
export function threadedRod(
  spec: ThreadSpec,
  z0: number,
  length: number,
  opts: { grow?: number; leadStart?: boolean; leadEnd?: boolean } = {},
): THREE.BufferGeometry {
  const { pitch, depth } = spec
  const coreR = spec.majorD / 2 - depth + (opts.grow ?? 0)
  const leadStart = opts.leadStart ?? true
  const leadEnd = opts.leadEnd ?? true
  const leadLen = pitch

  const nT = THREAD.SEG
  const nZ = Math.max(2, Math.round((length / pitch) * THREAD.PER_PITCH) + 1)

  const halfP = pitch / 2
  const flank = 1 - THREAD.CREST_FLAT - THREAD.ROOT_FLAT
  // Tooth height at a phase within one pitch: flat crest, straight flank, flat
  // root — symmetric about the crest.
  const tooth = (phase: number): number => {
    const u = Math.min(phase, pitch - phase) / halfP // 0 at crest, 1 at root
    if (u <= THREAD.CREST_FLAT) return depth
    if (u >= 1 - THREAD.ROOT_FLAT) return 0
    return depth * (1 - (u - THREAD.CREST_FLAT) / flank)
  }
  const radius = (theta: number, z: number): number => {
    let phase = (z - (theta / (2 * Math.PI)) * pitch) % pitch
    if (phase < 0) phase += pitch
    let lead = 1
    if (leadStart) lead = Math.min(lead, (z - z0) / leadLen)
    if (leadEnd) lead = Math.min(lead, (z0 + length - z) / leadLen)
    return coreR + tooth(phase) * Math.max(0, Math.min(1, lead))
  }

  const nSide = nT * nZ
  const cBot = nSide
  const cTop = nSide + 1
  const positions = new Float32Array((nSide + 2) * 3)
  for (let j = 0; j < nZ; j++) {
    const z = z0 + (length * j) / (nZ - 1)
    for (let i = 0; i < nT; i++) {
      const th = (2 * Math.PI * i) / nT
      const r = radius(th, z)
      const k = (j * nT + i) * 3
      positions[k] = r * Math.cos(th)
      positions[k + 1] = r * Math.sin(th)
      positions[k + 2] = z
    }
  }
  positions[cBot * 3 + 2] = z0 // caps sit on the axis; x,y stay 0
  positions[cTop * 3 + 2] = z0 + length

  const index = new Uint32Array((nT * (nZ - 1) * 2 + nT * 2) * 3)
  let p = 0
  const tri = (a: number, b: number, c: number) => {
    index[p++] = a
    index[p++] = b
    index[p++] = c
  }
  // Side: wound so (+θ)×(+z) = +r, i.e. outward.
  for (let j = 0; j < nZ - 1; j++) {
    for (let i = 0; i < nT; i++) {
      const i1 = (i + 1) % nT
      const a = j * nT + i
      const b = j * nT + i1
      const c = (j + 1) * nT + i1
      const d = (j + 1) * nT + i
      tri(a, b, c)
      tri(a, c, d)
    }
  }
  // Caps: bottom faces −Z, top faces +Z. Each end ring may vary in radius (an
  // end with its lead off is cut mid-tooth), but it stays star-shaped about the
  // axis, so a centre fan is valid.
  const top = (nZ - 1) * nT
  for (let i = 0; i < nT; i++) {
    const i1 = (i + 1) % nT
    tri(cBot, i1, i)
    tri(cTop, top + i, top + i1)
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setIndex(new THREE.BufferAttribute(index, 1))
  geom.computeVertexNormals()
  return geom
}
