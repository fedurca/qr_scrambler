# Vendor libraries

Local copies used first by the page. CDN URLs are only tried if local files fail.

| File | Package | Role |
| --- | --- | --- |
| `qrcode.min.js` | [node-qrcode](https://github.com/soldair/node-qrcode) 1.5.4 (browser IIFE bundle) | Primary QR engine (ECC H, fixed version 10) |
| `qrcodejs.min.js` | [qrcodejs](https://github.com/davidshimjs/qrcodejs) 1.0.0 | Secondary local fallback (ECC H) |

Licenses: `LICENSE.qrcode.txt`, `LICENSE.qrcodejs.txt`.
