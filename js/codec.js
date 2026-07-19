/**
 * Shared payload codec for het68 QR scrambler.
 *
 * Format:
 *   https://het68.cz/?qr=<epoch>.<pad>
 *
 * - <epoch>  unix time in seconds (decimal)
 * - <pad>    free filler used only to minimize visual QR churn
 *
 * The receiving side should parse epoch with decodePayload() and ignore pad.
 */
(function (global) {
  "use strict";

  var BASE = "https://het68.cz/?qr=";

  function encodePayload(epoch, pad) {
    return BASE + String(epoch) + "." + String(pad || "");
  }

  function decodePayload(text) {
    if (text == null) return null;
    var s = String(text).trim();

    var m = s.match(/[?&]qr=(\d{9,12})(?:[.&]|$)/i);
    if (m) return parseInt(m[1], 10);

    m = s.match(/^(\d{9,12})\./);
    if (m) return parseInt(m[1], 10);

    m = s.match(/^(\d{9,12})$/);
    if (m) return parseInt(m[1], 10);

    try {
      var u = new URL(s);
      var q = u.searchParams.get("qr");
      if (q) {
        var ep = String(q).split(".")[0];
        if (/^\d{9,12}$/.test(ep)) return parseInt(ep, 10);
      }
    } catch (e) {
      // not a URL
    }

    return null;
  }

  function extractPad(text) {
    if (text == null) return null;
    var s = String(text).trim();
    var m = s.match(/[?&]qr=\d+\.([0-9A-Za-z]+)/);
    if (m) return m[1];
    m = s.match(/^\d+\.([0-9A-Za-z]+)$/);
    return m ? m[1] : null;
  }

  var api = {
    BASE: BASE,
    encodePayload: encodePayload,
    decodePayload: decodePayload,
    extractPad: extractPad
  };

  global.Het68Codec = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
