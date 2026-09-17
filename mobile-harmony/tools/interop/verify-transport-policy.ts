/*
 * The reconnect schedule and the liveness watchdog — the two policies that decide
 * when the client re-dials or gives up.
 *
 * Split out of `verify-transport-interop.ts`; the entry point runs every module
 * so the assertions still report through one counters and one summary.
 */
import { check, section, jsonEqual } from './harness'
import { ReconnectSchedule } from '../../entry/src/main/ets/core/rpc/ReconnectSchedule.ets'
import { LivenessWatchdog } from '../../entry/src/main/ets/core/rpc/LivenessWatchdog.ets'
import { RPC_RECONNECT_ATTEMPT_LIMIT } from '../../../mobile/src/transport/rpc-client-reconnect-schedule'
import { RpcSessionLivenessWatchdog } from '../../../mobile/src/transport/rpc-session-liveness-watchdog'
import { FakeClock } from './verify-transport-clock'

export function runPolicySections(): void {
  // ---------------------------------------------------------------------------
  // 18. Reconnect schedule
  // ---------------------------------------------------------------------------

  section('18. reconnect schedule')

  {
    check('attempt limit constant matches', RPC_RECONNECT_ATTEMPT_LIMIT === 12)

    const make = () => {
      const clock = new FakeClock()
      const opened: number[] = []
      const rejections: string[] = []
      const schedule = new ReconnectSchedule({
        openConnection: () => opened.push(clock.now),
        rejectConnectWaiters: (reason) => rejections.push(reason),
        onScheduled: () => undefined,
        setTimer: clock.set,
        clearTimer: clock.clear
      })
      return { clock, opened, rejections, schedule }
    }

    {
      const { clock, opened, schedule } = make()
      const expectedDelays = [500, 1000, 2000, 4000, 8000, 15000, 30000, 60000, 60000]
      let elapsed = 0
      for (let i = 0; i < expectedDelays.length; i++) {
        schedule.schedule()
        clock.advance(expectedDelays[i])
        elapsed += expectedDelays[i]
        check(`reconnect #${i} fired at the cumulative delay`, opened[i] === elapsed, `${opened[i]} vs ${elapsed}`)
        check(`reconnect #${i} attempt counter`, schedule.getAttempt() === i + 1, String(schedule.getAttempt()))
      }
      schedule.authenticated()
      check('authentication resets the attempt counter', schedule.getAttempt() === 0)
    }

    // Past the attempt limit the schedule must switch to a slow trickle and stop
    // promising a connection to anyone waiting on it.
    {
      const { clock, rejections, schedule } = make()
      for (let i = 0; i < RPC_RECONNECT_ATTEMPT_LIMIT; i++) {
        schedule.schedule()
        clock.advance(60000)
      }
      check('no rejection before the limit', rejections.length === 0, String(rejections.length))
      schedule.schedule()
      check('trickle reconnect rejects waiters', rejections.length === 1 && rejections[0] === 'Connection retry limit reached', JSON.stringify(rejections))
      check('trickle does not advance the attempt counter', schedule.getAttempt() === RPC_RECONNECT_ATTEMPT_LIMIT, String(schedule.getAttempt()))
      schedule.cancel()
    }

    // redialNow reconnects immediately and can restart the backoff.
    {
      const { clock, opened, schedule } = make()
      schedule.schedule()
      clock.advance(500)
      check('one reconnect before the redial', opened.length === 1)
      schedule.redialNow(true)
      check('redialNow opens immediately', opened.length === 2 && opened[1] === clock.now)
      check('redialNow resets attempts', schedule.getAttempt() === 0)
      schedule.schedule()
      clock.advance(500)
      check('backoff restarts from the shortest delay', opened.length === 3 && opened[2] === clock.now)
      schedule.cancel()
      check('cancel clears the timer', !schedule.hasTimer())
    }

    // redialNow without resetting keeps the counter, so a broken link cannot spin.
    {
      const { clock, opened, schedule } = make()
      schedule.schedule()
      clock.advance(500)
      schedule.redialNow(false)
      check('redialNow keeps the attempt counter when asked', schedule.getAttempt() === 1, String(schedule.getAttempt()))
      schedule.schedule()
      clock.advance(1000)
      check('the next delay is the second step', opened.length === 3, String(opened.length))
      schedule.cancel()
    }
  }

  // ---------------------------------------------------------------------------
  // 19. Liveness watchdog — parity against the reference watchdog
  // ---------------------------------------------------------------------------

  section('19. liveness watchdog')

  {
    // The reference watchdog logs on every tolerated miss, which would drown the
    // summary; its behaviour is what is under test, not its logging.
    const realLog = console.log
    console.log = () => undefined

    type ProbeLog = {
      probes: number
      terminated: string[]
      timeouts: string[]
    }

    const makeWatchdogs = (sendable: boolean) => {
      const clock = new FakeClock()
      const clockRef = new FakeClock()
      const ourLog: ProbeLog = { probes: 0, terminated: [], timeouts: [] }
      const refLog: ProbeLog = { probes: 0, terminated: [], timeouts: [] }
      const ours = new LivenessWatchdog({
        transport: 'direct',
        sendProbe: () => {
          ourLog.probes++
          return sendable
        },
        terminate: () => ourLog.terminated.push('t'),
        onTimeout: (evidence) => ourLog.timeouts.push(evidence.reason),
        idleProbeMs: 20_000,
        probeTimeoutMs: 8_000,
        missedProbeLimit: 3,
        now: () => clock.now,
        setTimer: clock.set,
        clearTimer: clock.clear
      })
      const reference = new RpcSessionLivenessWatchdog({
        transport: 'direct',
        sendProbe: () => {
          refLog.probes++
          return sendable
        },
        terminate: () => refLog.terminated.push('t'),
        onTimeout: (evidence) => refLog.timeouts.push(evidence.reason),
        now: () => clockRef.now,
        setTimer: clockRef.set,
        clearTimer: clockRef.clear
      })
      return { clock, clockRef, ours, reference, ourLog, refLog }
    }

    // Idle for the whole window, then let every probe time out.
    {
      const w = makeWatchdogs(true)
      const identity = { id: 1 }
      w.ours.start(identity)
      w.reference.start(identity)

      w.clock.advance(20_000)
      w.clockRef.advance(20_000)
      check('one idle probe fires (ours)', w.ourLog.probes === 1, String(w.ourLog.probes))
      check('one idle probe fires (reference)', w.refLog.probes === 1, String(w.refLog.probes))

      for (let i = 0; i < 4; i++) {
        w.clock.advance(8_000)
        w.clockRef.advance(8_000)
      }
      check('probe counts match', w.ourLog.probes === w.refLog.probes, `${w.ourLog.probes} vs ${w.refLog.probes}`)
      check('termination matches', w.ourLog.terminated.length === w.refLog.terminated.length, `${w.ourLog.terminated.length} vs ${w.refLog.terminated.length}`)
      check('timeout reasons match', jsonEqual(w.ourLog.timeouts, w.refLog.timeouts), `${JSON.stringify(w.ourLog.timeouts)} vs ${JSON.stringify(w.refLog.timeouts)}`)
      check('probe-timeout was the reason', w.ourLog.timeouts[0] === 'probe-timeout', String(w.ourLog.timeouts[0]))
    }

    // Inbound traffic keeps resetting the idle timer, so no probe may fire.
    {
      const w = makeWatchdogs(true)
      const identity = { id: 2 }
      w.ours.start(identity)
      w.reference.start(identity)
      for (let i = 0; i < 6; i++) {
        w.clock.advance(5_000)
        w.clockRef.advance(5_000)
        w.ours.noteAuthenticatedInbound(identity)
        w.reference.noteAuthenticatedInbound(identity)
      }
      check('no probe while traffic flows (ours)', w.ourLog.probes === 0, String(w.ourLog.probes))
      check('no probe while traffic flows (reference)', w.refLog.probes === 0, String(w.refLog.probes))
      check('last inbound is tracked (ours)', w.ours.getLastInboundAt() === w.clock.now)
      check('last inbound is tracked (reference)', w.reference.getLastInboundAt() === w.clockRef.now)
    }

    // A single missed probe is tolerated; recovery re-arms a fresh idle window.
    {
      const w = makeWatchdogs(true)
      const identity = { id: 3 }
      w.ours.start(identity)
      w.reference.start(identity)
      w.clock.advance(20_000)
      w.clockRef.advance(20_000)
      w.clock.advance(8_000)
      w.clockRef.advance(8_000)
      check('one missed probe is tolerated (ours)', w.ourLog.terminated.length === 0 && w.ourLog.probes === 2, `${w.ourLog.terminated.length}/${w.ourLog.probes}`)
      check('one missed probe is tolerated (reference)', w.refLog.terminated.length === 0 && w.refLog.probes === 2, `${w.refLog.terminated.length}/${w.refLog.probes}`)
      w.ours.noteAuthenticatedInbound(identity)
      w.reference.noteAuthenticatedInbound(identity)
      w.clock.advance(20_000)
      w.clockRef.advance(20_000)
      check('recovery re-arms a fresh probe (ours)', w.ourLog.probes === 3, String(w.ourLog.probes))
      check('recovery re-arms a fresh probe (reference)', w.refLog.probes === 3, String(w.refLog.probes))
    }

    // A probe that cannot be written terminates immediately, with no timeout wait.
    {
      const w = makeWatchdogs(false)
      const identity = { id: 4 }
      w.ours.start(identity)
      w.reference.start(identity)
      w.clock.advance(20_000)
      w.clockRef.advance(20_000)
      check('an unsendable probe terminates immediately (ours)', w.ourLog.terminated.length === 1, String(w.ourLog.terminated.length))
      check('an unsendable probe terminates immediately (reference)', w.refLog.terminated.length === 1, String(w.refLog.terminated.length))
      check('no retry after a send failure (ours)', w.ourLog.probes === 1, String(w.ourLog.probes))
      check('no retry after a send failure (reference)', w.refLog.probes === 1, String(w.refLog.probes))
      check('a send failure is not reported as a probe timeout (ours)', w.ourLog.timeouts[0] === 'probe-send-failed', String(w.ourLog.timeouts[0]))
    }

    // stop() releases the identity so later events are ignored.
    {
      const w = makeWatchdogs(true)
      const identity = { id: 5 }
      const other = { id: 6 }
      w.ours.start(identity)
      w.reference.start(identity)
      w.ours.stop(identity)
      w.reference.stop(identity)
      w.clock.advance(60_000)
      w.clockRef.advance(60_000)
      check('stop prevents probing (ours)', w.ourLog.probes === 0, String(w.ourLog.probes))
      check('stop prevents probing (reference)', w.refLog.probes === 0, String(w.refLog.probes))
      w.ours.noteAuthenticatedInbound(other)
      w.reference.noteAuthenticatedInbound(other)
      check('stop clears the tracked identity (ours)', w.ours.getLastInboundAt() === 0, String(w.ours.getLastInboundAt()))
      check('stop clears the tracked identity (reference)', w.reference.getLastInboundAt() === 0, String(w.reference.getLastInboundAt()))
    }

    console.log = realLog
  }

}
