/*
 * UI orchestration. All state lives here, in memory only.
 */
(function () {
  "use strict";

  const state = {
    index: new IGSearch.Index(),
    loaded: false,
    currentContextThread: null,
    currentContextAnchor: 0,
    ownerName: null, // best guess of "my" name, to right-align own messages
  };

  // --- View switching -----------------------------------------------------

  const views = {
    search: document.getElementById("search"),
    threads: document.getElementById("threads"),
    tutorial: document.getElementById("tutorial"),
    privacy: document.getElementById("privacy"),
    landing: document.getElementById("landing"),
  };
  const tabs = {
    search: document.getElementById("navSearch"),
    threads: document.getElementById("navThreads"),
    tutorial: document.getElementById("navTutorial"),
    privacy: document.getElementById("navPrivacy"),
  };

  function show(view) {
    // Landing is shown instead of the search tab when nothing's loaded.
    const effective = view === "search" && !state.loaded ? "landing" : view;
    for (const k of Object.keys(views)) views[k].hidden = (k !== effective);
    for (const k of Object.keys(tabs)) tabs[k].classList.toggle("active", k === view);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  tabs.search.addEventListener("click", () => show("search"));
  tabs.threads.addEventListener("click", () => show("threads"));
  tabs.tutorial.addEventListener("click", () => show("tutorial"));
  tabs.privacy.addEventListener("click", () => show("privacy"));

  // --- File loading -------------------------------------------------------

  const dropzone = document.getElementById("dropzone");
  const folderInput = document.getElementById("folderInput");
  const fileInput = document.getElementById("fileInput");
  const loadStatus = document.getElementById("loadStatus");

  folderInput.addEventListener("change", (e) => loadFiles(Array.from(e.target.files || [])));
  fileInput.addEventListener("change", (e) => loadFiles(Array.from(e.target.files || [])));

  ["dragenter", "dragover"].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("drag");
    });
  });
  dropzone.addEventListener("drop", async (e) => {
    const items = e.dataTransfer && e.dataTransfer.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
      const files = [];
      const entries = [];
      for (let i = 0; i < items.length; i++) {
        const entry = items[i].webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
      await Promise.all(entries.map((entry) => walkEntry(entry, "", files)));
      loadFiles(files);
    } else if (e.dataTransfer && e.dataTransfer.files) {
      loadFiles(Array.from(e.dataTransfer.files));
    }
  });

  async function walkEntry(entry, prefix, out) {
    if (entry.isFile) {
      await new Promise((resolve) => {
        entry.file((f) => {
          // Attach the relative path so the parser can group by thread folder.
          try {
            Object.defineProperty(f, "webkitRelativePath", {
              value: prefix + entry.name,
              configurable: true,
            });
          } catch (_) { /* some browsers freeze file objects */ }
          out.push(f);
          resolve();
        }, resolve);
      });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const children = await readAllEntries(reader);
      await Promise.all(children.map((c) => walkEntry(c, prefix + entry.name + "/", out)));
    }
  }

  function readAllEntries(reader) {
    return new Promise((resolve) => {
      const all = [];
      function pump() {
        reader.readEntries((batch) => {
          if (!batch.length) resolve(all);
          else { all.push(...batch); pump(); }
        }, () => resolve(all));
      }
      pump();
    });
  }

  function setStatus(html, kind) {
    loadStatus.hidden = false;
    loadStatus.className = "status" + (kind ? " " + kind : "");
    loadStatus.innerHTML = html;
  }

  async function loadFiles(files) {
    if (!files.length) return;
    setStatus(`Parsing ${files.length.toLocaleString()} files… <div class="progress"><span style="width:0%"></span></div>`);
    try {
      const threads = await IGParser.parseFiles(files, (done, total) => {
        const pct = total ? Math.round((done / total) * 100) : 0;
        const bar = loadStatus.querySelector(".progress > span");
        if (bar) bar.style.width = pct + "%";
      });
      state.index.build(threads);
      state.loaded = true;
      state.ownerName = guessOwnerName(threads);
      populateFilters();
      renderThreadList();
      const totalMsgs = state.index.totalMessages();
      setStatus(`Loaded <strong>${totalMsgs.toLocaleString()}</strong> messages across <strong>${threads.length.toLocaleString()}</strong> conversations. Ready to search.`, "ok");
      document.getElementById("statFooter").textContent =
        `${totalMsgs.toLocaleString()} messages indexed · ${threads.length.toLocaleString()} conversations`;
      show("search");
      runSearch();
      document.getElementById("q").focus();
    } catch (err) {
      console.error(err);
      setStatus(`Couldn't parse the export: ${escapeHtml(err.message || String(err))}`, "err");
    }
  }

  function guessOwnerName(threads) {
    // The user's own name is the sender that appears most often across threads.
    const counts = new Map();
    for (const t of threads) {
      for (const m of t.messages) {
        if (!m.sender) continue;
        counts.set(m.sender, (counts.get(m.sender) || 0) + 1);
      }
    }
    let best = null, bestN = -1;
    for (const [name, n] of counts) if (n > bestN) { best = name; bestN = n; }
    return best;
  }

  // --- Filters ------------------------------------------------------------

  const filterThread = document.getElementById("filterThread");
  const filterSender = document.getElementById("filterSender");
  const filterFrom = document.getElementById("filterFrom");
  const filterTo = document.getElementById("filterTo");
  const filterCase = document.getElementById("filterCase");
  const filterWhole = document.getElementById("filterWhole");
  const qInput = document.getElementById("q");
  const clearQ = document.getElementById("clearQ");

  function populateFilters() {
    // Threads, sorted by recency (state.index.threads is already sorted).
    filterThread.innerHTML = '<option value="">All conversations</option>' +
      state.index.threads.map((t, i) => {
        const last = t.messages.length ? t.messages[t.messages.length - 1].ts : 0;
        const label = `${escapeHtml(t.title || "(untitled)")} — ${t.messages.length.toLocaleString()} msgs`;
        return `<option value="${escapeHtml(t.id)}">${label}</option>`;
      }).join("");

    const senders = Array.from(state.index.senders).sort((a, b) => a.localeCompare(b));
    filterSender.innerHTML = '<option value="">Anyone</option>' +
      senders.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");

    if (state.index.minTs !== Infinity) {
      filterFrom.min = toDateInputValue(state.index.minTs);
      filterFrom.max = toDateInputValue(state.index.maxTs);
      filterTo.min = filterFrom.min;
      filterTo.max = filterFrom.max;
    }
  }

  function toDateInputValue(ts) {
    const d = new Date(ts);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  // --- Search -------------------------------------------------------------

  const resultsEl = document.getElementById("results");
  const searchMeta = document.getElementById("searchMeta");

  let searchTimer = null;
  function scheduleSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 80);
  }
  qInput.addEventListener("input", scheduleSearch);
  clearQ.addEventListener("click", () => { qInput.value = ""; runSearch(); qInput.focus(); });
  [filterThread, filterSender, filterFrom, filterTo, filterCase, filterWhole].forEach((el) => {
    el.addEventListener("change", runSearch);
  });

  function runSearch() {
    if (!state.loaded) return;
    const query = qInput.value.trim();

    const opts = {
      threadId: filterThread.value || null,
      sender: filterSender.value || null,
      fromTs: filterFrom.value ? Date.parse(filterFrom.value + "T00:00:00") : null,
      toTs: filterTo.value ? Date.parse(filterTo.value + "T23:59:59.999") : null,
      matchCase: filterCase.checked,
      wholeWord: filterWhole.checked,
    };

    const t0 = performance.now();
    const hits = state.index.search(query, opts);
    const dt = (performance.now() - t0).toFixed(1);

    renderResults(hits, query, opts);

    if (query || opts.threadId || opts.sender || opts.fromTs || opts.toTs) {
      searchMeta.innerHTML = `${hits.length.toLocaleString()} result${hits.length === 1 ? "" : "s"}` +
        (hits.length >= 500 ? " (showing newest 500)" : "") +
        ` · ${dt} ms`;
    } else {
      searchMeta.innerHTML = `Showing the most recent ${hits.length.toLocaleString()} messages. Start typing to search.`;
    }
  }

  function renderResults(hits, query, opts) {
    if (!hits.length) {
      resultsEl.innerHTML = '<div class="empty">No messages match. Try broader terms, remove filters, or quote multi-word phrases like <code>"see you tomorrow"</code>.</div>';
      return;
    }
    const hiRe = IGSearch.buildHighlightRegex(query, opts.matchCase, opts.wholeWord);
    const frag = document.createDocumentFragment();
    for (const hit of hits) {
      const el = document.createElement("div");
      el.className = "result";
      el.addEventListener("click", () => openContext(hit));

      const head = document.createElement("div");
      head.className = "result-head";
      const who = document.createElement("span");
      who.innerHTML = `<span class="result-sender">${escapeHtml(hit.sender || "(unknown)")}</span> · ${escapeHtml(hit.thread.title || "(untitled)")}`;
      const when = document.createElement("span");
      when.textContent = formatDate(hit.ts);
      head.appendChild(who);
      head.appendChild(when);

      const body = document.createElement("div");
      body.className = "result-body";
      body.innerHTML = renderTextWithHighlight(hit.text, hiRe);

      el.appendChild(head);
      el.appendChild(body);
      frag.appendChild(el);
    }
    resultsEl.innerHTML = "";
    resultsEl.appendChild(frag);
  }

  function renderTextWithHighlight(text, hiRe) {
    if (!hiRe) return escapeHtml(text);
    // Escape first, then apply highlights on escaped text. We rebuild the
    // regex against escaped source so offsets line up.
    const escaped = escapeHtml(text);
    return escaped.replace(hiRe, '<mark>$1</mark>');
  }

  // --- Context dialog -----------------------------------------------------

  const contextDialog = document.getElementById("contextDialog");
  const ctxThreadEl = document.getElementById("ctxThread");
  const ctxDateEl = document.getElementById("ctxDate");
  const ctxBody = document.getElementById("ctxBody");
  const ctxClose = document.getElementById("ctxClose");
  const ctxEarlier = document.getElementById("ctxEarlier");
  const ctxLater = document.getElementById("ctxLater");

  ctxClose.addEventListener("click", () => contextDialog.close());
  contextDialog.addEventListener("click", (e) => {
    // Click outside the dialog content (i.e., on the backdrop) to close.
    const r = contextDialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      contextDialog.close();
    }
  });

  const CTX_WINDOW = 40;

  function openContext(hit) {
    state.currentContextThread = hit.thread;
    state.currentContextAnchor = hit.msgIndex;
    renderContext();
    if (!contextDialog.open) contextDialog.showModal();
    // Scroll the anchor message into view.
    requestAnimationFrame(() => {
      const target = ctxBody.querySelector('.msg.hit');
      if (target) target.scrollIntoView({ block: "center" });
    });
  }

  function renderContext() {
    const thread = state.currentContextThread;
    if (!thread) return;
    const anchor = state.currentContextAnchor;
    const start = Math.max(0, anchor - CTX_WINDOW);
    const end = Math.min(thread.messages.length, anchor + CTX_WINDOW + 1);
    ctxThreadEl.textContent = thread.title || "(untitled)";
    ctxDateEl.textContent = `Messages ${start + 1}–${end} of ${thread.messages.length.toLocaleString()}`;
    const query = qInput.value.trim();
    const hiRe = IGSearch.buildHighlightRegex(query, filterCase.checked, filterWhole.checked);

    const frag = document.createDocumentFragment();
    let lastDay = "";
    for (let i = start; i < end; i++) {
      const m = thread.messages[i];
      const day = formatDay(m.ts);
      if (day !== lastDay) {
        const d = document.createElement("div");
        d.className = "muted";
        d.style.textAlign = "center";
        d.style.fontSize = "12px";
        d.style.margin = "8px 0 2px";
        d.textContent = day;
        frag.appendChild(d);
        lastDay = day;
      }
      const el = document.createElement("div");
      const mine = state.ownerName && m.sender === state.ownerName;
      el.className = "msg " + (mine ? "me" : "them") + (i === anchor ? " hit" : "");
      const meta = document.createElement("div");
      meta.className = "msg-meta";
      meta.textContent = `${m.sender || "(unknown)"} · ${formatTime(m.ts)}`;
      const body = document.createElement("div");
      body.innerHTML = renderTextWithHighlight(m.text, hiRe);
      el.appendChild(meta);
      el.appendChild(body);
      frag.appendChild(el);
    }
    ctxBody.innerHTML = "";
    ctxBody.appendChild(frag);

    ctxEarlier.disabled = start === 0;
    ctxLater.disabled = end === thread.messages.length;
  }

  ctxEarlier.addEventListener("click", () => {
    state.currentContextAnchor = Math.max(0, state.currentContextAnchor - CTX_WINDOW);
    renderContext();
    ctxBody.scrollTop = 0;
  });
  ctxLater.addEventListener("click", () => {
    const len = state.currentContextThread.messages.length;
    state.currentContextAnchor = Math.min(len - 1, state.currentContextAnchor + CTX_WINDOW);
    renderContext();
    ctxBody.scrollTop = ctxBody.scrollHeight;
  });

  // --- Thread list --------------------------------------------------------

  const threadListEl = document.getElementById("threadList");
  const threadFilterEl = document.getElementById("threadFilter");
  threadFilterEl.addEventListener("input", renderThreadList);

  function renderThreadList() {
    if (!state.loaded) { threadListEl.innerHTML = ""; return; }
    const q = threadFilterEl.value.trim().toLowerCase();
    const frag = document.createDocumentFragment();
    let shown = 0;
    for (const t of state.index.threads) {
      if (q && !(t.title || "").toLowerCase().includes(q)) continue;
      const last = t.messages.length ? t.messages[t.messages.length - 1] : null;
      const el = document.createElement("div");
      el.className = "thread";
      el.innerHTML = `
        <div class="thread-name">${escapeHtml(t.title || "(untitled)")}</div>
        <div class="thread-meta">
          ${t.messages.length.toLocaleString()} messages
          ${last ? " · last " + formatDate(last.ts) : ""}
        </div>
      `;
      el.addEventListener("click", () => {
        filterThread.value = t.id;
        qInput.value = "";
        show("search");
        runSearch();
      });
      frag.appendChild(el);
      shown++;
    }
    threadListEl.innerHTML = "";
    if (!shown) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No conversations match that filter.";
      threadListEl.appendChild(empty);
    } else {
      threadListEl.appendChild(frag);
    }
  }

  // --- Privacy: wipe ------------------------------------------------------

  document.getElementById("wipe").addEventListener("click", () => {
    if (!confirm("Clear all loaded messages from memory?")) return;
    state.index = new IGSearch.Index();
    state.loaded = false;
    state.ownerName = null;
    resultsEl.innerHTML = "";
    threadListEl.innerHTML = "";
    filterThread.innerHTML = '<option value="">All conversations</option>';
    filterSender.innerHTML = '<option value="">Anyone</option>';
    qInput.value = "";
    searchMeta.innerHTML = "";
    setStatus("Memory wiped. Load a new export to continue.", "ok");
    document.getElementById("statFooter").textContent = "";
    show("search"); // falls through to landing
  });

  // --- utils --------------------------------------------------------------

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function formatDate(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function formatDay(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "short", day: "numeric" });
  }
  function formatTime(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  // Initial view.
  show("search"); // will fall through to landing because loaded === false
})();
