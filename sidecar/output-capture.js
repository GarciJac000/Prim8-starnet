/* sidecar/output-capture.js — a BOUNDED full-output capture for foreground commands.

   shell.exec / verify / the environment backends keep two copies of a command's output: `out` (the
   preview the model sees, capped at maxBytes) and `fullOut` (parked to .output/ so the model can page
   the middle). `fullOut` had no cap at all: a chatty build, a `cat` of a huge log or an SSH `cat` of a
   remote job's output grew one string until V8's max string length, where `+=` throws a RangeError
   inside the child's 'data' listener — an uncaughtException that takes the whole station down with
   every run in flight. Below that, every byte was copied again by stripAnsi / parseMarker / redact.

   makeFullCapture(maxChars?) keeps the FIRST quarter and the LAST three quarters of the output and
   drops the middle, naming exactly how much it dropped. The tail is the part that must survive: the
   shell's exit-code / cwd marker is printed LAST, and the end of a log is where the error is.
   Under the cap the value is byte-identical to plain concatenation.

     const cap = makeFullCapture();  cap.push(chunk) ...  cap.value(mapFn?) -> string;  cap.elided() -> chars dropped

   Callers pass elided() on as `fullOutElided`, and every receipt built from fullOut must say the middle is
   gone when it is non-zero: a saved head + tail is not "the full output". */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).outputCapture = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_FULL_OUT_MAX = 8 * 1024 * 1024;   // chars of one command's full output kept in RAM (head + tail)

  function isLowSurrogate(code) { return code >= 0xDC00 && code <= 0xDFFF; }

  function makeFullCapture(maxChars) {
    const max = (Number.isFinite(maxChars) && maxChars >= 4) ? Math.floor(maxChars) : DEFAULT_FULL_OUT_MAX;
    const headMax = Math.floor(max / 4), tailMax = max - headMax;
    let head = '', tail = [], tailLen = 0, dropped = 0;

    // Fold the pending tail chunks and keep only the last tailMax chars. Amortized O(n): it runs only
    // once the pending chunks reach twice the tail budget.
    function compact() {
      if (tail.length <= 1 && tailLen <= tailMax) return;
      let joined = tail.join('');
      if (joined.length > tailMax) {
        let cut = joined.length - tailMax;
        if (isLowSurrogate(joined.charCodeAt(cut))) cut++;   // never start the tail on half a surrogate pair
        dropped += cut;
        joined = joined.slice(cut);
      }
      tail = [joined];
      tailLen = joined.length;
    }

    function push(text) {
      let s = text == null ? '' : String(text);
      if (!s) return;
      if (head.length < headMax && !tailLen) {
        let take = Math.min(headMax - head.length, s.length);
        if (take > 0 && take < s.length && isLowSurrogate(s.charCodeAt(take))) take--;   // keep a pair whole
        head += s.slice(0, take);
        s = s.slice(take);
        if (!s) return;
      }
      tail.push(s);
      tailLen += s.length;
      if (tailLen > tailMax * 2) compact();
    }

    // mapFn (optional) transforms the head and the tail SEPARATELY once something was dropped — a transform run
    // over the joined text could pair an escape sequence cut at the head's edge with bytes from the tail
    // (stripAnsi's unterminated-OSC branch would then eat the whole tail, exit marker included).
    function value(mapFn) {
      compact();
      const map = typeof mapFn === 'function' ? mapFn : function (s) { return s; };
      const t = tail.length ? tail[0] : '';
      if (!dropped) return map(head + t);
      const h = map(head), tt = map(t);
      return h + '\n…[' + dropped + ' characters of output elided here: StarNet keeps the first ' + h.length
        + ' and the last ' + tt.length + ' characters of a command\'s output]…\n' + tt;
    }

    function elided() { compact(); return dropped; }

    return { push: push, value: value, elided: elided };
  }

  return { makeFullCapture: makeFullCapture, DEFAULT_FULL_OUT_MAX: DEFAULT_FULL_OUT_MAX };
});
