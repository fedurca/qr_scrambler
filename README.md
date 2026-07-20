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

1. **Vyšší ECC rezerva místo nižší** – default **version 4 + ECC Q** (33×33). Pad se dopočítává na kapacitu (`computePadLen`), takže payload nikdy nepřeteče; jediná cena vyšší verze je hustota, kterou vyrovná větší `DRAW_SIZE`. Víc opravných codewordů = větší Reed-Solomonův basin = stabilizér smí ponechat víc modulů shodných s předchozím snímkem. Pro nejmenší změny lze přepnout na `{ version: 5, ecc: "H" }` (`VERSION`/`ECC` v `js/app.js`) po ověření čitelnosti na levném telefonu.
2. **Dlouhý padding** – epoch je v dlouhém stringu, který vyplní kapacitu symbolu.
3. **Structure-aware pad** – mutace hlavně **suffixu** padu (konec QR data bitstreamu / padding codewords).
4. **Analytický codeword-stabilizér** (`js/qr-structure.js`) – každý modul patří právě jednomu codewordu (deterministický zigzag placement). Dekódování přežije, dokud se od cíle liší ≤ `floor(EC/2)` codewordů; codeword s 1 rozdílným modulem stojí stejně jako s 8. Stabilizér proto **seskupí diffy podle codewordu** a ponechá předchozí moduly v těch codewordech, kde se prev a cíl liší nejvíc, se sekundárním kritériem **shlukování** do souvislé oblasti. Výsledek se vždy **jednorázově ověří dekodérem**; při selhání je fallback na heuristické dual-direction půlení.
5. **Top-N kandidátů** – stabilizuje se víc pad-suffix kandidátů (ne jen nejmenší raw diff) a drží se globální minimum flipů.
6. **Prefetch** – výpočet pro `epoch+1` během aktuálního intervalu.
7. **Okamžitý canonical paint** + render fallback řetězec: **canvas → SVG → img(SVG)** (na mobilu SVG první). Pro crossfade se okamžitý paint odloží, aby změna „naběhla" z předchozího snímku.

### Boot měření

Pár sekund po startu se do debug logu vypíše `Grid measure` – průměrné flipy pro profily `v4Q`, `v5H`, `v3L` na několika syntetických přechodech (pomůcka pro volbu mřížky, neběží za provozu).

Hard floor: dvě různá QR data musí ležet v různých RS codeword basins; pod ~0.2–0.25 % už typicky nejde bez změny protokolu (ne-standardní kódování mimo QR payload).

## Maskování změny (aby nebyla vidět)

Výběr metody v UI (`Maskování`), default **crossfade**:

| metoda | popis |
| --- | --- |
| **crossfade** (default) | jen měněné buňky přejdou opacitou prev→new za ~260 ms; swap je odložen za overlay (přirozený paint gate), takže nikdy nedojde k viditelnému „lupnutí" |
| **koule** | 7 koulí **R G B C M Y K** letí rovně, směr mění jen odrazem od okrajů; RGB aditivně, CMYK substraktivně (skupiny se nemíchají); změny se počítají dopředu a koule je krátce překryjí |
| **shimmer** | trvalý jemný nízkokontrastní dither přes celý symbol – reálná změna zanikne v ambientní mikrodynamice |
| **měkká záplata** | tlumený rozmazaný blob v barvě kódu krátce překryje měněné buňky, swap proběhne pod ním, pak vyprchá |
| **žádné** | bez maskování |

## UI

- černé pozadí, QR uprostřed, pod QR aktuální URL
- **Interval epochy (s)** – jak často se QR přegeneruje (default 5 s)
- **Maskování** – výběr metody (default crossfade)
- title stránky nese semver (`het68 QR vX.Y.Z`, viz `package.json`)
- debug: version, engine, decoder, ecc/ver, mask, epoch, raw Δ, flips, %, ~CSS px

## Deploy / self-contained `index.html`

Hostitelé jako `qr.het68.cz`, které pro **každou cestu** vracejí stejné HTML (bez `/vendor/*`), potřebují **jeden soubor**:

```bash
npm run build   # → index.html se vším inline (QR lib, jsQR, CSS, app)
```

Po změně zdrojů vždy znovu `npm run build` a nasaď aktualizovaný `index.html` na origin.

Modulární vývoj: `app.html` + `css/` + `js/` + `vendor/`.

## Lokální assety (CDN jen fallback)

```text
index.html          # self-contained (build výstup, production)
app.html            # modulární shell pro lokální vývoj
package.json        # semver
css/styles.css
js/*.js
vendor/qrcode.min.js
vendor/jsQR.js
vendor/qrcodejs.min.js
```

## Spuštění

```bash
npm run build
python3 -m http.server 4173
```

Otevřít `http://127.0.0.1:4173/` (self-contained) nebo `/app.html` (modulární).
