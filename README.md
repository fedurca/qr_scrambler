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

Výběr metody v UI (`Maskování`), default **Změny + sníh**. Varianty **předblikávají právě ty moduly, které se v příští iteraci změní** (z forecastu), takže reálná sekundová změna splyne s probliknutím a vypadá to jako vadný render. Liší se přidanými „návnadami":

| varianta | popis |
| --- | --- |
| **Jen změny** (snow1) | bliká pouze buňky, které se příště změní |
| **Změny + šum** (snow2) | + rozptýlený anti-pattern šum (blue-noise: vyhýbá se shlukům, řádkům, mřížkám) |
| **Změny + sníh** (snow3, default) | + padající vločky (sloupce se rozptylují, hustota dle Šum %) |
| **Změny + roj** (snow4) | + body v okolí měněných buněk + anti-pattern doplnění |
| **Změny + sken** (snow5) | + řídká „scan" řada (ne plná linka) putující kódem |
| **Kamufláž** (snow6) | blikají zároveň buňky, které zůstanou **stejné** — anti-pattern výběr |
| **Interlace** (snow7) | prokládané řádky, řídce a bez pravidelné mřížky |
| **Statika** (snow8) | hustší anti-pattern „statika" po datové ploše |
| **Změny z N iterací** (chg) | předblikává **sjednocení změn z příštích N iterací** (N = Dopředný lookup) ve stylu padajícího sněhu |
| **Nejjemnější** (chgmin) | z **N-krokového výhledu** vybere jen buňky, které se od aktuálního kódu **liší nejméně**, a ty jemně problikává |
| **žádné** | bez maskování |

`chgmin` počítá N-krokový výhled levně (jen canonical, bez stabilizace, throttlováno ~2 s; N z UI) a moduly řadí vzestupně podle toho, jak často se přes horizont liší od aktuálního kódu; bliká jen tu nejjemnější (přední) část, ≤ `perFrameCap` na snímek.

U `chg` se forecast počítá N kroků dopředu; sjednocení může být velké, ale na snímek se stále inkoustí jen ≤ `perFrameCap` buněk, takže kód zůstává čitelný. Při rychlém taktu se vyšší N nemusí stihnout spočítat celé — použije se tolik iterací, kolik forecast stihl.

Šum se vybírá greedy blue-noise skórováním (max. min-vzdálenost, penalizace stejného řádku/sloupce, sousedství, opakovaných bliků a mřížky), takže oko nevidí řádky, sloupce ani pravidelné vzory. **Šum %** škáluje, kolik z `perFrameCap` se skutečně využije.

Každý snímek se inkoustí jen **ne-rezervované datové moduly** (nikdy findery/timing/format) a nejvýš `perFrameCap` buněk (kalibrováno tak, že i kdyby všechny byly „chyby", v4+H dekóduje na ~100 %). Kód je proto čitelný v **každém** snímku. Dřívější metody (crossfade, koule, shimmer, měkká záplata, snake, tetris, game of life) zůstávají v kódu, ale nejsou v UI.

## UI

- černé pozadí, QR uprostřed, pod QR aktuální URL
- **Změn za vteřinu** (1–1000) – kolikrát za sekundu se QR přegeneruje. Číselný epoch v URL zůstává v celých sekundách (čtečka čte správný čas); pro sub-sekundové snímky se do padu vloží token slotu, takže i v rámci jedné vteřiny je každý snímek jiný a min-change stabilizér ho drží minimální. Při vysokých hodnotách běží generátor tak rychle, jak stíhá (rozpočet na snímek se zkracuje)
- **Dopředný lookup** (1–30) – počet iterací forecastu / chg / chgmin výhledu
- **Šum %** (0–100) – množství maskovacích návnad (0 ≈ jen změny, 100 = plný čitelný cap)
- **Změny %** (0–100) – náhodný podíl buněk z příští iterace (forecast), které se předblikávají; stále ≤ čitelný `perFrameCap`
- **Maskování** – varianty předblikávání měněných modulů (default Změny + sníh)
- **Záznam s** + **Export videa** – klientský záznam QR oblasti (včetně maskovacích overlayů) přes `MediaRecorder` → stažení `.webm`/`.mp4`; délka 1–120 s
- title stránky nese semver (`het68 QR vX.Y.Z`, viz `package.json`)
- debug: version, engine, decoder, ecc/ver, **FPS min/avg/max**, lookup, noise, change %, rec, settings URL, mask, epoch, raw Δ, flips, %, ~CSS px

### URL parametry nastavení

Všechny ovládací prvky jdou sdílet v query stringu stránky (při změně se `history.replaceState` aktualizuje):

| param | význam | rozsah / hodnoty |
| --- | --- | --- |
| `rate` (alias `cps`, `changes`) | změn za vteřinu | 1–1000 |
| `lookup` (alias `forecast`, `steps`) | dopředný lookup | 1–30 |
| `noise` | šum % | 0–100 |
| `preview` (alias `chgPct`, `next`) | % změn z příští iterace v náhledu | 0–100 |
| `mask` (alias `method`) | metoda maskování | `snow3`, `chg`, `chgmin`, … |
| `rec` (alias `duration`, `record`) | délka videoexportu [s] | 1–120 |
| `debug` | otevřít debug panel | `1` / `true` |

Příklad: `/?rate=10&lookup=8&noise=40&preview=70&mask=snow2&rec=15`

## Deploy / self-contained `index.html`

Hostitelé jako `qr.het68.cz`, které pro **každou cestu** vracejí stejné HTML (bez `/vendor/*`), potřebují **jeden soubor**:

```bash
npm run build   # → index.html se vším inline (QR lib, jsQR, CSS, app)
```

Po změně zdrojů vždy znovu `npm run build` a nasaď aktualizovaný `index.html` na origin.

### GitHub Pages (autodeploy)

Po každém pushi na `main` (nebo ručně přes **Actions → Deploy GitHub Pages → Run workflow**) CI:

1. spustí `npm run build`
2. nasadí self-contained `index.html` na GitHub Pages

Workflow: [`.github/workflows/pages.yml`](.github/workflows/pages.yml).

Veřejná URL (project site):

```text
https://fedurca.github.io/qr_scrambler/
```

**Jednorázově** (owner/admin) zapni Pages:

1. otevři [Settings → Pages](https://github.com/fedurca/qr_scrambler/settings/pages)
2. **Build and deployment → Source: GitHub Actions**
3. znovu spusť workflow (**Actions → Deploy GitHub Pages → Re-run** nebo prázdný commit / `workflow_dispatch`)

Query parametry fungují beze změny, např. `https://fedurca.github.io/qr_scrambler/?rate=10&mask=snow2`.

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
