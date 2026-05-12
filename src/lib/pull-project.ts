import * as child_process from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(child_process.execFile);

export async function pullProjectFastForward(pathname: string) {
  await execFile("git", ["pull", "--ff-only"], { cwd: pathname });
}
