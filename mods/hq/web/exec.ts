// Runs a program with an argv array (never through a shell) and collects its output.

export type Ran = { code: number; stdout: string; stderr: string }

// The program runs in its own process group. On timeout the whole group is killed and the call returns at once: a
// descendant that keeps the pipes open must not keep the caller waiting.
export async function run(argv: string[], env: Record<string, string | undefined>, timeoutMs = 15_000): Promise<Ran> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const proc = Bun.spawn(argv, { env: env as Record<string, string>, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', detached: true })
    const timedOut = new Promise<Ran>(resolve => {
      timer = setTimeout(() => {
        try {
          process.kill(-proc.pid, 'SIGKILL')
        } catch {
          proc.kill()
        }
        resolve({ code: 124, stdout: '', stderr: `timed out after ${timeoutMs} ms` })
      }, timeoutMs)
    })
    const finished = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(([stdout, stderr, code]) => ({ code, stdout, stderr }))
    finished.catch(() => undefined)

    return await Promise.race([finished, timedOut])
  } catch (failure) {
    return { code: 127, stdout: '', stderr: String(failure) }
  } finally {
    clearTimeout(timer)
  }
}
