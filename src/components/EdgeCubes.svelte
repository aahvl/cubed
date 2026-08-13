<script lang="ts">
  import { Canvas } from '@threlte/core'
  import { onMount } from 'svelte'
  import EdgeColumn from './EdgeColumn.svelte'
  import { initMouseParallax } from '../lib/useMouseParallax'

  onMount(() => {
    initMouseParallax()
  })
</script>

<div class="pointer-events-none fixed inset-0 z-0 select-none" aria-hidden="true">
  <div
    class="absolute left-2 top-1/2 h-[60vh] w-20 -translate-y-1/2 sm:left-4 sm:w-28 md:left-6 md:w-36"
  >
    <Canvas renderMode="always" shadows={false} dpr={[1, 2]}>
      <EdgeColumn side="left" />
    </Canvas>
  </div>
  <div
    class="absolute right-2 top-1/2 h-[60vh] w-20 -translate-y-1/2 sm:right-4 sm:w-28 md:right-6 md:w-36"
  >
    <Canvas renderMode="always" shadows={false} dpr={[1, 2]}>
      <EdgeColumn side="right" />
    </Canvas>
  </div>
</div>
