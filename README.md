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

1. **Profil laděný na maskování „sněžením"** – default **version 4 + ECC H** (33×33). Výchozí maska je glitch-overlay „sněžení", které kreslí černé moduly přes kód; ty musí čtečka opravit jako chyby, takže symbol potřebuje **RS rezervu** → ECC **H** (v3+H se nevejde, v4 je nejmenší H). Sníh inkousta jen **ne-rezervované datové moduly** (ne findery/timing/format) → dekódování zůstává ~100 % v každém snímku. Pro nejmenší počet změněných modulů bez in-QR masky lze přepnout na `{ version: 2, ecc: "L" }` (~15 flipů, ale ECC-L nemá rezervu pro sníh). `VERSION`/`ECC` v `js/app.js`. Pad se dopočítává na kapacitu (`computePadLen`).
2. **Dlouhý padding + pad hill-climb** – epoch je v dlouhém stringu, který vyplní kapacitu; volný pad se **hill-climbem** ladí tak, aby data codewordy seděly na předchozí snímek (minimalizuje raw diff před RS obětováním). Souběžně se přehledá všech 8 masek.
3. **Analytický codeword-stabilizér** (`js/qr-structure.js`) – každý modul patří právě jednomu codewordu (deterministický zigzag placement). Dekódování přežije, dokud se od cíle liší ≤ `floor(EC/2)` codewordů; codeword s 1 rozdílným modulem stojí stejně jako s 8. Stabilizér **seskupí diffy podle codewordu** a ponechá předchozí moduly v codewordech s největší úsporou, se sekundárním **shlukováním** do souvislé oblasti. Výsledek se vždy **jednorázově ověří dekodérem**; jinak fallback na heuristické dual-direction půlení.
4. **Top-N kandidátů** – stabilizuje se víc pad/mask kandidátů a drží se globální minimum flipů.
5. **Prefetch** – výpočet pro `epoch+1` během aktuálního intervalu.
6. **Okamžitý canonical paint** + render fallback řetězec: **canvas → SVG → img(SVG)** (na mobilu SVG první). Pro crossfade se okamžitý paint odloží, aby změna „naběhla" z předchozího snímku.

### Naměřené profily při 1s taktu (vm harness, jsQR-ověřeno, avg flips, plocha @300px)

| profil | mřížka | avg flips | % modulů | plocha změny |
| --- | --- | ---: | ---: | ---: |
| **v2 + L** (default) | 25×25 | **15** | 2.44 % | 1634 |
| v6 + M | 41×41 | 26 | **1.53 %** | **1143** |
| v5 + Q | 37×37 | 30 | 2.22 % | 1631 |
| v4 + H | 33×33 | 28 | 2.57 % | 1841 |
| v3 + L | 29×29 | 29 | 3.44 % | 2389 |

`v2+L` mění **nejméně modulů** (~15) a je nejčitelnější (největší moduly) — nejpřímější odpověď na „změna je moc velká". `v6+M` má nejnižší procento a nejmenší celkovou plochu změny, pokud je přijatelný hustší symbol. Boot log `Grid measure` změří profily naživo pár sekund po startu.

Hard floor: dvě různá QR data musí ležet v různých RS codeword basins; pod ~0.2 % už typicky nejde bez změny protokolu.

## Maskování změny (aby nebyla vidět)

Výběr metody v UI (`Maskování`), default **sněžení**:

| metoda | popis |
| --- | --- |
| **sněžení** (default) | černé, na moduly zarovnané „vločky" padají a **problikávají** přes kód (`js/mask-arcade.js`) — vypadá to, jako by se kód jen vadně renderoval. Inkoustí jen **ne-rezervované datové moduly** (nikdy findery/timing/format) a drží se v rámci RS rezervy, takže kód je čitelný v **každém** snímku; problikávání zároveň maskuje sekundovou změnu |
| **žádné** | bez maskování |

Pozn.: dřívější metody (crossfade, koule, shimmer, měkká záplata, snake, tetris, game of life) zůstávají v kódu (`js/mask-methods.js`, `js/mask-arcade.js`), ale UI nabízí jen sněžení dle zadání.

## UI

- černé pozadí, QR uprostřed, pod QR aktuální URL
- **Interval epochy (s)** – jak často se QR přegeneruje (default 1 s)
- **Maskování** – výběr metody (default sněžení)
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
