/**
 * QR data-region structure: map each data module to the codeword that owns it.
 *
 * Reed-Solomon guarantee: a symbol still decodes to the target while at most
 * floor(EC/2) codewords per block differ from it. A codeword that differs in
 * ONE module costs the same RS budget as one that differs in EIGHT — so the
 * min-change strategy is to keep the previous frame's modules in the codewords
 * where prev and target diverge the MOST, and take the target everywhere else.
 *
 * This module produces module(r,c) -> codeword index using the standard QR
 * two-column zigzag placement (bottom-right, upward first, skipping the vertical
 * timing column and every reserved/function module). Placement geometry is
 * independent of the mask and ECC level, so the map depends only on the symbol
 * version (equivalently, its reserved-module layout) and is cached by size.
 *
 * The map is an optimization hint only: the caller must still verify the final
 * matrix with a decoder, so an imperfect map can never break correctness.
 */
(function (global) {
  "use strict";

  var cache = {};

  function matrixSize(modules) {
    if (modules.size) return modules.size;
    return Math.round(Math.sqrt(modules.data.length));
  }

  function reservedAt(modules, size, r, c) {
    if (modules.reservedBit) return !!modules.reservedBit[r * size + c];
    if (typeof modules.isReserved === "function") return !!modules.isReserved(r, c);
    return false;
  }

  /**
   * @returns {{ size:number, cwIndex:Int16Array, codewords:number }}
   *   cwIndex[r*size+c] = codeword index for a data module, or -1 for a
   *   reserved/function module (and for trailing remainder bits).
   */
  function buildCodewordMap(modules) {
    var size = matrixSize(modules);
    if (cache[size]) return cache[size];

    var cwIndex = new Int16Array(size * size);
    for (var i = 0; i < cwIndex.length; i++) cwIndex[i] = -1;

    var placed = 0;
    var inc = -1;
    var row = size - 1;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1; // skip the vertical timing column
      while (true) {
        for (var c = 0; c < 2; c++) {
          var cc = col - c;
          if (!reservedAt(modules, size, row, cc)) {
            cwIndex[row * size + cc] = (placed / 8) | 0;
            placed += 1;
          }
        }
        row += inc;
        if (row < 0 || row >= size) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }

    var map = { size: size, cwIndex: cwIndex, codewords: Math.ceil(placed / 8) };
    cache[size] = map;
    return map;
  }

  var api = { buildCodewordMap: buildCodewordMap };
  global.QRStructure = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
