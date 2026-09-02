// A terminal renderer for the guest's serial output.
//
// The serial port emits a byte stream, not text. Appending each byte to a
// textContent produces four visible faults: SGR colour sequences show up as
// literal "[1;34m", stray bytes render as characters, carriage returns and
// backspaces are ignored so any line the shell rewrites is corrupted, and the
// growing string is re-laid-out on every byte.
//
// This handles what a serial console actually needs: UTF-8 decoding, SGR colour
// and bold, cursor motion within the current line, line and screen erase, and
// bounded scrollback. Unrecognised escape sequences are consumed rather than
// printed, which is the important part: an escape must never leak into the
// output as text.
//
// One DOM node per line. Only the line being written is re-rendered, so a boot
// that prints thousands of lines costs one small innerHTML per frame rather than
// a rebuild of the whole scrollback.

const MAX_LINES = 2000;

// ANSI colours as class suffixes. The stylesheet maps them to values that stay
// legible on both grounds; the raw ANSI palette does not.
const COLOURS = {
  30: "k", 31: "r", 32: "g", 33: "y", 34: "b", 35: "m", 36: "c", 37: "w",
  90: "k", 91: "r", 92: "g", 93: "y", 94: "b", 95: "m", 96: "c", 97: "w"
};
const BRIGHT = new Set([90, 91, 92, 93, 94, 95, 96, 97]);

export class Terminal {
  /**
   * @param {Object} element a container node, a <pre> or <div>
   * @param {Object} [options]
   * @param {number} [options.maxLines]
   */
  constructor(element, { maxLines = MAX_LINES } = {}) {
    this.el = element;
    this.maxLines = maxLines;
    this.decoder = new TextDecoder("utf-8", { fatal: false });

    this.current = [];      // cells of the line being written
    this.cursor = 0;
    this.colour = "";
    this.bold = false;
    this.state = "text";    // text, esc, csi, osc
    this.params = "";
    this.plain = "";        // escape-free recent text, for prompt matching
    this.lineCount = 0;

    this._dirty = false;
    this._node = null;
    /** Draw a cursor at the write position. A terminal without one gives the
        typist no idea where their next character will land. */
    this.showCursor = false;
    this.clear();
  }

  /** Feed one byte, as delivered by the emulator's serial listener. */
  writeByte(byte) {
    // Decode incrementally so a multi-byte character split across two calls
    // still arrives intact.
    const text = this.decoder.decode(new Uint8Array([byte]), { stream: true });
    if (text) { for (const ch of text) this._consume(ch); this._schedule(); }
  }

  /** Feed a string. Used by the tests and for echoing locally typed input. */
  write(text) {
    for (const ch of text) this._consume(ch);
    this._schedule();
  }

  _consume(ch) {
    const code = ch.codePointAt(0);

    if (this.state === "esc") {
      if (ch === "[") { this.state = "csi"; this.params = ""; return; }
      if (ch === "]") { this.state = "osc"; this.params = ""; return; }
      // An intermediate byte means more of the sequence is still to come, as in
      // the charset designators ESC ( B and ESC % G. Ending here would print
      // their final byte as text.
      if (code >= 0x20 && code <= 0x2f) { this.state = "escint"; return; }
      this.state = "text";  // a two-character sequence such as ESC c
      return;
    }
    if (this.state === "escint") {
      if (code < 0x20 || code > 0x2f) this.state = "text";  // the final byte
      return;
    }
    if (this.state === "csi") {
      if (ch >= "@" && ch <= "~") { this._csi(ch, this.params); this.state = "text"; }
      else this.params += ch;
      return;
    }
    if (this.state === "osc") {
      // A window title or similar, ended by BEL or by ESC backslash.
      if (code === 0x07 || ch === "\\") this.state = "text";
      return;
    }

    if (code === 0x1b) { this.state = "esc"; return; }

    switch (code) {
      case 0x0a: this._newline(); return;                             // line feed
      case 0x0d: this.cursor = 0; return;                             // carriage return
      case 0x08: this.cursor = Math.max(0, this.cursor - 1); return;  // backspace
      case 0x09: {                                                    // tab
        const stop = (Math.floor(this.cursor / 8) + 1) * 8;
        while (this.cursor < stop) this._put(" ");
        return;
      }
      case 0x07: return;                                              // bell
      default: break;
    }

    // Drop the remaining C0 controls, DEL, and the C1 range. Also drop U+FFFD:
    // a serial line that is still settling emits bytes like 0xFF, which is not
    // valid UTF-8 and decodes to the replacement character. Printing it is
    // noise, not output.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xfffd) return;

    this._put(ch);
    this._remember(ch);
  }

  _put(ch) {
    const cell = { ch, cls: this._attrs() };
    // Overwrite rather than append when the cursor was moved back, which is how
    // a shell redrawing its line is meant to behave.
    if (this.cursor < this.current.length) this.current[this.cursor] = cell;
    else {
      while (this.current.length < this.cursor) this.current.push({ ch: " ", cls: "" });
      this.current.push(cell);
    }
    this.cursor++;
  }

  _attrs() {
    return (this.bold ? "bold " : "") + this.colour;
  }

  _remember(ch) {
    this.plain = (this.plain + ch).slice(-400);
  }

  _newline() {
    // No cursor on a line that is finished; it belongs on the one being written.
    this._node.innerHTML = renderLine(this.current, -1);
    this.current = [];
    this.cursor = 0;
    this._node = this._appendLine();
    this._remember("\n");
    if (++this.lineCount > this.maxLines) this._trim();
  }

  _appendLine() {
    const node = this.el.ownerDocument.createElement("div");
    node.className = "ln";
    this.el.appendChild(node);
    return node;
  }

  _trim() {
    const excess = this.lineCount - this.maxLines;
    for (let i = 0; i < excess && this.el.firstChild; i++) {
      this.el.removeChild(this.el.firstChild);
    }
    this.lineCount = this.maxLines;
  }

  _csi(final, params) {
    const n = params.split(";").map((p) => parseInt(p, 10));
    switch (final) {
      case "m": this._sgr(params); return;
      case "K": {                                       // erase in line
        const mode = n[0] || 0;
        if (mode === 0) this.current.length = Math.min(this.current.length, this.cursor);
        else if (mode === 1) for (let i = 0; i < this.cursor; i++) this.current[i] = { ch: " ", cls: "" };
        else { this.current = []; this.cursor = 0; }
        return;
      }
      case "J":                                         // erase in display
        if ((n[0] || 0) === 2) this.clear();
        return;
      case "H": case "f": this.cursor = Math.max(0, (n[1] || 1) - 1); return;
      case "C": this.cursor += n[0] || 1; return;
      case "D": this.cursor = Math.max(0, this.cursor - (n[0] || 1)); return;
      case "G": this.cursor = Math.max(0, (n[0] || 1) - 1); return;
      default: return;                                  // consumed, never printed
    }
  }

  _sgr(params) {
    const codes = params === "" ? [0] : params.split(";").map((p) => parseInt(p, 10) || 0);
    for (const code of codes) {
      if (code === 0) { this.colour = ""; this.bold = false; }
      else if (code === 1) this.bold = true;
      else if (code === 22) this.bold = false;
      else if (code === 39) this.colour = "";
      else if (COLOURS[code]) {
        this.colour = COLOURS[code];
        // A bright foreground is bold plus a base colour in most palettes, and
        // treating it that way keeps the class set small.
        if (BRIGHT.has(code)) this.bold = true;
      }
    }
  }

  _schedule() {
    if (this._dirty) return;
    this._dirty = true;
    const run = () => { this._dirty = false; this.render(); };
    // requestAnimationFrame does not fire while the page is not being composited,
    // which includes a backgrounded tab. A boot the user tabbed away from would
    // otherwise stop updating entirely, and come back frozen mid-line. The tail
    // used for prompt matching is kept up to date synchronously, so only the
    // display is affected, but a display that stops is still a fault.
    const doc = this.el.ownerDocument;
    const visible = !doc || doc.visibilityState !== "hidden";
    if (visible && typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 50);
  }

  /** Re-render only the line being written, then follow the tail if we were at it. */
  render() {
    const atBottom = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40;
    this._node.innerHTML = renderLine(this.current, this.showCursor ? this.cursor : -1);
    if (atBottom) this.el.scrollTop = this.el.scrollHeight;
  }

  /** Escape-free recent output. Prompt matching must use this, not the markup. */
  get tail() { return this.plain; }

  /** Forget the recent text without clearing the screen, before sending a command. */
  resetTail() { this.plain = ""; }

  clear() {
    while (this.el.firstChild) this.el.removeChild(this.el.firstChild);
    this.current = [];
    this.cursor = 0;
    this.lineCount = 0;
    this.plain = "";
    this._node = this._appendLine();
  }
}

function renderLine(cells, cursorAt = -1) {
  if (!cells.length) return cursorAt === 0 ? cursor(" ") : "";

  let html = "";
  let run = "";
  let cls = cells[0].cls;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (i === cursorAt) {
      // The cursor sits on a character rather than between them, the way a
      // block cursor does, so the run has to break here.
      html += span(run, cls) + cursor(cell.ch);
      run = "";
      cls = cell.cls;
      continue;
    }
    if (cell.cls !== cls) { html += span(run, cls); run = ""; cls = cell.cls; }
    run += cell.ch;
  }
  html += span(run, cls);
  // Past the end of the line, which is where it is while typing.
  if (cursorAt >= cells.length) html += cursor(" ");
  return html;
}

function cursor(ch) {
  return `<span class="cur">${escapeHtml(ch)}</span>`;
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function span(text, cls) {
  if (!text) return "";
  const escaped = escapeHtml(text);
  return cls ? '<span class="t ' + cls + '">' + escaped + "</span>" : escaped;
}
