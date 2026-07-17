/**
 * Memory headroom for worker-pool sizing — cgroup-honest on Linux.
 *
 * `os.freemem()` reads /proc/meminfo, which inside a container reports the
 * HOST's (or VM's) memory, not the cgroup's — the same blindness os.cpus()
 * has for cpusets. A resolver pool sized by cores alone OOM-killed a
 * kernel-scale index in a 7GB-capped container (migration plan §7a.1:
 * oom_kill=5, six ~1GB workers at true 8-core concurrency), so pool sizing
 * combines a CPU term with the memory headroom this module reports.
 */

import * as fs from 'fs';
import * as os from 'os';

/** Parse a cgroup value file: numeric bytes, or null for absent/'max'. */
function readCgroupBytes(path: string): number | null {
  try {
    const raw = fs.readFileSync(path, 'utf8').trim();
    if (raw === 'max') return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Available headroom under the cgroup memory limit (v2 then v1), or null
 * when uncontained (no limit, non-Linux, or unreadable). Never throws.
 */
export function cgroupMemoryAvailable(): number | null {
  if (process.platform !== 'linux') return null;
  // v2 unified hierarchy
  const v2Max = readCgroupBytes('/sys/fs/cgroup/memory.max');
  if (v2Max !== null) {
    const current = readCgroupBytes('/sys/fs/cgroup/memory.current') ?? 0;
    return Math.max(0, v2Max - current);
  }
  // v1
  const v1Limit = readCgroupBytes('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  // v1 reports "no limit" as a huge sentinel (~PAGE_COUNTER_MAX); treat
  // anything at or beyond half the address-space-ish range as uncontained.
  if (v1Limit !== null && v1Limit < 2 ** 60) {
    const usage = readCgroupBytes('/sys/fs/cgroup/memory/memory.usage_in_bytes') ?? 0;
    return Math.max(0, v1Limit - usage);
  }
  return null;
}

/**
 * The budget pool sizing divides: the smaller of system free memory and the
 * cgroup headroom (when contained). Conservative by construction — both
 * numbers shrink as the process itself grows.
 */
export function memoryBudgetBytes(): number {
  const free = os.freemem();
  const cgroup = cgroupMemoryAvailable();
  return cgroup === null ? free : Math.min(free, cgroup);
}
