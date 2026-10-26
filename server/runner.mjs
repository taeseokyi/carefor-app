// claude CLI를 비대화형으로 돌려 기록 문장을 받아옵니다.
//
// --bare 는 쓰지 않습니다. bare 모드는 구독 로그인(OAuth)을 읽지 않고
// ANTHROPIC_API_KEY 를 요구하기 때문에, 구독으로 돌리려면 일반 -p 모드여야 합니다.

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { platform } from "node:os";

import { buildHandoffPrompt, HANDOFF_SCHEMA } from "../js/prompts.js";

export class ClaudeRunner {
  /**
   * bin 에는 인자를 함께 적을 수 있습니다.
   *   "claude"                    WSL 안에서 그대로
   *   "wsl -d Ubuntu -e /home/me/.local/bin/claude"
   *                               Windows 쪽에서 WSL 의 claude 를 부를 때.
   *                               사진 경로는 자동으로 /mnt/c/... 로 바꿔 넘깁니다.
   *                               (wsl 이 비로그인 셸이라 PATH 에 claude 가 없을 수 있으니 절대 경로 권장)
   */
  constructor({ bin = "claude", model, timeoutMs = 10 * 60 * 1000, cwd }) {
    const [command, ...prefix] = String(bin).trim().split(/\s+/);
    this.bin = command;
    this.prefix = prefix;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.cwd = cwd;
    this.viaWsl = platform() === "win32" && /^wsl(\.exe)?$/i.test(command);
  }

  // Windows 경로를 WSL 이 읽는 경로로. C:\Temp\x.jpg -> /mnt/c/Temp/x.jpg
  mapPath(p) {
    if (!this.viaWsl) return p;
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
    if (!m) return p;
    return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
  }

  buildArgs(prompt) {
    const args = [
      ...this.prefix,
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(HANDOFF_SCHEMA),
      // 사진을 읽어야 하므로 Read 만 허용합니다.
      "--tools",
      "Read",
      "--allowedTools",
      "Read",
      // 사람이 답할 수 없는 자리이므로 물어보지 않게 합니다.
      "--permission-prompts",
      "none",
      "--max-turns",
      "20",
    ];
    if (this.model) args.push("--model", this.model);
    return args;
  }

  /**
   * @returns {Promise<{records: array, costUsd: number|null, raw: string}>}
   */
  async run(meta, photoPaths, { logPath } = {}) {
    const prompt = buildHandoffPrompt({
      dateLabel: formatDate(meta.date),
      roster: meta.roster,
      manualText: meta.manualText,
      styleGuide: meta.styleGuide,
      photoPaths: photoPaths.map((p) => this.mapPath(p)),
    });

    const { stdout, stderr, code } = await this.#spawn(this.buildArgs(prompt));

    if (logPath) {
      await writeFile(
        logPath,
        `$ ${this.bin} ${this.buildArgs("<prompt>").join(" ")}\n\n` +
          `--- prompt ---\n${prompt}\n\n` +
          `--- exit ${code} ---\n\n--- stdout ---\n${stdout}\n\n--- stderr ---\n${stderr}\n`,
        "utf8"
      ).catch(() => {});
    }

    if (code !== 0) {
      throw new Error(
        `claude CLI가 코드 ${code}로 끝났습니다.\n${(stderr || stdout).slice(0, 600)}`
      );
    }

    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      throw new Error(
        `claude 출력이 JSON이 아닙니다.\n${stdout.slice(0, 600)}`
      );
    }

    if (payload.is_error) {
      throw new Error(
        `claude가 오류로 끝났습니다: ${String(payload.result ?? "").slice(0, 600)}`
      );
    }

    // --json-schema 를 쓰면 structured_output 에 들어옵니다.
    // 요청이 거절되는 등으로 형식을 못 맞추면 그 필드가 아예 없습니다.
    const structured = payload.structured_output;
    if (!structured || !Array.isArray(structured.records)) {
      throw new Error(
        `구조화된 결과를 받지 못했습니다.\n${String(payload.result ?? "").slice(0, 600)}`
      );
    }

    return {
      records: structured.records.map(normalizeRecord).filter((r) => r.name),
      costUsd:
        typeof payload.total_cost_usd === "number"
          ? payload.total_cost_usd
          : null,
      raw: stdout,
    };
  }

  #spawn(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        cwd: this.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        reject(
          new Error(
            `claude CLI가 ${Math.round(this.timeoutMs / 1000)}초 안에 끝나지 않았습니다.`
          )
        );
      }, this.timeoutMs);

      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          err.code === "ENOENT"
            ? new Error(
                `claude 명령을 찾지 못했습니다 (${this.bin}). CLAUDE_BIN 환경변수로 경로를 지정해 주세요.`
              )
            : err
        );
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
    });
  }
}

function normalizeRecord(r) {
  return {
    name: String(r?.name ?? "").trim(),
    notes: Array.isArray(r?.notes)
      ? r.notes.map((n) => String(n).trim()).filter(Boolean)
      : [],
    uncertain: Boolean(r?.uncertain),
    physical: String(r?.physical ?? "").trim(),
    cognitive: String(r?.cognitive ?? "").trim(),
    state_change: String(r?.state_change ?? "").trim(),
  };
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${y}년 ${Number(m)}월 ${Number(d)}일`;
}
