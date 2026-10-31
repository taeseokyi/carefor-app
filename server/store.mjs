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
   * 기록일 당일 작업은 제외합니다. 같은 날 같은 이름이 여러 작업에 있으면
   * 폰에서 확정 저장한 작업 → 폰이 불러와 쓴(채택) 작업 → 가장 나중에 만든 작업 순으로 고릅니다.
   * 반환: [{ date, people: [{ name, physical, cognitive, state_change }] }]
   */
  async recentRecords(start, end) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return [];
    const out = [];
    for (const d of await this.dates()) {
      if (d < start || d >= end) continue;
      const byName = new Map();
      // list() 는 최신순이므로, 같은 우선순위 안에서는 먼저 만난 것(가장 나중 작업)이 남습니다.
      for (const meta of await this.list(d)) {
        if (meta.status !== "done") continue;
        const rank = meta.confirmed ? 2 : meta.adopted ? 1 : 0;
        for (const r of meta.records ?? []) {
          if (!r?.name) continue;
          if (!(r.physical || r.cognitive || r.state_change)) continue;
          const have = byName.get(r.name);
          if (have && have.rank >= rank) continue;
          byName.set(r.name, {
            rank,
            name: r.name,
            physical: r.physical ?? "",
            cognitive: r.cognitive ?? "",
            state_change: r.state_change ?? "",
          });
        }
      }
      if (byName.size) {
        out.push({ date: d, people: [...byName.values()].map(({ rank, ...p }) => p) });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * 폰이 이 작업의 결과를 불러와 썼다고 표시합니다(채택).
   * 같은 날 같은 이름이 든 다른 작업의 채택은 풉니다. 확정된 작업은 건드리지 않습니다.
   */
  async adopt(meta) {
    const names = new Set((meta.records ?? []).map((r) => r.name));
    for (const other of await this.list(meta.date)) {
      if (other.id === meta.id || !other.adopted || other.confirmed) continue;
      if ((other.records ?? []).some((r) => names.has(r.name))) {
        await this.update(other, { adopted: false });
      }
    }
    return this.update(meta, { adopted: true, adoptedAt: new Date().toISOString() });
  }

  /** 폰에서 고친 최종 기록으로 결과를 덮어쓰고 확정 표시를 합니다. 채택도 함께 됩니다. */
  async confirm(meta, records) {
    const adopted = await this.adopt({ ...meta, records });
    return this.update(adopted, {
      records,
      confirmed: true,
      confirmedAt: new Date().toISOString(),
    });
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
