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

1. **Nejmenší symbol pro nejmenší změnu** – default **version 2 + ECC L** (25×25). Při 1s taktu je hlavním zdrojem změny **RS difuze**: změna jednoho epoch-bajtu přepočítá všechny EC codewordy, takže dolní mez počtu změněných modulů určuje hlavně **počet modulů symbolu**. v2 je nejmenší symbol, do kterého se payload vejde, takže mění nejméně modulů (~15 vs 28 u v4+H) a má největší, na levném telefonu nejčitelnější moduly. Kompromis: ECC-L má malou rezervu pro čtečku, takže in-QR arcade masky samy omezují množství „inkoustu". Pro nejnižší **procento**/nejmenší plochu změny lze přepnout na `{ version: 6, ecc: "M" }` (41×41, hustší) nebo `{ version: 5, ecc: "Q" }`. `VERSION`/`ECC` v `js/app.js`. Pad se dopočítává na kapacitu (`computePadLen`), takže payload nikdy nepřeteče.
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

Výběr metody v UI (`Maskování`), default **crossfade**:

| metoda | popis |
| --- | --- |
| **crossfade** (default) | jen měněné buňky přejdou opacitou prev→new za ~260 ms; swap je odložen za overlay (přirozený paint gate), takže nikdy nedojde k viditelnému „lupnutí" |
| **koule** | 7 koulí **R G B C M Y K** letí rovně, směr mění jen odrazem od okrajů; RGB aditivně, CMYK substraktivně (skupiny se nemíchají); změny se počítají dopředu a koule je krátce překryjí |
| **shimmer** | trvalý jemný nízkokontrastní dither přes celý symbol – reálná změna zanikne v ambientní mikrodynamice |
| **měkká záplata** | tlumený rozmazaný blob v barvě kódu krátce překryje měněné buňky, swap proběhne pod ním, pak vyprchá |
| **snake / tetris / game of life / sněžení** | černé, na moduly zarovnané pixely kreslené **přímo v QR** (`js/mask-arcade.js`) – had prolézá kódem, glidery z Game of Life přes něj procházejí, tetromina jím propadávají, sníh po něm padá. Entity jsou řídké a stále v pohybu, takže v každém okamžiku je překryto jen pár modulů (v rámci RS korekce v4+H ~30 %), zatímco pohyb přes měněnou oblast skryje flip |
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
