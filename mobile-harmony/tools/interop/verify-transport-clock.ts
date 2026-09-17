/*
 * Deterministic timer queue, so a harness and the reference implementation it is
 * compared against see the same clock.
 */
export class FakeClock {
  now = 0
  private timers: { id: number; at: number; callback: () => void }[] = []
  private nextId = 1

  set = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++
    this.timers.push({ id, at: this.now + Math.max(0, delayMs), callback })
    return id
  }

  clear = (id: number): void => {
    this.timers = this.timers.filter((timer) => timer.id !== id)
  }

  /** Runs every timer due within `ms`, in firing order, advancing `now`. */
  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)
      if (due.length === 0) {break}
      const next = due[0]
      this.timers = this.timers.filter((timer) => timer.id !== next.id)
      this.now = Math.max(this.now, next.at)
      next.callback()
    }
    this.now = target
  }
}
