# qr_scrambler

Single-page stránka, která každou sekundu ukazuje QR kód s časovým razítkem pro:

```text
https://het68.cz/?qr=<epoch>.<pad>
```

`<epoch>` je unix time v sekundách. `<pad>` je dlouhý filler, který vyplní kapacitu QR symbolu a slouží k minimalizaci vizuálních změn.

## Cíl

S každou novou sekundou změnit **co nejméně modulů (pixelů)** QR kódu, při zachování:

- maximálního ECC (**H**)
- scannovatelného QR s aktuálním epoch časem

## Jak se omezuje změna

1. **Dlouhý payload** – epoch je zakódovaný do výrazně delšího stringu s pevným paddingem (QR verze 15, ECC H).
2. **Výběr masky / pad mutantů** – pro novou sekundu se zkusí varianty, které mají menší Hammingovu vzdálenost vůči předchozímu frame.
3. **ECC stabilizace** – z nového kanonického QR se zpětně „vrátí“ co nejvíc modulů z předchozího frame, dokud jsQR pořád dekóduje nové URL. Využívá se opravná kapacita levelu H.

Výsledek: mezi sekundami se typicky přepíše jen malé procento modulů místo velké části symbolu.

## UI

- černé pozadí, QR uprostřed
- pod QR je aktuální URL
- dole debug panel: engine, decoder, raw Δ, počet flipnutých modulů, %, maska, log

## Lokální assety (CDN jen fallback)

```text
index.html
css/styles.css
js/app.js
vendor/qrcode.min.js
vendor/jsQR.js
vendor/qrcodejs.min.js
```

Pořadí načtení encoderu: lokální `qrcode` → lokální `qrcodejs` → CDN.
Decoder: lokální `jsQR` → CDN.

## Spuštění

```bash
python3 -m http.server 4173
```

Otevřít `http://127.0.0.1:4173/`.
