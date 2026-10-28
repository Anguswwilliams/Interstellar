import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(root, "tor", "compose.npm.yml");
const projectArgs = ["compose", "--project-name", "interstellar-local", "--file", composeFile];
const managedTor = !process.env.TOR_SOCKS_HOST?.trim();

let activeChild = null;
let stopSignal = null;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd: root, stdio: "inherit", ...options });
    } catch (error) {
      reject(error);
      return;
    }

    activeChild = child;
    child.once("error", error => {
      activeChild = null;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      activeChild = null;
      resolve({ code, signal });
    });
  });
}

function handleSignal(signal) {
  stopSignal ??= signal;
  activeChild?.kill(signal);
}

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

async function runDocker(args) {
  try {
    return await run("docker", [...projectArgs, ...args]);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Docker is required to start the managed Tor service. Install and start Docker Desktop, or set TOR_SOCKS_HOST to use an existing Tor SOCKS5 service.");
    }
    throw error;
  }
}

async function stopTor() {
  try {
    const result = await runDocker(["stop", "tor"]);
    if (result.code === 0) return true;
    console.error(`Docker Compose failed to stop Tor (exit code ${result.code ?? result.signal}).`);
  } catch (error) {
    console.error(error.message);
  }
  return false;
}

async function main() {
  let torMayBeRunning = false;
  let exitCode = 0;

  try {
    if (managedTor) {
      const result = await runDocker(["up", "--build", "--wait", "--wait-timeout", "180", "--detach", "tor"]);
      torMayBeRunning = true;
      if (result.code !== 0 && !stopSignal) {
        exitCode = result.code ?? 1;
        throw new Error(`Docker Compose failed to start Tor (exit code ${exitCode}).`);
      }

      if (stopSignal) {
        exitCode = stopSignal === "SIGINT" ? 130 : 143;
      } else {
        console.log("Tor is ready; starting Interstellar with Tor SOCKS5 enabled.");

        const serverEnv = { ...process.env, TOR_SOCKS_HOST: "127.0.0.1", TOR_SOCKS_PORT: process.env.TOR_SOCKS_PORT || "9050" };
        const server = await run(process.execPath, [path.join(root, "src", "server.js")], { env: serverEnv });
        exitCode = server.code ?? (server.signal === "SIGINT" ? 130 : server.signal === "SIGTERM" ? 143 : 1);
      }
    } else {
      const server = await run(process.execPath, [path.join(root, "src", "server.js")]);
      exitCode = server.code ?? (server.signal === "SIGINT" ? 130 : server.signal === "SIGTERM" ? 143 : 1);
    }
  } catch (error) {
    console.error(error.message);
    exitCode ||= 1;
  } finally {
    if (torMayBeRunning) {
      const stopped = await stopTor();
      if (!stopped && exitCode === 0) exitCode = 1;
    }
  }

  process.exitCode = exitCode;
}

main();
