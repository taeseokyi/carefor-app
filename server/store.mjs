// 작업(job)을 파일로 저장합니다. 데이터베이스 없이 디렉토리 하나로 끝냅니다.
//
//   data/
//     2026-10-26/
//       <jobId>/
//         meta.json      작업 상태와 결과
//         photo-1.jpg    업로드된 사진
//         claude.log     claude CLI 원본 출력 (문제 추적용)

import { mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export class JobStore {
  constructor(root) {
    this.root = root;
  }

  #dir(date, id) {
    return join(this.root, date, id);
  }

  async create({ date, periodStart, photos, manualText, roster, styleGuide }) {
    const id = randomUUID().slice(0, 8);
    const dir = this.#dir(date, id);
    await mkdir(dir, { recursive: true });

    const files = [];
    for (const [i, photo] of photos.entries()) {
      const name = `photo-${i + 1}.${photo.ext}`;
      await writeFile(join(dir, name), photo.buffer);
      files.push(name);
    }

    const meta = {
      id,
      date,
      periodStart: periodStart ?? date,
      status: "queued", // queued | running | done | error
      photos: files,
      manualText: manualText ?? "",
      roster: roster ?? [],
      styleGuide: styleGuide ?? "",
      records: [],
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      costUsd: null,
    };

    await this.#write(meta);
    return meta;
  }

  async #write(meta) {
    const dir = this.#dir(meta.date, meta.id);
    await writeFile(
      join(dir, "meta.json"),
      JSON.stringify(meta, null, 2),
      "utf8"
    );
    return meta;
  }

  async update(meta, patch) {
    return this.#write({ ...meta, ...patch });
  }

  async get(date, id) {
    try {
      const raw = await readFile(join(this.#dir(date, id), "meta.json"), "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** 날짜를 모를 때 전체에서 찾습니다. */
  async find(id) {
    for (const date of await this.dates()) {
      const meta = await this.get(date, id);
      if (meta) return meta;
    }
    return null;
  }

  async dates() {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
        .map((e) => e.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  async list(date) {
    try {
      const ids = await readdir(join(this.root, date), {
        withFileTypes: true,
      });
      const metas = [];
      for (const entry of ids) {
        if (!entry.isDirectory()) continue;
        const meta = await this.get(date, entry.name);
        if (meta) metas.push(meta);
      }
      return metas.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      return [];
    }
  }

  /**
   * 상태변화 기간의 시작일(start)부터 기록일(end) 전날까지 완료된 작업의 기록을 날짜순으로 모읍니다.
   * 기록일 당일 작업은 제외합니다. 같은 날 같은 이름이 여러 작업에 있으면 가장 나중에 만든 작업의 것을 씁니다.
   * 반환: [{ date, people: [{ name, physical, cognitive, state_change }] }]
   */
  async recentRecords(start, end) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return [];
    const out = [];
    for (const d of await this.dates()) {
      if (d < start || d >= end) continue;
      const byName = new Map();
      for (const meta of await this.list(d)) {
        if (meta.status !== "done") continue;
        for (const r of meta.records ?? []) {
          if (!r?.name || byName.has(r.name)) continue;
          if (!(r.physical || r.cognitive || r.state_change)) continue;
          byName.set(r.name, {
            name: r.name,
            physical: r.physical ?? "",
            cognitive: r.cognitive ?? "",
            state_change: r.state_change ?? "",
          });
        }
      }
      if (byName.size) out.push({ date: d, people: [...byName.values()] });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  async remove(date, id) {
    await rm(this.#dir(date, id), { recursive: true, force: true });
  }

  photoPaths(meta) {
    const dir = this.#dir(meta.date, meta.id);
    return meta.photos.map((name) => join(dir, name));
  }

  logPath(meta) {
    return join(this.#dir(meta.date, meta.id), "claude.log");
  }

  /** 오래된 작업을 지웁니다. 사진이 쌓이지 않도록 기본 56일(8주). */
  async prune(keepDays) {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const date of await this.dates()) {
      const dirPath = join(this.root, date);
      const info = await stat(dirPath).catch(() => null);
      if (!info) continue;
      if (new Date(`${date}T23:59:59`).getTime() < cutoff) {
        await rm(dirPath, { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }
}
