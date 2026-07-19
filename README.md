# qr_scrambler (`minchange`)

Single-page generátor QR kódů, které se **každou sekundu mění**, ale vizuální rozdíl mezi snímky je co nejmenší. Z obsahu QR jde vždy dekódovat aktuální unix epoch.

## Payload / codec (obě strany)

```text
https://het68.cz/?qr=<epoch>.<pad>
```

| část | význam |
| --- | --- |
| `epoch` | unix time v sekundách |
| `pad` | volný filler jen pro minimalizaci vizuální změny |

Sdílený parser je v `js/codec.js`:

```js
Het68Codec.encodePayload(epoch, pad)
Het68Codec.decodePayload(scannedText) // -> number | null
```

Na přijímací straně stačí po naskenování zavolat `decodePayload()` a pad ignorovat.

## Jak se drží minimální změna

1. **Velký QR + nízké ECC** – po benchmarku napříč verzemi/ECC vyšlo nejlépe **version 40 + ECC L** (~0.3 % modulů / frame při pevném zobrazení).
2. **Dlouhý padding** – epoch je v dlouhém stringu, který vyplní kapacitu symbolu.
3. **Výběr masky / pad mutantů** – hledá bližší kanonický frame vůči předchozímu.
4. **ECC stabilizace** – z nového QR se vrátí maximum modulů z předchozího frame, dokud jsQR pořád čte nové URL.

### Výběr z měření (stabilize, ~0.7 s budget)

| version | ECC | avg flips | % modulů |
| --- | --- | ---: | ---: |
| 40 | L | ~105 | **~0.34 %** |
| 35 | L | ~95 | ~0.39 % |
| 30 | L | ~92 | ~0.49 % |
| 25 | L | ~77 | ~0.56 % |
| 10 | L | ~30 | ~0.92 % |
| 15 | H (dříve) | ~60 | ~1.0 %+ |

Nejnižší absolutní počet flipnutých modulů má menší QR (v10-L), ale při pevném zobrazení na obrazovce je rozhodující **podíl změněné plochy** → vítězí velký v40-L.

## UI

- černé pozadí, QR uprostřed
- pod QR aktuální URL
- debug: engine, decoder, epoch, raw Δ, flips, %

## Lokální assety (CDN jen fallback)

```text
index.html
css/styles.css
js/codec.js
js/app.js
vendor/qrcode.min.js
vendor/jsQR.js
vendor/qrcodejs.min.js
```

## Spuštění

```bash
python3 -m http.server 4173
```

Otevřít `http://127.0.0.1:4173/`.

## Server-side příklad

```js
// Node / Edge
const { decodePayload } = require("./js/codec.js"); // nebo zkopírovat funkci
// po scanu:
const epoch = decodePayload(scannedString);
if (epoch != null) {
  // validace freshness, auth, ...
}
```

V prohlížeči je codec dostupný jako `window.Het68Codec`.
