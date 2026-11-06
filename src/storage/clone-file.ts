/**
 * 同卷「写时复制」克隆：不占额外空间，两份互不影响。
 *
 * macOS 上 Node 的 COPYFILE_FICLONE 实际是整份复制（libuv 不调 clonefile，COPYFILE_FICLONE_FORCE 报 ENOSYS，
 * 2026-10-29 实测），只有 /bin/cp -c 走 clonefile(2)；跨卷时 cp 自己退成普通复制。
 * 其他平台 libuv 的 FICLONE 是真的（Linux 走 FICLONE ioctl），照用。
 *
 * 语义同 COPYFILE_EXCL：目标已存在就报 EEXIST，绝不覆盖。
 */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
let seq = 0;

export async function cloneFile(source: string, target: string): Promise<void> {
  if (process.platform !== "darwin") {
    await fs.copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    return;
  }
  // cp 没有「不覆盖」的报错语义：先克隆到同目录的临时名，再用 link 落位（目标已在就 EEXIST）
  const tmp = path.join(path.dirname(target), `.clone-${process.pid}-${++seq}-${path.basename(target)}`);
  try {
    await run("/bin/cp", ["-c", source, tmp]);
    try {
      await fs.link(tmp, target);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOTSUP" && code !== "EPERM") throw e;
      // 不支持硬链接的卷（SMB）：退成带 EXCL 的普通复制
      await fs.copyFile(tmp, target, constants.COPYFILE_EXCL);
    }
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
