/**
 * Interactive credential setup (run via ./scripts/panelSetup.sh):
 * sets the admin password (hidden input, typed twice), enrolls TOTP (QR in
 * the terminal + otpauth URI), verifies one code, then writes the secrets
 * file atomically with mode 600. Re-running rotates both factors and, via the
 * new `rev`, logs out every existing panel session.
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import QRCode from "qrcode";

import { loadConfig } from "./config.js";
import { hashPassword, newRev, newTotpSecret, otpauthUri, verifyTotp, writeSecrets, type PanelSecrets } from "./secrets.js";

const MIN_PASSWORD = 12;

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error("panelSetup must be run in an interactive terminal"));
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const onData = (d: Buffer): void => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          return resolve(buf);
        }
        if (ch === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          return reject(new Error("aborted"));
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    const cleanup = (): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(q)).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.argv.slice(2));
  console.log(`Panel credential setup\n  secrets file: ${cfg.secretsFile}\n`);
  if (existsSync(cfg.secretsFile)) {
    const a = await ask("Credentials already exist. Replace them (logs out all sessions)? [y/N] ");
    if (a.toLowerCase() !== "y") {
      console.log("Unchanged.");
      return;
    }
  }

  const user = (await ask("Admin username [admin]: ")) || "admin";
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(user)) throw new Error("username: 1–32 chars of letters, digits, _ . -");

  let password = "";
  for (;;) {
    password = await readHidden(`Password (min ${MIN_PASSWORD} chars): `);
    if (password.length < MIN_PASSWORD) {
      console.log(`  too short — use at least ${MIN_PASSWORD} characters (a passphrase is ideal).`);
      continue;
    }
    if ((await readHidden("Repeat password: ")) !== password) {
      console.log("  passwords didn't match, try again.");
      continue;
    }
    break;
  }

  const secret = newTotpSecret();
  const uri = otpauthUri(secret, user, "MC Panel");
  console.log("\nScan this with your authenticator app (Google Authenticator, 1Password, Authy, …):\n");
  console.log(await QRCode.toString(uri, { type: "terminal", small: true, errorCorrectionLevel: "M" }));
  console.log(`Or enter the key manually: ${secret.replace(/(.{4})/g, "$1 ").trim()}`);
  console.log(`otpauth URI: ${uri}\n`);

  for (let attempt = 1; ; attempt++) {
    const code = (await ask("Enter the 6-digit code from the app to confirm: ")).replace(/\s+/g, "");
    if (verifyTotp(secret, code) !== null) break;
    if (attempt >= 5) throw new Error("TOTP verification failed 5 times — nothing was saved. Check the device clock and re-run.");
    console.log("  code didn't match; try again (wait for the next code if it's about to roll over).");
  }

  console.log("Hashing password (scrypt)…");
  const secrets: PanelSecrets = {
    version: 1,
    rev: newRev(),
    user,
    password: await hashPassword(password),
    totp: { secret, digits: 6, period: 30, algorithm: "SHA1" },
    createdAt: Date.now(),
  };
  writeSecrets(cfg.secretsFile, secrets);
  console.log(`\nSaved (mode 600). A running panel picks up the change within ~5s and logs out existing sessions.`);
}

main().catch((err: unknown) => {
  console.error(`panelSetup: ${(err as Error).message}`);
  process.exit(1);
});
