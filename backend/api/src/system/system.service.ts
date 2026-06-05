import { Injectable, Logger } from '@nestjs/common';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

// Hard-coded paths — match what the installer + deploy scripts set up.
// Keeping these as constants (not env vars) so a tampered .env can't
// point the update script at an arbitrary location.
const APP_DIR = '/opt/recon';
const UPDATE_SCRIPT = path.join(APP_DIR, 'deploy', 'update.sh');
const LOG_FILE = '/var/log/recon/update.log';
const LOCK_FILE = '/tmp/recon-update.lock';

export interface VersionInfo {
  // Local — what's running right now.
  currentSha: string | null;
  currentShortSha: string | null;
  currentCommitMessage: string | null;
  currentCommitDate: string | null;
  // Remote — what's on origin/main. Populated by checkForUpdates().
  remoteSha: string | null;
  remoteShortSha: string | null;
  remoteCommitMessage: string | null;
  remoteCommitDate: string | null;
  updateAvailable: boolean;
}

@Injectable()
export class SystemService {
  private readonly logger = new Logger(SystemService.name);

  // Get the running version. Used by the admin page to show "you are
  // on <sha>" and (after a fetch) "<new sha> is available".
  // `fetchRemote=true` runs `git fetch` first to compare against the
  // latest origin/main; expensive (network call) so the UI calls this
  // explicitly when the user clicks "Check for updates".
  async getVersion(fetchRemote: boolean): Promise<VersionInfo> {
    const opts = { cwd: APP_DIR };
    let currentSha: string | null = null;
    let currentShortSha: string | null = null;
    let currentCommitMessage: string | null = null;
    let currentCommitDate: string | null = null;
    let remoteSha: string | null = null;
    let remoteShortSha: string | null = null;
    let remoteCommitMessage: string | null = null;
    let remoteCommitDate: string | null = null;

    try {
      const { stdout: sha } = await execAsync('git rev-parse HEAD', opts);
      currentSha = sha.trim();
      currentShortSha = currentSha.slice(0, 7);
      const { stdout: msg } = await execAsync(
        'git log -1 --pretty=%s',
        opts,
      );
      currentCommitMessage = msg.trim();
      const { stdout: dt } = await execAsync(
        'git log -1 --pretty=%cI',
        opts,
      );
      currentCommitDate = dt.trim();
    } catch (err) {
      this.logger.warn(`getVersion: local git lookup failed: ${(err as Error).message}`);
    }

    if (fetchRemote) {
      try {
        // Capped to 15s — if the network's flaky we don't want the
        // admin page hanging. Errors fall through to a null remoteSha
        // which the UI displays as "couldn't reach GitHub".
        await execAsync('git fetch origin --quiet', {
          ...opts,
          timeout: 15000,
        });
        const { stdout: rsha } = await execAsync(
          'git rev-parse origin/main',
          opts,
        );
        remoteSha = rsha.trim();
        remoteShortSha = remoteSha.slice(0, 7);
        const { stdout: rmsg } = await execAsync(
          'git log -1 --pretty=%s origin/main',
          opts,
        );
        remoteCommitMessage = rmsg.trim();
        const { stdout: rdt } = await execAsync(
          'git log -1 --pretty=%cI origin/main',
          opts,
        );
        remoteCommitDate = rdt.trim();
      } catch (err) {
        this.logger.warn(
          `getVersion: remote git lookup failed: ${(err as Error).message}`,
        );
      }
    }

    return {
      currentSha,
      currentShortSha,
      currentCommitMessage,
      currentCommitDate,
      remoteSha,
      remoteShortSha,
      remoteCommitMessage,
      remoteCommitDate,
      updateAvailable: Boolean(
        currentSha && remoteSha && currentSha !== remoteSha,
      ),
    };
  }

  // Trigger an update. Spawns the shell script DETACHED so it survives
  // the pm2 restart at the end (otherwise the API killing itself would
  // also kill the script mid-way).
  startUpdate(): { started: boolean; reason?: string } {
    // Reject if an update is already in flight — the script's lock
    // file is the source of truth here.
    if (fs.existsSync(LOCK_FILE)) {
      return { started: false, reason: 'Another update is already running.' };
    }

    if (!fs.existsSync(UPDATE_SCRIPT)) {
      return {
        started: false,
        reason: `Update script not found at ${UPDATE_SCRIPT}`,
      };
    }

    this.logger.log('Admin triggered in-app update — spawning detached script');

    // detached + stdio:ignore + unref() = "true fire-and-forget". The
    // child becomes its own process group leader, so when systemd
    // SIGTERMs the API process (via pm2 restart all), the child is NOT
    // included in the signal fan-out.
    const child = spawn('bash', [UPDATE_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      cwd: APP_DIR,
    });
    child.unref();

    return { started: true };
  }

  // Return whether an update is currently running and the tail of the
  // log. Used by the UI to show progress (it polls every few seconds).
  getStatus(): {
    running: boolean;
    logTail: string[];
    logTruncated: boolean;
  } {
    const running = fs.existsSync(LOCK_FILE);
    let logTail: string[] = [];
    let logTruncated = false;
    if (fs.existsSync(LOG_FILE)) {
      try {
        const stat = fs.statSync(LOG_FILE);
        // Read only the tail to avoid blowing the response up if the
        // log has grown over many updates. 64 KB ≈ a few hundred lines
        // which is enough for one update run.
        const TAIL_BYTES = 64 * 1024;
        const start = Math.max(0, stat.size - TAIL_BYTES);
        logTruncated = start > 0;
        const fd = fs.openSync(LOG_FILE, 'r');
        const buf = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        logTail = buf
          .toString('utf8')
          .split('\n')
          // Drop the first partial line when we sliced into the middle
          // of one — it's almost certainly cut off.
          .slice(logTruncated ? 1 : 0)
          // Cap at 400 lines for the UI; more than that is useless.
          .slice(-400);
      } catch (err) {
        this.logger.warn(`getStatus: log read failed: ${(err as Error).message}`);
      }
    }
    return { running, logTail, logTruncated };
  }
}
