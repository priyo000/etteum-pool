const root = new URL("..", import.meta.url).pathname;
const port = process.env.PORT || "1630";
const dashboardPort = process.env.DASHBOARD_PORT || "1631";

function spawnProcess(name: string, command: string[], cwd = root) {
  const proc = Bun.spawn(command, {
    cwd,
    env: {
      ...process.env,
      PORT: port,
      DASHBOARD_PORT: dashboardPort,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const prefix = `[${name}]`;

  void streamWithPrefix(proc.stdout, prefix);
  void streamWithPrefix(proc.stderr, prefix);

  proc.exited.then((code) => {
    if (!shuttingDown) {
      console.error(`${prefix} exited with code ${code}`);
      shutdown(code || 1);
    }
  });

  return proc;
}

async function streamWithPrefix(stream: ReadableStream<Uint8Array>, prefix: string) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim().length > 0) console.log(`${prefix} ${line}`);
    }
  }

  if (buffer.trim().length > 0) console.log(`${prefix} ${buffer}`);
}

let shuttingDown = false;
const children: ReturnType<typeof spawnProcess>[] = [];

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 200).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`\nPool Proxy starting...`);
console.log(`Backend:   http://localhost:${port}`);
console.log(`Dashboard: http://localhost:${dashboardPort}`);
console.log(`API Key:   ${process.env.API_KEY || "pool-proxy-secret-key"}\n`);

children.push(spawnProcess("backend", ["bun", "src/index.ts"]));
children.push(
  spawnProcess("dashboard", [
    "bunx",
    "vite",
    "--host",
    "0.0.0.0",
    "--port",
    dashboardPort,
  ], `${root}/dashboard`)
);

await new Promise(() => {});
