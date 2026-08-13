<script lang="ts">
  import { T } from '@threlte/core'
  import EdgeCube from './EdgeCube.svelte'
  import type { CubeVariant } from '../lib/cubeMaterials'

  let {
    side = 'left',
  }: {
    side?: 'left' | 'right'
  } = $props()

  const cubes =
    side === 'left'
      ? [
          { variant: 0 as CubeVariant, y: 1.6, phase: 0, size: 0.95 },
          { variant: 1 as CubeVariant, y: 0, phase: 2.1, size: 0.8 },
          { variant: 2 as CubeVariant, y: -1.6, phase: 4.2, size: 1.1 },
        ]
      : [
          { variant: 3 as CubeVariant, y: 1.6, phase: 1.0, size: 1.05 },
          { variant: 4 as CubeVariant, y: 0, phase: 3.1, size: 0.85 },
          { variant: 5 as CubeVariant, y: -1.6, phase: 5.2, size: 0.9 },
        ]
</script>

<T.AmbientLight intensity={0.6} />
<T.DirectionalLight position={[2, 3, 4]} intensity={0.9} />
<T.DirectionalLight position={[-2, -1, 2]} intensity={0.3} color="#f59e0b" />

{#each cubes as cube (cube.variant)}
  <EdgeCube variant={cube.variant} position={[0, cube.y, 0]} phase={cube.phase} size={cube.size} />
{/each}
