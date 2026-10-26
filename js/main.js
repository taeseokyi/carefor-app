import { readNotes, writeRecords } from "./api.js";
import { buildHandoffPrompt, parseHandoffResponse } from "./prompts.js";
import {
  checkHealth,
  submitJob,
  listJobs,
  getJob,
  waitForJob,
} from "./backend.js";
import {
  loadSettings,
  saveSettings,
  clearStored,
  loadDraft,
  saveDraft,
  clearDraft,
} from "./store.js";

// ---------- 상태 ----------

const state = {
  settings: loadSettings(),
  images: [], // { id, name, mediaType, base64, url }
  items: [], // { id, name, note, uncertain }
  records: [], // { name, physical, cognitive, state_change }
  unreadable: [],
};

// ---------- DOM ----------

const $ = (id) => document.getElementById(id);

const el = {
  date: $("record-date"),
  openSettings: $("open-settings"),
  noticeOpenSettings: $("notice-open-settings"),
  setupNotice: $("setup-notice"),

  dropzone: $("dropzone"),
  fileInput: $("file-input"),
  thumbs: $("thumbs"),
  manualWrap: $("manual-wrap"),
  manualText: $("manual-text"),
  btnRead: $("btn-read"),
  btnSendLocal: $("btn-send-local"),
  btnCopyPrompt: $("btn-copy-prompt"),
  jobStatus: $("job-status"),
  jobSpinner: $("job-spinner"),
  jobText: $("job-text"),
  stepJobs: $("step-jobs"),
  jobList: $("job-list"),
  btnRefreshJobs: $("btn-refresh-jobs"),
  jobsError: $("jobs-error"),
  btnClearInput: $("btn-clear-input"),
  readError: $("read-error"),

  stepPaste: $("step-paste"),
  pasteInput: $("paste-input"),
  btnLoadPaste: $("btn-load-paste"),
  pasteError: $("paste-error"),

  stepReview: $("step-review"),
  reviewMeta: $("review-meta"),
  items: $("items"),
  btnAddItem: $("btn-add-item"),
  btnGenerate: $("btn-generate"),
  genError: $("gen-error"),

  stepResult: $("step-result"),
  resultSummary: $("result-summary"),
  results: $("results"),

  dlg: $("settings-dlg"),
  apiKey: $("api-key"),
  model: $("model"),
  mode: $("mode"),
  modeNote: $("mode-note"),
  fieldApiKey: $("field-api-key"),
  fieldModel: $("field-model"),
  fieldBackend: $("field-backend"),
  backendUrl: $("backend-url"),
  backendToken: $("backend-token"),
  btnTestBackend: $("btn-test-backend"),
  backendStatus: $("backend-status"),
  writer: $("writer"),
  roster: $("roster"),
  styleGuide: $("style-guide"),
  btnForget: $("btn-forget"),

  toast: $("toast"),
};

// ---------- 공통 도우미 ----------

const uid = () => Math.random().toString(36).slice(2, 10);

function todayISO() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function dateLabel(iso) {
  const [y, m, d] = iso.split("-");
  return `${y}년 ${Number(m)}월 ${Number(d)}일`;
}

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, 2200);
}

function showError(node, message) {
  if (!message) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  node.textContent = message;
  node.hidden = false;
}

function setBusy(button, busy, busyLabel) {
  const label = button.querySelector(".btn-label");
  if (busy) {
    button.disabled = true;
    button.dataset.idleLabel ??= label.textContent;
    label.textContent = busyLabel;
    if (!button.querySelector(".spinner")) {
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      button.prepend(spinner);
    }
  } else {
    button.disabled = false;
    label.textContent = button.dataset.idleLabel ?? label.textContent;
    button.querySelector(".spinner")?.remove();
  }
}

// ---------- 설정 ----------

const MODE_NOTES = {
  local:
    "집 노트북의 claude CLI가 사진을 받아 기록을 만들어 둡니다. 노트북 서버가 켜져 있어야 하고, 구독 외에 드는 비용이 없습니다.",
  subscription:
    "Claude 앱(웹·휴대폰)에 프롬프트와 사진을 직접 보내고, 답변만 이 앱으로 가져옵니다. 구독 외에 드는 비용이 없습니다.",
  api: "이 앱이 Anthropic API를 직접 불러 사진까지 한 번에 처리합니다. 쓴 만큼 API 요금이 듭니다.",
};

function applyMode() {
  const mode = state.settings.mode;
  document.body.dataset.mode = mode;
  el.modeNote.textContent = MODE_NOTES[mode] ?? "";

  const isApi = mode === "api";
  el.fieldApiKey.hidden = !isApi;
  el.fieldModel.hidden = !isApi;
  el.fieldBackend.hidden = mode !== "local";
}

function applySettingsToForm() {
  el.mode.value = state.settings.mode;
  el.apiKey.value = state.settings.apiKey;
  el.model.value = state.settings.model;
  el.writer.value = state.settings.writer;
  el.roster.value = state.settings.roster.join("\n");
  el.styleGuide.value = state.settings.styleGuide;
  el.backendUrl.value = state.settings.backendUrl;
  el.backendToken.value = state.settings.backendToken;
  el.backendStatus.textContent = "";
}

function refreshSetupNotice() {
  // API 키가 필요한 건 API 모드뿐입니다.
  el.setupNotice.hidden =
    state.settings.mode !== "api" || Boolean(state.settings.apiKey);
}

function openSettings() {
  applySettingsToForm();
  el.dlg.showModal();
}

el.openSettings.addEventListener("click", openSettings);
el.noticeOpenSettings.addEventListener("click", openSettings);

el.dlg.addEventListener("close", () => {
  if (el.dlg.returnValue !== "save") return;

  state.settings = {
    mode: el.mode.value,
    apiKey: el.apiKey.value.trim(),
    model: el.model.value,
    writer: el.writer.value.trim(),
    roster: el.roster.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
    styleGuide: el.styleGuide.value.trim(),
    backendUrl: el.backendUrl.value.trim(),
    backendToken: el.backendToken.value.trim(),
  };

  const ok = saveSettings(state.settings);
  applyMode();
  refreshSetupNotice();
  renderRosterDatalist();
  if (state.settings.mode === "local") refreshJobs().catch(() => {});
  toast(ok ? "설정을 저장했습니다" : "설정은 적용했지만 이 브라우저에 저장하지 못했습니다");
});

el.btnForget.addEventListener("click", () => {
  if (!confirm("저장된 API 키·설정·작성 중인 기록을 모두 지울까요?")) return;
  clearStored();
  state.settings = loadSettings();
  state.records = [];
  state.items = [];
  applySettingsToForm();
  applyMode();
  refreshSetupNotice();
  render();
  el.dlg.close();
  toast("저장된 내용을 지웠습니다");
});

// ---------- 사진 ----------

const MAX_EDGE = 1568; // Anthropic 권장 상한. 더 크게 보내도 정확도는 오르지 않고 비용만 늘어납니다.
const MAX_IMAGES = 12;

async function fileToImage(file) {
  const bitmap = await createImageBitmap(file);

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.85)
  );

  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  return {
    id: uid(),
    name: file.name,
    mediaType: "image/jpeg",
    base64,
    url: URL.createObjectURL(blob),
  };
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith("image/"));
  if (!files.length) return;

  const room = MAX_IMAGES - state.images.length;
  if (room <= 0) {
    toast(`사진은 한 번에 ${MAX_IMAGES}장까지 올릴 수 있습니다`);
    return;
  }

  const accepted = files.slice(0, room);
  if (files.length > room) {
    toast(`${room}장만 추가했습니다 (최대 ${MAX_IMAGES}장)`);
  }

  for (const file of accepted) {
    try {
      state.images.push(await fileToImage(file));
    } catch {
      toast(`"${file.name}"을(를) 읽지 못했습니다`);
    }
  }
  renderThumbs();
}

function renderThumbs() {
  el.thumbs.hidden = state.images.length === 0;
  el.thumbs.replaceChildren(
    ...state.images.map((img) => {
      const wrap = document.createElement("div");
      wrap.className = "thumb";

      const image = document.createElement("img");
      image.src = img.url;
      image.alt = img.name;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `${img.name} 빼기`);
      remove.addEventListener("click", () => {
        URL.revokeObjectURL(img.url);
        state.images = state.images.filter((i) => i.id !== img.id);
        renderThumbs();
      });

      wrap.append(image, remove);
      return wrap;
    })
  );
}

el.dropzone.addEventListener("click", () => el.fileInput.click());
el.dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    el.fileInput.click();
  }
});
el.fileInput.addEventListener("change", () => {
  addFiles(el.fileInput.files);
  el.fileInput.value = "";
});

for (const type of ["dragenter", "dragover"]) {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  el.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    el.dropzone.classList.remove("over");
  });
}
el.dropzone.addEventListener("drop", (event) => {
  if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
});

// 사진을 복사해서 바로 붙여 넣는 경우도 받아 줍니다.
document.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length) addFiles(files);
});

// ---------- 1단계 : 판독 ----------

el.btnClearInput.addEventListener("click", () => {
  state.images.forEach((img) => URL.revokeObjectURL(img.url));
  state.images = [];
  el.manualText.value = "";
  renderThumbs();
  showError(el.readError, "");
  toast("입력을 비웠습니다");
});

el.btnRead.addEventListener("click", async () => {
  showError(el.readError, "");

  if (!state.settings.apiKey) {
    showError(el.readError, "먼저 ⚙ 설정에서 API 키를 등록해 주세요.");
    openSettings();
    return;
  }

  const manualText = el.manualText.value.trim();
  if (!state.images.length && !manualText) {
    showError(el.readError, "사진을 올리거나 메모를 직접 입력해 주세요.");
    return;
  }

  setBusy(el.btnRead, true, "읽는 중…");
  try {
    const result = await readNotes({
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      images: state.images,
      manualText,
      roster: state.settings.roster,
    });

    state.items = result.items.map((item) => ({
      id: uid(),
      name: String(item.name ?? "").trim(),
      note: String(item.note ?? "").trim(),
      uncertain: Boolean(item.uncertain),
    }));
    state.unreadable = result.unreadable;
    state.records = [];

    if (!state.items.length) {
      showError(
        el.readError,
        "메모에서 읽어 낸 내용이 없습니다. 사진이 선명한지 확인하거나 직접 입력해 주세요."
      );
    }

    render();
    persistDraft();
    el.stepReview.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showError(el.readError, error.message);
  } finally {
    setBusy(el.btnRead, false);
  }
});

// ---------- 노트북 모드 ----------

el.btnTestBackend.addEventListener("click", async () => {
  el.backendStatus.textContent = "확인 중…";
  try {
    await checkHealth(el.backendUrl.value.trim(), el.backendToken.value.trim());
    el.backendStatus.textContent = "✓ 노트북과 연결됐습니다.";
    el.backendStatus.style.color = "var(--accent)";
  } catch (error) {
    el.backendStatus.textContent = error.message;
    el.backendStatus.style.color = "var(--danger)";
  }
});

function showJobStatus(kind, text, busy) {
  el.jobStatus.hidden = false;
  el.jobStatus.className = `job-status only-local ${kind}`;
  el.jobText.textContent = text;
  el.jobSpinner.hidden = !busy;
}

const JOB_LABEL = {
  queued: "차례 기다리는 중",
  running: "노트북이 작업 중",
  done: "완료",
  error: "실패",
};

async function followJob(id) {
  const { backendUrl, backendToken } = state.settings;

  const job = await waitForJob(backendUrl, backendToken, id, {
    onUpdate: (j) => {
      if (j.status === "queued" || j.status === "running") {
        showJobStatus("running", `${JOB_LABEL[j.status]}…`, true);
      }
    },
  });

  if (job.status === "error") {
    showJobStatus("error", `노트북에서 실패했습니다 — ${job.error}`, false);
    return;
  }

  loadJobIntoResults(job);
  showJobStatus(
    "done",
    `완료 · 수급자 ${job.records.length}명` +
      (job.costUsd ? ` · 약 $${job.costUsd.toFixed(3)}` : ""),
    false
  );
  refreshJobs().catch(() => {});
}

function loadJobIntoResults(job) {
  state.records = (job.records ?? []).map((r) => ({
    name: r.name,
    notes: r.notes ?? [],
    uncertain: Boolean(r.uncertain),
    physical: r.physical ?? "",
    cognitive: r.cognitive ?? "",
    state_change: r.state_change ?? "",
  }));
  state.items = [];
  state.unreadable = [];
  render();
  persistDraft();
  el.stepResult.scrollIntoView({ behavior: "smooth", block: "start" });
}

el.btnSendLocal.addEventListener("click", async () => {
  showError(el.readError, "");

  const { backendUrl, backendToken } = state.settings;
  if (!backendUrl) {
    showError(el.readError, "⚙ 설정에서 노트북 주소를 먼저 넣어 주세요.");
    openSettings();
    return;
  }

  const manualText = el.manualText.value.trim();
  if (!state.images.length && !manualText) {
    showError(el.readError, "사진을 올리거나 메모를 직접 입력해 주세요.");
    return;
  }

  setBusy(el.btnSendLocal, true, "보내는 중…");
  try {
    const job = await submitJob(backendUrl, backendToken, {
      date: el.date.value,
      photos: state.images,
      manualText,
      roster: state.settings.roster,
      styleGuide: state.settings.styleGuide,
    });

    toast("노트북으로 보냈습니다");
    showJobStatus("running", "차례 기다리는 중…", true);

    // 사진은 노트북이 보관하므로 앱에서는 비웁니다.
    state.images.forEach((img) => URL.revokeObjectURL(img.url));
    state.images = [];
    el.manualText.value = "";
    renderThumbs();

    await followJob(job.id);
  } catch (error) {
    showError(el.readError, error.message);
    showJobStatus("error", error.message, false);
  } finally {
    setBusy(el.btnSendLocal, false);
  }
});

async function refreshJobs() {
  showError(el.jobsError, "");
  const { backendUrl, backendToken } = state.settings;
  if (!backendUrl) {
    el.jobList.replaceChildren();
    return;
  }

  let jobs;
  try {
    jobs = await listJobs(backendUrl, backendToken, el.date.value);
  } catch (error) {
    showError(el.jobsError, error.message);
    el.jobList.replaceChildren();
    return;
  }

  if (!jobs.length) {
    const empty = document.createElement("p");
    empty.className = "empty-hint";
    empty.textContent = "이 날짜로 보낸 기록이 아직 없습니다.";
    el.jobList.replaceChildren(empty);
    return;
  }

  el.jobList.replaceChildren(
    ...jobs.map((job) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "job-row";

      const when = document.createElement("span");
      when.className = "when";
      when.textContent = new Date(job.createdAt).toLocaleTimeString("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
      });

      const what = document.createElement("span");
      what.className = "what";
      what.textContent =
        job.status === "done"
          ? `수급자 ${job.recordCount}명`
          : `사진 ${job.photoCount}장`;

      const badge = document.createElement("span");
      badge.className = `job-badge ${job.status}`;
      badge.textContent = JOB_LABEL[job.status] ?? job.status;

      row.append(when, what, badge);
      row.addEventListener("click", async () => {
        if (job.status === "done") {
          try {
            const full = await getJob(backendUrl, backendToken, job.id);
            loadJobIntoResults(full);
            toast(`${full.records.length}명 불러왔습니다`);
          } catch (error) {
            showError(el.jobsError, error.message);
          }
        } else if (job.status === "error") {
          showError(el.jobsError, `실패: ${job.error}`);
        } else {
          showJobStatus("running", `${JOB_LABEL[job.status]}…`, true);
          followJob(job.id).catch((error) =>
            showError(el.jobsError, error.message)
          );
        }
      });
      return row;
    })
  );
}

el.btnRefreshJobs.addEventListener("click", () => {
  refreshJobs().catch(() => {});
});

// ---------- 구독 모드 : 프롬프트 복사 · 답변 불러오기 ----------

el.btnCopyPrompt.addEventListener("click", async () => {
  showError(el.readError, "");

  const prompt = buildHandoffPrompt({
    dateLabel: dateLabel(el.date.value),
    roster: state.settings.roster,
    manualText: el.manualText.value.trim(),
    styleGuide: state.settings.styleGuide,
  });

  const ok = await copyText(prompt);
  if (!ok) {
    showError(
      el.readError,
      "복사하지 못했습니다. 아래 상자를 길게 눌러 직접 복사해 주세요."
    );
    el.pasteInput.value = prompt;
    return;
  }

  el.btnCopyPrompt.textContent = "복사됨 ✓";
  setTimeout(() => {
    el.btnCopyPrompt.textContent = "Claude에 보낼 프롬프트 복사";
  }, 1800);
  toast("Claude 앱에 붙여 넣고 메모 사진을 함께 보내세요");
});

el.btnLoadPaste.addEventListener("click", () => {
  showError(el.pasteError, "");

  let records;
  try {
    records = parseHandoffResponse(el.pasteInput.value);
  } catch (error) {
    showError(el.pasteError, error.message);
    return;
  }

  if (!records.length) {
    showError(el.pasteError, "불러올 수급자가 없습니다.");
    return;
  }

  state.records = records;
  state.items = [];
  state.unreadable = [];

  render();
  persistDraft();

  const uncertain = records.filter((r) => r.uncertain).length;
  toast(
    uncertain
      ? `${records.length}명 불러옴 · ${uncertain}명은 확인 필요`
      : `${records.length}명 불러왔습니다`
  );
  el.stepResult.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ---------- 2단계 : 판독 결과 편집 ----------

function renderReview() {
  const hasItems = state.items.length > 0;
  el.stepReview.hidden = !hasItems && !state.unreadable.length;

  const people = new Set(state.items.map((i) => i.name).filter(Boolean));
  const uncertainCount = state.items.filter((i) => i.uncertain).length;

  const parts = [];
  if (hasItems) {
    parts.push(`${state.items.length}줄 · 수급자 ${people.size}명`);
  }
  el.reviewMeta.textContent = parts.join(" · ");

  const warnings = [];
  if (uncertainCount) {
    warnings.push(`${uncertainCount}줄은 글자가 흐려 확인이 필요합니다 (테두리 표시).`);
  }
  if (state.unreadable.length) {
    warnings.push(`읽지 못한 부분: ${state.unreadable.join(" / ")}`);
  }
  for (const text of warnings) {
    const warn = document.createElement("span");
    warn.className = "warn";
    warn.textContent = `⚠ ${text}`;
    el.reviewMeta.append(warn);
  }

  el.items.replaceChildren(
    ...state.items.map((item) => {
      const row = document.createElement("div");
      row.className = "item";
      if (item.uncertain) row.style.borderColor = "var(--danger)";

      const name = document.createElement("input");
      name.type = "text";
      name.className = "name";
      name.value = item.name;
      name.placeholder = "수급자 이름";
      name.setAttribute("aria-label", "수급자 이름");
      name.setAttribute("list", "roster-list");
      name.addEventListener("input", () => {
        item.name = name.value;
        persistDraft();
      });

      const note = document.createElement("textarea");
      note.className = "note";
      note.rows = 1;
      note.value = item.note;
      note.placeholder = "관찰·특이 사항";
      note.setAttribute("aria-label", "관찰 내용");
      note.addEventListener("input", () => {
        item.note = note.value;
        autoGrow(note);
        persistDraft();
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "del";
      del.textContent = "×";
      del.setAttribute("aria-label", "이 줄 삭제");
      del.addEventListener("click", () => {
        state.items = state.items.filter((i) => i.id !== item.id);
        renderReview();
        persistDraft();
      });

      row.append(name, note, del);
      queueMicrotask(() => autoGrow(note));
      return row;
    })
  );

  renderRosterDatalist();
}

function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function renderRosterDatalist() {
  let list = document.getElementById("roster-list");
  if (!list) {
    list = document.createElement("datalist");
    list.id = "roster-list";
    document.body.append(list);
  }
  list.replaceChildren(
    ...state.settings.roster.map((name) => {
      const option = document.createElement("option");
      option.value = name;
      return option;
    })
  );
}

el.btnAddItem.addEventListener("click", () => {
  state.items.push({ id: uid(), name: "", note: "", uncertain: false });
  renderReview();
  el.items.querySelector(".item:last-child input")?.focus();
});

// ---------- 3단계 : 기록 생성 ----------

function groupByPerson() {
  const groups = new Map();
  for (const item of state.items) {
    const name = item.name.trim();
    const note = item.note.trim();
    if (!name || !note) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(note);
  }
  return [...groups].map(([name, notes]) => ({ name, notes }));
}

el.btnGenerate.addEventListener("click", async () => {
  showError(el.genError, "");

  const people = groupByPerson();
  if (!people.length) {
    showError(el.genError, "이름과 내용이 모두 적힌 줄이 없습니다.");
    return;
  }

  setBusy(el.btnGenerate, true, "작성 중…");
  try {
    const result = await writeRecords({
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      dateLabel: dateLabel(el.date.value),
      people,
      styleGuide: state.settings.styleGuide,
    });

    // 요청한 순서를 기준으로 맞춰, 빠진 사람이 있어도 칸은 만들어 둡니다.
    state.records = people.map((person) => {
      const found = result.records.find((r) => r.name?.trim() === person.name);
      return {
        name: person.name,
        notes: person.notes,
        physical: found?.physical?.trim() ?? "",
        cognitive: found?.cognitive?.trim() ?? "",
        state_change: found?.state_change?.trim() ?? "",
      };
    });

    render();
    persistDraft();
    el.stepResult.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showError(el.genError, error.message);
  } finally {
    setBusy(el.btnGenerate, false);
  }
});

// ---------- 결과 ----------

const FIELDS = [
  { key: "physical", label: "신체활동 특이사항" },
  { key: "cognitive", label: "인지관리 특이사항" },
  { key: "state_change", label: "상태변화 기록" },
];

function renderResults() {
  el.stepResult.hidden = state.records.length === 0;

  const summary = [
    dateLabel(el.date.value),
    `수급자 ${state.records.length}명`,
  ];
  if (state.settings.writer) summary.push(`작성자 ${state.settings.writer}`);
  el.resultSummary.textContent = summary.join(" · ");

  el.results.replaceChildren(
    ...state.records.map((record) => {
      const person = document.createElement("article");
      person.className = "person";

      const head = document.createElement("div");
      head.className = "person-head";

      const title = document.createElement("h3");
      title.textContent = record.name;

      const count = document.createElement("span");
      count.className = "count";
      count.textContent = record.notes.length
        ? `메모 ${record.notes.length}줄`
        : "";

      head.append(title, count);

      if (record.uncertain) {
        const flag = document.createElement("span");
        flag.className = "uncertain-flag";
        flag.textContent = "확인 필요";
        flag.title = "글씨가 흐려 잘못 읽었을 수 있습니다";
        head.append(flag);
      }

      const body = document.createElement("div");
      body.className = "person-body";

      if (record.notes.length) {
        const source = document.createElement("div");
        source.className = "source-notes";
        source.innerHTML = "<b>메모</b> · ";
        source.append(record.notes.join(" / "));
        body.append(source);
      }

      for (const field of FIELDS) {
        body.append(renderField(record, field));
      }

      person.append(head, body);
      return person;
    })
  );
}

function renderField(record, field) {
  const block = document.createElement("div");
  block.className = "field-block";

  const row = document.createElement("div");
  row.className = "label-row";

  const label = document.createElement("label");
  label.textContent = field.label;
  const inputId = `f-${uid()}`;
  label.htmlFor = inputId;

  const len = document.createElement("span");
  len.className = "len";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "btn copy small";
  copy.textContent = "복사";

  row.append(label, len, copy);

  const textarea = document.createElement("textarea");
  textarea.id = inputId;
  textarea.value = record[field.key];
  textarea.placeholder = "메모에 이 항목에 해당하는 내용이 없었습니다. 필요하면 직접 적어 주세요.";

  const updateMeta = () => {
    const value = textarea.value.trim();
    len.textContent = value ? `${value.length}자` : "비어 있음";
    block.classList.toggle("empty", !value);
    copy.disabled = !value;
  };

  textarea.addEventListener("input", () => {
    record[field.key] = textarea.value;
    autoGrow(textarea);
    updateMeta();
    persistDraft();
  });

  copy.addEventListener("click", async () => {
    const ok = await copyText(textarea.value.trim());
    copy.textContent = ok ? "복사됨 ✓" : "복사 실패";
    setTimeout(() => {
      copy.textContent = "복사";
    }, 1600);
    if (ok) toast(`${record.name} — ${field.label} 복사됨`);
  });

  block.append(row, textarea);
  queueMicrotask(() => {
    autoGrow(textarea);
    updateMeta();
  });
  return block;
}

async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 클립보드 권한이 없거나 http 환경일 때를 위한 대비책.
    try {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.append(helper);
      helper.select();
      const ok = document.execCommand("copy");
      helper.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// ---------- 임시 저장 ----------

function persistDraft() {
  saveDraft({
    date: el.date.value,
    items: state.items,
    records: state.records,
    unreadable: state.unreadable,
    savedAt: Date.now(),
  });
}

function restoreDraft() {
  const draft = loadDraft();
  if (!draft) return;

  // 다른 날짜의 기록이면 되살리지 않습니다.
  if (draft.date !== el.date.value) {
    clearDraft();
    return;
  }

  state.items = draft.items ?? [];
  state.records = draft.records ?? [];
  state.unreadable = draft.unreadable ?? [];

  if (state.items.length || state.records.length) {
    toast("작성 중이던 내용을 불러왔습니다");
  }
}

// ---------- 렌더 ----------

function render() {
  renderReview();
  renderResults();
}

// ---------- 시작 ----------

el.date.value = todayISO();
el.date.addEventListener("change", () => {
  if (!el.date.value) el.date.value = todayISO();
  persistDraft();
  if (state.settings.mode === "local") refreshJobs().catch(() => {});
});

applySettingsToForm();
applyMode();
refreshSetupNotice();
renderRosterDatalist();
restoreDraft();
render();

if (state.settings.mode === "local" && state.settings.backendUrl) {
  refreshJobs().catch(() => {});
}
