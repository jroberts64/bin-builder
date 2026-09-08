import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { buildBin } from './model/geometry'
import { buildBox } from './model/box'
import { buildSkadis } from './model/skadis'
import { buildLitho, orientLithoForPreview, prepareLithoImage } from './model/litho'
import { buildFan, orientFanForPreview, prepareFanImage } from './model/fan'
import { Design, assertNever } from './model/serialize'

interface Props {
  design: Design
  showBuildPlate: boolean
  fitSignal: number
  ready: boolean
}

export default function Viewport({ design, showBuildPlate, fitSignal, ready }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<THREE.Scene>()
  const cameraRef = useRef<THREE.PerspectiveCamera>()
  const controlsRef = useRef<OrbitControls>()
  const rendererRef = useRef<THREE.WebGLRenderer>()
  const partsRef = useRef<THREE.Group>() // 1 mesh (bin), 2 (box+lid) or one per fan blade
  const plateRef = useRef<THREE.Group>()

  // --- One-time scene setup ---
  useEffect(() => {
    const mount = mountRef.current!
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x1a1d23)
    sceneRef.current = scene

    const camera = new THREE.PerspectiveCamera(
      45,
      mount.clientWidth / mount.clientHeight,
      0.1,
      5000,
    )
    camera.position.set(160, 140, 180)
    cameraRef.current = camera

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    mount.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.target.set(0, 15, 0)
    controlsRef.current = controls

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const key = new THREE.DirectionalLight(0xffffff, 1.0)
    key.position.set(120, 200, 100)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.4)
    fill.position.set(-120, 80, -100)
    scene.add(fill)

    let raf = 0
    const animate = () => {
      raf = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const onResize = () => {
      if (!mount) return
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(mount.clientWidth, mount.clientHeight)
    }
    window.addEventListener('resize', onResize)
    const ro = new ResizeObserver(onResize)
    ro.observe(mount)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      ro.disconnect()
      controls.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [])

  // --- Rebuild the part mesh(es) whenever the design changes ---
  // CSG is heavy, so debounce so dragging a slider doesn't rebuild every frame.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !ready) return

    const disposeParts = () => {
      const g = partsRef.current
      if (!g) return
      scene.remove(g)
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose()
          ;(o.material as THREE.Material).dispose()
        }
      })
      partsRef.current = undefined
    }

    const mat = (color: number) =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 })

    const rebuild = () => {
      disposeParts()
      const group = new THREE.Group()
      try {
        switch (design.type) {
          case 'bin':
            group.add(new THREE.Mesh(buildBin(design.bin).geometry, mat(0x4a9eff)))
            break
          case 'box': {
            const { box, lid } = buildBox(design.box)
            group.add(new THREE.Mesh(box, mat(0x4a9eff)))
            // Lid slightly lighter so it's distinguishable in the assembled view.
            group.add(new THREE.Mesh(lid, mat(0x8ec5ff)))
            break
          }
          case 'skadis':
            group.add(new THREE.Mesh(buildSkadis(design.skadis).geometry, mat(0x4a9eff)))
            break
          case 'litho': {
            // Preview in the chosen print orientation, so what you see is what
            // the exported file already is.
            const litho = buildLitho(design.litho).geometry
            group.add(new THREE.Mesh(orientLithoForPreview(litho, design.litho), mat(0x4a9eff)))
            break
          }
          case 'fan': {
            // Either the fan opened out (so the picture across the blades is
            // readable) or the plate layout the export writes.
            const blades = orientFanForPreview(buildFan(design.fan).blades, design.fan)
            // Alternate shades so the blade stack stays legible when assembled.
            blades.forEach((b, i) =>
              group.add(new THREE.Mesh(b, mat(i % 2 ? 0x8ec5ff : 0x4a9eff))),
            )
            break
          }
          default:
            assertNever(design.type)
        }
      } catch (err) {
        console.error('build failed', err)
        return
      }
      scene.add(group)
      partsRef.current = group
    }

    // A relief image (lithophane panel or fan) decodes asynchronously (browser
    // image pipeline); make sure it's in the cache before the synchronous build.
    // `cancelled` guards against a stale decode resolving after the design has
    // already changed again.
    let cancelled = false
    const t = setTimeout(() => {
      const prep =
        design.type === 'litho'
          ? prepareLithoImage(design.litho)
          : design.type === 'fan'
            ? prepareFanImage(design.fan)
            : null
      if (prep) {
        prep.then(
          () => {
            if (!cancelled) rebuild()
          },
          (err) => console.error('relief image failed', err),
        )
      } else {
        rebuild()
      }
    }, 80)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [design, ready])

  // --- Build plate grid ---
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    if (plateRef.current) {
      scene.remove(plateRef.current)
      plateRef.current = undefined
    }
    if (!showBuildPlate) return
    const group = new THREE.Group()
    const size = 600
    const grid = new THREE.GridHelper(size, size / 42, 0x44546a, 0x2c333f)
    group.add(grid)
    scene.add(group)
    plateRef.current = group
  }, [showBuildPlate])

  // --- Fit to view ---
  useEffect(() => {
    const cam = cameraRef.current
    const controls = controlsRef.current
    const parts = partsRef.current
    if (!cam || !controls || !parts) return
    const bbox = new THREE.Box3().setFromObject(parts)
    const center = bbox.getCenter(new THREE.Vector3())
    const sphere = bbox.getBoundingSphere(new THREE.Sphere())
    const dist = sphere.radius / Math.sin((cam.fov * Math.PI) / 360)
    const dir = new THREE.Vector3(0.7, 0.6, 0.8).normalize()
    cam.position.copy(center.clone().add(dir.multiplyScalar(dist * 1.3)))
    controls.target.copy(center)
    controls.update()
  }, [fitSignal])

  return <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
}
