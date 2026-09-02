// Sending a command to the guest and knowing when it is done.
//
// Knowing when a command has finished is the whole difficulty. The serial
// console gives no framing: it echoes what was sent, then whatever the command
// printed, then a prompt, all as one byte stream.
//
// Watching for a prompt character is the obvious approach and it is wrong. While
// the echo is still arriving the tail ends with whatever character has landed
// last, and for one byte that can be a character a prompt ends with. A command
// ending in `; echo rc=$?` ends with `$` at that instant, so a poll landing
// there reads a half-echoed command as a finished one and returns no output at
// all. That is not theoretical; it is what broke a real sync.
//
// So a caller that appends its own marker waits for the marker, which cannot
// appear in what it sent. Only a caller with no marker falls back to the prompt,
// with the two guards in atPrompt.

import { atPrompt } from "./fs.js";

/**
 * Build a `run(command, options)` for a guest.
 *
 * @param {Object} options
 * @param {(text: string) => void} options.send write to the guest's console
 * @param {() => string} options.tail read recent escape-free output
 * @param {() => void} [options.reset] forget output from before this command
 * @param {RegExp} [options.prompt]
 * @param {number} [options.pollMs]
 */
export function makeRunner({ send, tail, reset, prompt, pollMs = 120 }) {
  if (typeof send !== "function") throw new Error("send is required");
  if (typeof tail !== "function") throw new Error("tail is required");

  return async function run(command, options = {}) {
    const { timeoutMs = 300000, until = null } =
      typeof options === "number" ? { timeoutMs: options } : options;

    if (reset) reset();
    send(command + "\n");

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (until ? until(tail()) : atPrompt(tail(), prompt ? { prompt } : undefined)) break;
      if (Date.now() > deadline) {
        throw new Error(`the guest did not finish within ${timeoutMs}ms: ${command}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return tail();
  };
}
