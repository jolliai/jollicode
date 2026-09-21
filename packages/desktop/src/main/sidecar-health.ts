/**
 * HOW LONG THE APP WAITS FOR A REPLACED SIDECAR, AND WHAT IT CONCLUDES WHEN IT RUNS OUT.
 *
 * ⚠ IT IS BOUNDED, BECAUSE WHAT IT WAITS ON IS NOT. `health.wait` polls until the server answers,
 * with no deadline of its own, so awaiting it bare leaves whatever asked for the restart — the
 * `jolli-sign-in` IPC, and with it the onboarding button — hanging forever on a sidecar that never
 * comes up.
 *
 * ⚠ AND IT NEVER THROWS, BECAUSE ITS CALLER IS IN THE MIDDLE OF SOMETHING ELSE. The wait rejects
 * when the process dies first, which would report a sign-in whose credential is already stored as
 * having failed. Both "hang" and "failed" are the wrong answer to a question nobody asked; the
 * honest one is whether the sidecar came back, for the caller to say out loud.
 */
export async function awaitSidecarReady(health: Promise<unknown>, timeoutMs: number) {
  return Promise.race([
    health.then(() => ({ ready: true as const })),
    new Promise<{ ready: false; error?: unknown }>((resolve) =>
      setTimeout(() => resolve({ ready: false }), timeoutMs).unref(),
    ),
  ]).catch((error: unknown) => ({ ready: false as const, error }))
}
