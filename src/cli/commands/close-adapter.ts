import type { StorageAdapter } from '../../storage/contract.js'

/** How long a misbehaving adapter.close() may stall the CLI before we move on. */
const CLOSE_DEADLINE_MS = 5_000

/**
 * Close the adapter without trusting it: a close() that rejects is ignored,
 * and one that never settles is abandoned after CLOSE_DEADLINE_MS so main()
 * can settle and the entry point's explicit exit fires. The deadline timer is
 * unref'd — the timer itself must never be what keeps the process alive.
 */
export async function closeAdapter(adapter: StorageAdapter | undefined): Promise<void> {
  if (!adapter?.close) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    adapter.close().catch(() => {}),
    new Promise<void>(resolve => {
      timer = setTimeout(() => {
        console.error(
          `[kyroguard] adapter close() did not finish within ${CLOSE_DEADLINE_MS / 1000}s — exiting anyway.`,
        )
        resolve()
      }, CLOSE_DEADLINE_MS)
      timer.unref?.()
    }),
  ])
  clearTimeout(timer)
}
