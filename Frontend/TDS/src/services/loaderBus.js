// Tiny pub/sub that tracks how many API requests are in flight, so the
// global page loader can show a spinner without every page wiring it up.
let pending = 0
const listeners = new Set()

function emit() {
  listeners.forEach((fn) => fn(pending))
}

export function startRequest() {
  pending += 1
  emit()
}

export function endRequest() {
  pending = Math.max(0, pending - 1)
  emit()
}

export function subscribe(fn) {
  listeners.add(fn)
  fn(pending)
  return () => listeners.delete(fn)
}
