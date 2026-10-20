import { execFile } from "node:child_process";

/** Run a program and resolve with its trimmed stdout. Rejects with stderr in the message. */
export function run(command: string, args: readonly string[], options: { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string; readonly timeout: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env: options.env ?? process.env, cwd: options.cwd, timeout: options.timeout }, (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout.trim());
      } else {
        const detail = stderr.trim() === "" ? error.message : stderr.trim();
        reject(new Error(`${command} ${args.join(" ")}: ${detail}`, { cause: error }));
      }
    });
  });
}
