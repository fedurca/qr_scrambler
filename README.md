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

1. **Velký QR + ECC Q** – desktop **v40/Q**, mobil **v25/Q** (lehčí profil kvůli renderu/CPU).
2. **Dlouhý padding** – epoch je v dlouhém stringu, který vyplní kapacitu symbolu.
3. **Structure-aware pad** – mutace hlavně **suffixu** padu (konec QR data bitstreamu / padding codewords).
4. **Dual-direction ECC stabilizace** – from-old + from-new + mutace + polish, řazení diffů podle zigzag oblasti.
5. **Prefetch** – výpočet pro `epoch+1` během aktuální sekundy.
6. **Okamžitý canonical paint** + render fallback řetězec: **canvas → SVG → img(SVG)** (na mobilu SVG první).

### Orientační výsledky (stabilize)

| config | avg flips | % modulů |
| --- | ---: | ---: |
| v40 + **Q** + dual + prefetch budget | ~85 | **~0.27 %** |
| v40 + L + single-direction | ~100 | ~0.32 % |
| v15 + H (starší) | ~60 | ~1.0 %+ |

Hard floor: dvě různá QR data musí ležet v různých RS codeword basins; pod ~0.2–0.25 % už typicky nejde bez změny protokolu (ne-standardní kódování mimo QR payload).

## Typická změna mezi snímky

| profil | moduly (flips) | podíl | ~CSS px (QR ~360 px) |
| --- | ---: | ---: | ---: |
| desktop v40/Q | **~45–65** | **~0.15–0.20 %** | **~180–250 px** |
| mobil v25/Q | ~50–60 | ~0.38–0.45 % | ~350–420 px |

Debug pole `~CSS px` ukazuje odhad podle aktuální velikosti QR na obrazovce.

## UI

- černé pozadí, QR uprostřed
- pod QR aktuální URL
- **Interval epochy (s)** – jak často se QR přegeneruje (default 1 s)
- **Maskovací koule** – volitelné (default vypnuté); koule se odrážejí od hran okna a na chvíli zakryjí oblasti příští změny, pak uhnou, aby šel kód znovu číst
- debug: engine, decoder, epoch, raw Δ, flips, %, ~CSS px

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
