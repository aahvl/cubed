<script lang="ts">
  /**
   * HexagonBackground
   * An interactive hexagon (honeycomb) grid background.
   * Ported to Svelte 5 from animate-ui (author: imskyleen).
   *
   * Usage:
   *   <main class="relative h-screen overflow-hidden">
   *     <HexagonBackground client:load />
   *   </main>
   *   The grid fills its parent and is clipped to it.
   */
  let {
    class: className = '',
    hexagonClass = '',
    hexagonSize = 75,
    hexagonMargin = 3,
    children,
    ...rest
  }: {
    class?: string;
    hexagonClass?: string;
    hexagonSize?: number;
    hexagonMargin?: number;
    children?: import('svelte').Snippet;
    [key: string]: unknown;
  } = $props()

  const hexagonWidth = $derived(hexagonSize)
  const hexagonHeight = $derived(hexagonSize * 1.1)
  const rowPitch = $derived(hexagonSize * 0.8)
  const rowMarginTop = $derived(rowPitch - hexagonHeight)
  const halfStep = $derived((hexagonWidth + hexagonMargin) / 2)

  let containerEl = $state<HTMLDivElement>()
  let rows = $state(0)
  let columns = $state(0)

  function updateGrid() {
    if (!containerEl) return
    const width = containerEl.clientWidth
    const height = containerEl.clientHeight
    columns = Math.ceil(width / (hexagonWidth + hexagonMargin)) + 2
    rows = Math.ceil(height / rowPitch) + 2
  }

  $effect(() => {
    updateGrid()
    if (containerEl) {
      const observer = new ResizeObserver(updateGrid)
      observer.observe(containerEl)
      return () => observer.disconnect()
    }
  })

  const clipPath =
    'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)'
</script>

<div
  bind:this={containerEl}
  data-slot="hexagon-background"
  class="hexagon-background {className}"
  style="--hexagon-margin: {hexagonMargin}px;"
  {...rest}
>
  <div class="hex-grid">
    {#each Array(rows) as _, rowIndex (rowIndex)}
      <div
        class="hex-row"
        style="margin-top: {rowMarginTop}px; margin-left: {rowIndex % 2 === 1
          ? halfStep
          : 0}px;"
      >
        {#each Array(columns) as _, colIndex (colIndex)}
          <div
            class="hexagon {hexagonClass}"
            style="width: {hexagonWidth}px; height: {hexagonHeight}px; margin-left: {hexagonMargin}px; --clip: {clipPath};"
          ></div>
        {/each}
      </div>
    {/each}
  </div>

  {#if children}
    <div class="hex-children">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .hexagon-background {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    /* Container / gap color (light) */
    background-color: #f5f5f5;
  }

  .hex-grid {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }

  .hex-row {
    display: flex;
    width: max-content;
  }

  .hexagon {
    position: relative;
    flex-shrink: 0;
    pointer-events: auto;
    clip-path: var(--clip);
    position: relative;
    transition: transform 250ms cubic-bezier(0.34, 1.56, 0.64, 1);
    will-change: transform;
    z-index: 1;
  }

  .hexagon:hover {
    transform: scale(1.15);
    z-index: 2;
  }

  .hex-children {
    position: relative;
    z-index: 10;
    width: 100%;
    height: 100%;
  }

  /* Outer layer = hexagon border color */
  .hexagon::before {
    content: '';
    position: absolute;
    inset: 0;
    background-color: #e5e5e5;
    transition: background-color 1000ms ease;
  }

  /* Inner layer (inset by the margin) = hexagon fill color */
  .hexagon::after {
    content: '';
    position: absolute;
    inset: var(--hexagon-margin);
    background-color: #fafafa;
    clip-path: var(--clip);
    transition: background-color 1000ms ease;
  }

  .hexagon:hover::before {
    background-color: #737373;
    transition-duration: 0ms;
  }

  .hexagon:hover::after {
    background-color: #e5e5e5;
    transition-duration: 0ms;
  }

  /* Dark mode */
  :global(.dark) .hexagon-background {
    background-color: #0a0a0a;
  }
  :global(.dark) .hexagon::before {
    background-color: #404040;
  }
  :global(.dark) .hexagon::after {
    background-color: #0a0a0a;
  }
  :global(.dark) .hexagon:hover::before {
    background-color: #a3a3a3;
  }
  :global(.dark) .hexagon:hover::after {
    background-color: #262626;
  }
</style>
