import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { spawn } from 'child_process';
import { openSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

async function run(): Promise<void> {
  try {
    const port = core.getInput('port', { required: true });
    const apiKey = core.getInput('api-key', { required: true });
    const subdomain = core.getInput('subdomain');
    const cliVersion = core.getInput('cli-version') || 'latest';
    const apiUrl = core.getInput('api-url');
    const readyTimeoutMs = parseInt(core.getInput('ready-timeout-ms') || '30000', 10);

    if (!/^\d+$/.test(port) || parseInt(port, 10) < 1 || parseInt(port, 10) > 65535) {
      throw new Error(`Invalid port: ${port}`);
    }
    if (!apiKey.startsWith('whr_')) {
      throw new Error('api-key must be a Hookbase API key starting with "whr_".');
    }

    core.info(`Installing @hookbase/cli@${cliVersion}...`);
    await exec.exec('npm', ['install', '-g', `@hookbase/cli@${cliVersion}`], {
      silent: true,
    });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOOKBASE_API_KEY: apiKey,
    };
    if (apiUrl) env.HOOKBASE_API_URL = apiUrl;

    const args = ['tunnels', 'start', port, '--json'];
    if (subdomain) args.push('--subdomain', subdomain);

    // Redirect CLI stdio to a log file rather than piping back to this
    // process. Once the action step exits, the CLI continues running with
    // its file descriptors pointing at a real file — no kernel-pipe buffer
    // can fill up and block its event loop, which would cause the WebSocket
    // to stall and the tunnel to be torn down by Cloudflare.
    const logPath = join(tmpdir(), `hookbase-tunnel-${port}-${Date.now()}.log`);
    core.saveState('tunnel-log', logPath);
    const logFd = openSync(logPath, 'a');

    core.info(`Starting tunnel on port ${port} (log: ${logPath})...`);
    const child = spawn('hookbase', args, {
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });

    if (!child.pid) {
      throw new Error('Failed to spawn hookbase process.');
    }
    core.saveState('tunnel-pid', String(child.pid));

    const tunnelUrl = await waitForConnection(child, logPath, readyTimeoutMs);

    core.setOutput('tunnel-url', tunnelUrl);
    core.exportVariable('HOOKBASE_TUNNEL_URL', tunnelUrl);
    core.info(`Tunnel ready: ${tunnelUrl}`);

    child.unref();
    process.exit(0);
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function waitForConnection(
  child: ReturnType<typeof spawn>,
  logPath: string,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let createdUrl: string | null = null;
    let lastSize = 0;
    let settled = false;

    const settleResolve = (url: string) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      child.removeAllListeners('exit');
      child.removeAllListeners('error');
      resolve(url);
    };
    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      child.removeAllListeners('exit');
      child.removeAllListeners('error');
      reject(err);
    };

    const timer = setTimeout(() => {
      settleReject(
        new Error(
          `Tunnel did not become ready within ${timeoutMs}ms. ` +
            (createdUrl ? `Tunnel was created (${createdUrl}) but never connected.` : '')
        )
      );
    }, timeoutMs);

    const poll = setInterval(() => {
      if (!existsSync(logPath)) return;
      let contents: string;
      try {
        contents = readFileSync(logPath, 'utf8');
      } catch {
        return;
      }
      if (contents.length === lastSize) return;
      lastSize = contents.length;
      const lines = contents.split('\n');
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.event === 'tunnel.created' && typeof parsed.tunnelUrl === 'string') {
            createdUrl = parsed.tunnelUrl;
          }
          if (parsed.event === 'tunnel.connected' && typeof parsed.tunnelUrl === 'string') {
            settleResolve(parsed.tunnelUrl);
            return;
          }
        } catch {
          // ignore non-JSON lines
        }
      }
    }, 100);

    child.on('exit', (code, signal) => {
      settleReject(
        new Error(
          `hookbase exited unexpectedly (code=${code}, signal=${signal}) before tunnel was ready.`
        )
      );
    });
    child.on('error', (err) => {
      settleReject(err);
    });
  });
}

run();
