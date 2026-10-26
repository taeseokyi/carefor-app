import { readNotes, writeRecords } from "./api.js";
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
  btnClearInput: $("btn-clear-input"),
  readError: $("read-error"),

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
  writer: $("writer"),
  roster: $("roster"),
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

function applySettingsToForm() {
  el.apiKey.value = state.settings.apiKey;
  el.model.value = state.settings.model;
  el.writer.value = state.settings.writer;
  el.roster.value = state.settings.roster.join("\n");
}

function refreshSetupNotice() {
  el.setupNotice.hidden = Boolean(state.settings.apiKey);
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
    apiKey: el.apiKey.value.trim(),
    model: el.model.value,
    writer: el.writer.value.trim(),
    roster: el.roster.value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  };

  const ok = saveSettings(state.settings);
  refreshSetupNotice();
  toast(ok ? "설정을 저장했습니다" : "설정은 적용했지만 이 브라우저에 저장하지 못했습니다");
});

el.btnForget.addEventListener("click", () => {
  if (!confirm("저장된 API 키·설정·작성 중인 기록을 모두 지울까요?")) return;
  clearStored();
  state.settings = loadSettings();
  state.records = [];
  state.items = [];
  applySettingsToForm();
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
      count.textContent = `메모 ${record.notes.length}줄`;

      head.append(title, count);

      const body = document.createElement("div");
      body.className = "person-body";

      const source = document.createElement("div");
      source.className = "source-notes";
      source.innerHTML = "<b>메모</b> · ";
      source.append(record.notes.join(" / "));
      body.append(source);

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
});

applySettingsToForm();
refreshSetupNotice();
renderRosterDatalist();
restoreDraft();
render();
