# Vendor libraries

Local copies are loaded first. CDN URLs are only used as fallback.

| File | Package | Role |
| --- | --- | --- |
| `qrcode.min.js` | [node-qrcode](https://github.com/soldair/node-qrcode) 1.5.4 (browser IIFE) | Primary QR encoder (`create`) |
| `jsQR.js` | [jsQR](https://github.com/cozmo/jsQR) | Decoder used to verify ECC-stabilized matrices |
| `qrcodejs.min.js` | [qrcodejs](https://github.com/davidshimjs/qrcodejs) 1.0.0 | Last-resort local encoder fallback |

Licenses: `LICENSE.qrcode.txt`, `LICENSE.jsQR.txt`, `LICENSE.qrcodejs.txt`.
