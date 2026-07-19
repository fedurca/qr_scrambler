# qr_scrambler

Jednoduchá single-page stránka, která každou sekundu generuje QR kód s URL:

```text
https://het68.cz/?qr=<unix-epoch>
```

Cíl je mít scannovatelný QR, který se v čase mění, ale vizuální rozdíl mezi sekundami je co nejmenší.

## Chování

- černé pozadí, QR kód uprostřed
- pod QR se zobrazuje aktuální adresa
- maximální ECC (**H**)
- primární engine používá **pevnou vyšší QR verzi (10)**, aby krátká URL nevyužila celou kapacitu a změny epochy byly méně patrné
- dole je debug panel (engine, zdroj knihovny, URL, počet renderů, log chyb)

## Lokální assety (CDN jen jako fallback)

Všechny potřebné soubory jsou v repozitáři:

```text
index.html          # stránka
css/styles.css      # styly
js/app.js           # logika (tick + loader + debug)
vendor/qrcode.min.js
vendor/qrcodejs.min.js
```

Pořadí načtení QR knihovny:

1. `vendor/qrcode.min.js` (lokálně)
2. `vendor/qrcodejs.min.js` (lokálně)
3. CDN fallbacky stejných knihoven (jsDelivr / esm.sh / cdnjs)

Stránka tedy funguje i offline / bez CDN, pokud jsou lokální `vendor/` soubory dostupné.

## Spuštění

Stačí servírovat root adresáře libovolným static serverem, např.:

```bash
python3 -m http.server 4173
```

Pak otevřít `http://127.0.0.1:4173/`.

## Poznámky

- QR se přegeneruje jen když se změní epoch sekunda.
- Debug panel jde sbalit kliknutím na hlavičku; tlačítko **Copy debug** zkopíruje stav do schránky.
