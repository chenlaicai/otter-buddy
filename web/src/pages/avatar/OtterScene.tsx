import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { automaticBlink, gestureDuration, gestureProgress, type AvatarGesture } from './avatar-motion'
import { tuneAvatarMaterial } from './fur-material'

type Props = {
  gesture: AvatarGesture
  gestureKey: number
  mood: 'idle' | 'curious'
  reducedMotion: boolean
  onReady: () => void
}

/** Imperative Three.js lifecycle stays behind React's component boundary. */
export function OtterScene({ gesture, gestureKey, mood, reducedMotion, onReady }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const liveRef = useRef({ gesture, mood, reducedMotion, onReady })
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(true)
  const startedRef = useRef<{ key: number; at: number } | null>(null)
  const gestureKeyRef = useRef(gestureKey)

  useEffect(() => {
    if (gestureKey > 0) startedRef.current = { key: gestureKey, at: performance.now() }
    gestureKeyRef.current = gestureKey
  }, [gestureKey])

  useEffect(() => {
    liveRef.current = { gesture, mood, reducedMotion, onReady }
  }, [gesture, mood, reducedMotion, onReady])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let frame = 0
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
    } catch {
      setError(true)
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 0.92
    renderer.shadowMap.enabled = false
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.domElement.setAttribute('aria-label', '可拖动旋转的 3D 大獭')
    renderer.domElement.setAttribute('role', 'img')
    renderer.domElement.style.touchAction = 'pan-y'
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(33, 1, 0.01, 100)
    camera.position.set(0.35, 0.6, 7.5)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 0.35, 0)
    controls.enableZoom = false
    controls.enablePan = false
    controls.minPolarAngle = Math.PI * 0.28
    controls.maxPolarAngle = Math.PI * 0.65
    controls.enableDamping = true
    controls.dampingFactor = 0.065
    controls.rotateSpeed = 0.65
    controls.update()

    const environment = new RoomEnvironment()
    const pmrem = new THREE.PMREMGenerator(renderer)
    const environmentMap = pmrem.fromScene(environment, 0.04)
    scene.environment = environmentMap.texture
    scene.environmentIntensity = 0.65
    environment.dispose()
    pmrem.dispose()

    const key = new THREE.DirectionalLight('#fff2df', 2.6)
    key.position.set(-3, 5, 5)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.normalBias = 0.015
    key.shadow.camera.left = -3
    key.shadow.camera.right = 3
    key.shadow.camera.top = 3
    key.shadow.camera.bottom = -3
    scene.add(key)
    const rim = new THREE.DirectionalLight('#c4e2ec', 0.9)
    rim.position.set(3, 2, -3)
    scene.add(rim)
    scene.add(new THREE.HemisphereLight('#fffaf2', '#7f7162', 1.1))

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.ShadowMaterial({ color: '#53493d', opacity: 0.16 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.y = -1.65
    floor.receiveShadow = true
    scene.add(floor)

    let head: THREE.Object3D | undefined
    let eyes: THREE.Object3D[] = []
    let waveArm: THREE.Object3D | undefined
    let waveArmRest: THREE.Vector3 | undefined
    let avatar: THREE.Group | undefined
    let avatarRestY = 0
    const ready = () => {
      if (!disposed) {
        setLoading(false)
        liveRef.current.onReady()
      }
    }
    const loader = new GLTFLoader()
    loader.load('/avatars/otter-3d.glb', (gltf) => {
      if (disposed) return
      avatar = gltf.scene
      // Why: the source uses a toy-sized unit; normalize the GLB once so the
      // camera/lights use stable scene units, not Blender's millimetre scale.
      const bounds = new THREE.Box3().setFromObject(avatar)
      const size = bounds.getSize(new THREE.Vector3())
      const center = bounds.getCenter(new THREE.Vector3())
      avatar.scale.multiplyScalar(3.15 / size.y)
      avatar.position.sub(center.multiplyScalar(avatar.scale.x))
      avatarRestY = avatar.position.y
      avatar.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.castShadow = true
          node.receiveShadow = true
          // Local-space short fibres and a restrained eye catchlight add
          // texture without external images or a return to glassy eyes.
          tuneAvatarMaterial(node)
        }
      })
      // s3d exports the joint itself as a named empty node above its geometry.
      head = avatar.getObjectByName('nod')
      eyes = ['eye_l', 'eye_r'].map(name => avatar!.getObjectByName(name)).filter((x): x is THREE.Object3D => !!x)
      const paw = avatar.getObjectByName('paw_r')
      if (paw) {
        // GLB 爪是叶子网格：另建肩部父节点，而非操作不存在的 children。
        // pivot 用源毫米尺度；GLB 已由 Blender 转为 Y-up。
        const pivot = new THREE.Vector3(0.78, -1.03, 0.20)
        waveArm = new THREE.Object3D()
        waveArm.name = 'wave_shoulder'
        waveArm.position.copy(pivot)
        paw.parent!.add(waveArm)
        waveArm.attach(paw)
        waveArmRest = waveArm.position.clone()
      }
      // Why: source Z-up maps to GLB Y-up; the face is on +Z after conversion.
      avatar.rotation.y = -0.12
      scene.add(avatar)
      ready()
    }, undefined, () => {
      if (!disposed) {
        setError(true)
        setLoading(false)
      }
    })

    const resize = () => {
      const { width, height } = host.getBoundingClientRect()
      if (!width || !height) return
      renderer.setSize(width, height)
      camera.aspect = width / height
      // Why: the same sculpture must not crop its ears on a narrow phone.
      camera.position.z = width < 480 ? 8.9 : 8.2
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    const startedAt = performance.now()
    const tick = (now: number) => {
      if (disposed) return
      const live = liveRef.current
      const elapsed = (now - startedAt) / 1000
      const gestureElapsed = startedRef.current ? now - startedRef.current.at : Infinity
      const active = live.gesture && gestureElapsed < gestureDuration(live.gesture) ? live.gesture : null
      const pulse = active ? gestureProgress(gestureElapsed, gestureDuration(active)) : 0
      if (avatar) {
        const breath = live.reducedMotion ? 0 : Math.sin(elapsed * 1.5) * 0.008
        avatar.position.y = avatarRestY + breath
        if (head) {
          const nod = active === 'nod' ? Math.sin(gestureElapsed / 1100 * Math.PI * 4) * pulse * 0.24 : 0
          const helloTilt = active === 'hello' ? pulse * 0.16 : 0
          head.rotation.set(
            (live.reducedMotion ? 0 : nod) + (live.mood === 'curious' ? -0.08 : 0),
            helloTilt + (live.mood === 'curious' ? 0.10 : 0),
            0,
          )
        }
        const blink = active === 'blink' ? pulse : live.reducedMotion ? 0 : automaticBlink(elapsed)
        for (const eye of eyes) eye.scale.set(1, 1, 1 - blink * 0.94)
        if (waveArm && waveArmRest) {
          const waving = active === 'hello' && !live.reducedMotion
          waveArm.rotation.z = waving ? pulse * 1.65 : 0
          // Raise the paw clear of the head and towards the camera. Absolute
          // offsets from the rest transform avoid cumulative animation drift.
          waveArm.position.set(
            waveArmRest.x + (waving ? pulse * 0.28 : 0),
            waveArmRest.y,
            waveArmRest.z + (waving ? pulse * 0.55 : 0),
          )
        }
      }
      controls.update()
      renderer.render(scene, camera)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      controls.dispose()
      environmentMap.dispose()
      const geometries = new Set<THREE.BufferGeometry>()
      const materials = new Set<THREE.Material>()
      scene.traverse(node => {
        if (node instanceof THREE.Mesh) {
          geometries.add(node.geometry)
          for (const mat of Array.isArray(node.material) ? node.material : [node.material]) materials.add(mat)
        }
      })
      geometries.forEach(g => g.dispose())
      materials.forEach(m => m.dispose())
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return (
    <div className="avatar-canvas" ref={hostRef}>
      {error && <div className="avatar-fallback"><img src="/avatars/datu.svg" alt="大獭的 2D 头像" /><p>3D 模型未能加载，先看平面版大獭。</p></div>}
      {loading && !error && <p className="avatar-loading" role="status">正在把大獭带进三维…</p>}
    </div>
  )
}
