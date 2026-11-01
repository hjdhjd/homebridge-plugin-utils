/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * child-process.helpers.mjs: The child-process run the build suites share, which answers how a run ended rather than rejecting when it ends badly.
 */
import { execFile } from "node:child_process";

/**
 * Run `file` with `args` to its exit and answer how it ended, with everything it printed.
 *
 * A non-zero exit is an outcome the caller asserts on rather than a failure of the run itself, so the callback's error is read for its code instead of being
 * rethrown. Each caller shapes the answer for its own assertions, reading the stream its subject reports on.
 *
 * @param {string} file - The program to run.
 * @param {readonly string[]} args - The arguments it is given.
 * @param {import("node:child_process").ExecFileOptions} [options] - What `execFile` takes beside them, such as the working directory or a signal that ends the run.
 *
 * @returns {Promise<{ code: number | string | null, stderr: string, stdout: string }>} The run's code: zero when the run succeeds, its exit status when it exits
 * otherwise, a spawn error code such as `ENOENT` when it never starts, `ABORT_ERR` when the caller's signal aborts it, `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` when its
 * output passes the buffer limit `execFile` holds it to, or `null` when the operating system ends the process with a signal. Beside it, the run's standard error and
 * output.
 */
export async function runToExit(file, args, options = {}) {

  return new Promise((resolve) => {

    execFile(file, args, options, (error, stdout, stderr) => {

      resolve({ code: (error === null) ? 0 : error.code, stderr, stdout });
    });
  });
}
