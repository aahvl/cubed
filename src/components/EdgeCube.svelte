<script lang="ts">
  import { T, useTask } from '@threlte/core'
  import { BoxGeometry } from 'three'
  import { createCubeMaterial, type CubeVariant } from '../lib/cubeMaterials'
  import { mouse } from '../lib/useMouseParallax'

  let {
    variant = 0,
    phase = 0,
    position = [0, 0, 0],
    size = 1,
  }: {
    variant?: CubeVariant
    phase?: number
    position?: [number, number, number]
    size?: number
  } = $props()

  const geometry = new BoxGeometry(size, size, size)
  const material = createCubeMaterial(variant)

  let meshEl: any = $state()
  let time = 0

  useTask((delta) => {
    const mesh = meshEl
    if (!mesh) return

    time += delta
    const t = time + phase

    // Breathing scale
    const breath = 1 + Math.sin(t * 1.5) * 0.04
    mesh.scale.setScalar(breath)

    // Mouse parallax (smoothed toward cursor)
    mesh.rotation.y += (mouse.x * 0.5 - mesh.rotation.y) * 0.04
    mesh.rotation.x += (mouse.y * 0.35 - mesh.rotation.x) * 0.04

    // Constant slow spin
    mesh.rotation.z += delta * 0.25
  })
</script>

<T.Mesh bind:ref={meshEl} {geometry} {material} {position} />
