/*
 * Instagram export parser.
 *
 * Instagram's JSON export stores UTF-8 bytes reinterpreted as Latin-1 code
 * points (so e.g. "é" (C3 A9) becomes "Ã©"). We fix that before indexing.
 */
(function (global) {
  "use strict";

  function fixMojibake(s) {
    if (!s) return s;
    // Only attempt the fix if the string contains characters in the Latin-1
    // high range that would indicate UTF-8-reinterpreted-as-Latin-1.
    let needsFix = false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xc2 && c <= 0xf4) { needsFix = true; break; }
      if (c > 0xff) return s; // already has non-Latin1 chars, leave it alone
    }
    if (!needsFix) return s;
    try {
      const bytes = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
      return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    } catch (_) {
      return s;
    }
  }

  function fileLooksLikeMessages(path) {
    // message_1.json, message_2.json, …  inside /inbox/<thread>/
    return /(^|\/)message_\d+\.json$/i.test(path);
  }

  async function readFileAsJSON(file) {
    const text = await file.text();
    return JSON.parse(text);
  }

  /*
   * Groups a list of File objects by thread folder.
   * Each thread folder contains one or more message_N.json files.
   * Returns Map<threadPath, File[]>
   */
  function groupByThread(files) {
    const groups = new Map();
    for (const f of files) {
      const path = f.webkitRelativePath || f.name;
      if (!fileLooksLikeMessages(path)) continue;
      const parts = path.split("/");
      const threadKey = parts.slice(0, -1).join("/") || "__root__";
      let arr = groups.get(threadKey);
      if (!arr) { arr = []; groups.set(threadKey, arr); }
      arr.push(f);
    }
    return groups;
  }

  function normaliseParticipants(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((p) => fixMojibake(p && p.name ? String(p.name) : ""));
  }

  /*
   * Parse every file belonging to a single thread.
   * Instagram splits long threads into message_1.json, message_2.json, ...
   * Each file duplicates the thread metadata (title, participants) and
   * carries a slice of the messages. We merge all messages and sort ascending
   * by timestamp.
   */
  async function parseThread(threadKey, fileList, onProgress) {
    let title = "";
    let participants = [];
    const messages = [];

    for (const file of fileList) {
      let data;
      try {
        data = await readFileAsJSON(file);
      } catch (e) {
        // Skip unparseable files silently.
        continue;
      }
      if (data && typeof data === "object") {
        if (!title && data.title) title = fixMojibake(String(data.title));
        if (!participants.length && Array.isArray(data.participants)) {
          participants = normaliseParticipants(data.participants);
        }
        if (Array.isArray(data.messages)) {
          for (const m of data.messages) {
            const ts = typeof m.timestamp_ms === "number" ? m.timestamp_ms
                     : typeof m.timestamp === "number" ? m.timestamp * 1000
                     : 0;
            // Only index textual messages. Ignore stickers / media-only /
            // call notifications / unsent markers.
            let text = "";
            if (typeof m.content === "string") text = fixMojibake(m.content);
            // Skip content-less events, and Instagram's placeholder "Liked a
            // message" / "unsent" noise if content is empty.
            if (!text) continue;
            // Instagram places a standard placeholder when a message is
            // unsent — skip it so it doesn't pollute the index.
            if (text === "You unsent a message." || text.endsWith(" unsent a message.")) continue;
            messages.push({
              sender: fixMojibake(m.sender_name ? String(m.sender_name) : ""),
              ts,
              text,
            });
          }
        }
      }
      if (onProgress) onProgress();
    }

    messages.sort((a, b) => a.ts - b.ts);

    return {
      id: threadKey,
      title: title || deriveTitleFromKey(threadKey, participants),
      participants,
      messages,
    };
  }

  function deriveTitleFromKey(key, participants) {
    if (participants && participants.length) return participants.join(", ");
    const parts = key.split("/");
    const last = parts[parts.length - 1] || key;
    // thread folders look like "janedoe_1234567890abcdef" — strip the suffix.
    return last.replace(/_[0-9a-f]+$/i, "").replace(/_/g, " ");
  }

  /*
   * Parse a flat file list (from a directory upload or individual files) into
   * a list of threads. Reports progress via onProgress(done, total).
   */
  async function parseFiles(files, onProgress) {
    const groups = groupByThread(files);
    if (groups.size === 0) {
      throw new Error("No Instagram message files found. Look for folders named message_1.json in your export, inside your_instagram_activity/messages/inbox/.");
    }

    const total = Array.from(groups.values()).reduce((n, a) => n + a.length, 0);
    let done = 0;

    const threads = [];
    for (const [key, list] of groups) {
      const thread = await parseThread(key, list, () => {
        done += 1;
        if (onProgress) onProgress(done, total);
      });
      if (thread.messages.length) threads.push(thread);
    }

    // Sort threads: most recent activity first.
    threads.sort((a, b) => {
      const la = a.messages.length ? a.messages[a.messages.length - 1].ts : 0;
      const lb = b.messages.length ? b.messages[b.messages.length - 1].ts : 0;
      return lb - la;
    });

    return threads;
  }

  global.IGParser = { parseFiles, fixMojibake };
})(window);
