export const mouse = { x: 0, y: 0 }

let listenerAttached = false

export function initMouseParallax() {
  if (listenerAttached || typeof window === 'undefined') return
  listenerAttached = true
  window.addEventListener(
    'pointermove',
    (e) => {
      mouse.x = (e.clientX / window.innerWidth) * 2 - 1
      mouse.y = -((e.clientY / window.innerHeight) * 2 - 1)
    },
    { passive: true }
  )
}
