/*
 * In-memory full-text search engine for parsed threads.
 *
 * Builds a lowercase-token -> sorted gid posting list. Messages are addressed
 * by a flat global id (gid) that maps back to (threadIndex, messageIndex).
 * Phrase / case / whole-word checks run as a verification pass against the
 * original text of any message the posting lists surface.
 */
(function (global) {
  "use strict";

  const TOKEN_RE = /[\p{L}\p{N}]+/gu;

  function tokeniseLower(text) {
    const out = [];
    if (!text) return out;
    const m = text.toLowerCase().matchAll(TOKEN_RE);
    for (const match of m) out.push(match[0]);
    return out;
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  class Index {
    constructor() {
      this.threads = [];
      this.messageRefs = [];  // [threadIdx, msgIdx] per gid
      this.byToken = new Map();
      this.senders = new Set();
      this.minTs = Infinity;
      this.maxTs = -Infinity;
    }

    build(threads) {
      this.threads = threads;
      this.messageRefs = [];
      this.byToken = new Map();
      this.senders = new Set();
      this.minTs = Infinity;
      this.maxTs = -Infinity;

      for (let t = 0; t < threads.length; t++) {
        const thread = threads[t];
        for (let i = 0; i < thread.messages.length; i++) {
          const msg = thread.messages[i];
          const gid = this.messageRefs.length;
          this.messageRefs.push([t, i]);

          if (msg.sender) this.senders.add(msg.sender);
          if (msg.ts) {
            if (msg.ts < this.minTs) this.minTs = msg.ts;
            if (msg.ts > this.maxTs) this.maxTs = msg.ts;
          }

          const tokens = tokeniseLower(msg.text);
          const seen = new Set();
          for (const tok of tokens) {
            if (seen.has(tok)) continue;
            seen.add(tok);
            let list = this.byToken.get(tok);
            if (!list) { list = []; this.byToken.set(tok, list); }
            list.push(gid);
          }
        }
      }
    }

    totalMessages() { return this.messageRefs.length; }

    getMessage(gid) {
      const [t, i] = this.messageRefs[gid];
      const msg = this.threads[t].messages[i];
      return { gid, threadIndex: t, msgIndex: i, thread: this.threads[t], ...msg };
    }

    /*
     * Parse a user query. Returns:
     *   tokensRaw    – user-typed text tokens (original case)
     *   tokensLower  – same, lowercased, used to look up the posting lists
     *   phrases      – quoted substrings, verified on the original text
     *   senderHints  – from:foo restrictions
     *   threadHints  – in:foo restrictions
     */
    parseQuery(q) {
      const tokensRaw = [];
      const tokensLower = [];
      const phrases = [];
      const senderHints = [];
      const threadHints = [];

      if (!q) return { tokensRaw, tokensLower, phrases, senderHints, threadHints };

      // Extract quoted phrases first.
      const rest = q.replace(/"([^"]+)"/g, (_, p) => {
        phrases.push(p.trim());
        return " ";
      });

      for (const raw of rest.split(/\s+/)) {
        if (!raw) continue;
        if (/^from:/i.test(raw)) { senderHints.push(raw.slice(5).toLowerCase()); continue; }
        if (/^in:/i.test(raw))   { threadHints.push(raw.slice(3).toLowerCase()); continue; }
        const toks = raw.match(TOKEN_RE);
        if (!toks) continue;
        for (const t of toks) {
          tokensRaw.push(t);
          tokensLower.push(t.toLowerCase());
        }
      }
      return { tokensRaw, tokensLower, phrases, senderHints, threadHints };
    }

    intersect(lists) {
      if (!lists.length) return [];
      lists.sort((a, b) => a.length - b.length);
      let acc = lists[0].slice();
      for (let k = 1; k < lists.length && acc.length; k++) {
        const next = lists[k];
        const out = [];
        let i = 0, j = 0;
        while (i < acc.length && j < next.length) {
          if (acc[i] === next[j]) { out.push(acc[i]); i++; j++; }
          else if (acc[i] < next[j]) i++;
          else j++;
        }
        acc = out;
      }
      return acc;
    }

    search(query, opts) {
      opts = opts || {};
      const q = this.parseQuery(query || "");
      const matchCase = !!opts.matchCase;
      const wholeWord = !!opts.wholeWord;

      const phrasePatterns = q.phrases.map((p) => buildSubstringRegex(p, matchCase, wholeWord));
      // Token-level verification regex; only needed if the index lookup alone
      // can't guarantee the caller's case / word-boundary requirements.
      const tokenVerifyPatterns = (matchCase || wholeWord)
        ? q.tokensRaw.map((t) => buildSubstringRegex(t, matchCase, wholeWord))
        : [];

      const hasTextQuery = q.tokensLower.length > 0 || q.phrases.length > 0;
      const hasFilters = !!(opts.threadId || opts.sender || opts.fromTs || opts.toTs
                            || q.senderHints.length || q.threadHints.length);

      let candidates;
      if (q.tokensLower.length) {
        const lists = [];
        for (const tok of q.tokensLower) {
          const list = this.byToken.get(tok);
          if (!list) return [];
          lists.push(list);
        }
        candidates = this.intersect(lists);
      } else if (hasTextQuery || hasFilters) {
        // Phrase-only or filter-only query: iterate everything.
        candidates = null;
      } else {
        // No query and no filters: newest N messages.
        candidates = null;
      }

      const self = this;
      function accept(gid) {
        const m = self.getMessage(gid);
        if (opts.threadId && m.thread.id !== opts.threadId) return false;
        if (opts.sender && m.sender !== opts.sender) return false;
        if (opts.fromTs && m.ts < opts.fromTs) return false;
        if (opts.toTs && m.ts > opts.toTs) return false;

        if (q.senderHints.length) {
          const s = (m.sender || "").toLowerCase();
          for (const hint of q.senderHints) if (!s.includes(hint)) return false;
        }
        if (q.threadHints.length) {
          const tt = (m.thread.title || "").toLowerCase();
          for (const hint of q.threadHints) if (!tt.includes(hint)) return false;
        }
        if (phrasePatterns.length) {
          for (const re of phrasePatterns) if (!re.test(m.text)) return false;
        }
        if (tokenVerifyPatterns.length) {
          for (const re of tokenVerifyPatterns) if (!re.test(m.text)) return false;
        }
        return true;
      }

      const MAX_RESULTS = 500;
      const hits = [];

      if (candidates) {
        for (let k = candidates.length - 1; k >= 0; k--) {
          if (accept(candidates[k])) hits.push(candidates[k]);
          if (hits.length >= MAX_RESULTS * 4) break;
        }
      } else if (hasTextQuery || hasFilters) {
        // Full scan (phrase-only or filter-only query).
        for (let gid = this.messageRefs.length - 1; gid >= 0; gid--) {
          if (accept(gid)) hits.push(gid);
          if (hits.length >= MAX_RESULTS * 4) break;
        }
      } else {
        // No criteria: latest messages.
        const limit = Math.min(this.messageRefs.length, MAX_RESULTS);
        for (let gid = this.messageRefs.length - 1; gid >= this.messageRefs.length - limit; gid--) {
          hits.push(gid);
        }
      }

      // Sort newest first by timestamp.
      hits.sort((a, b) => {
        const ra = this.messageRefs[a], rb = this.messageRefs[b];
        return this.threads[rb[0]].messages[rb[1]].ts - this.threads[ra[0]].messages[ra[1]].ts;
      });

      return hits.slice(0, MAX_RESULTS).map((gid) => this.getMessage(gid));
    }
  }

  function buildSubstringRegex(s, matchCase, wholeWord) {
    let pat = escapeRegex(s);
    if (wholeWord) pat = "(?:^|\\P{L})" + pat + "(?:\\P{L}|$)";
    const flags = (matchCase ? "" : "i") + "u";
    return new RegExp(pat, flags);
  }

  /*
   * Regex used by the UI to highlight matches in rendered HTML.
   */
  function buildHighlightRegex(query, matchCase, wholeWord) {
    if (!query) return null;
    const parts = [];
    const rest = query.replace(/"([^"]+)"/g, (_, p) => {
      parts.push(escapeRegex(p));
      return " ";
    });
    for (const raw of rest.split(/\s+/)) {
      if (!raw) continue;
      if (/^(from|in):/i.test(raw)) continue;
      const toks = raw.match(TOKEN_RE) || [];
      for (const t of toks) parts.push(escapeRegex(t));
    }
    if (!parts.length) return null;
    parts.sort((a, b) => b.length - a.length);
    let pat = "(" + parts.join("|") + ")";
    // Use look-around so the replacement only touches the matched word —
    // adjacent characters are left in place.
    if (wholeWord) pat = "(?<=^|\\P{L})" + pat + "(?=\\P{L}|$)";
    const flags = (matchCase ? "g" : "gi") + "u";
    return new RegExp(pat, flags);
  }

  global.IGSearch = { Index, buildHighlightRegex };
})(window);
