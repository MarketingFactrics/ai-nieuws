# AI Nieuws

Rustig bijblijven met Claude en Claude Code, in plaats van doomscrollen. Elke avond een beperkte editie (max. 12 items) met video's, artikelen, releasenotes en discussies, en een duidelijk einde.

## Hoe het werkt

- `scripts/fetch_feed.py` haalt nieuws op uit de bronnen in `sources.json` en schrijft `data/feed.json`.
- De GitHub Action `.github/workflows/ai-nieuws.yml` draait dit elke dag om 16:30 UTC (17:30 winter / 18:30 zomer) en commit het resultaat.
- GitHub Pages serveert de app (`index.html`, `app.js`, `styles.css`). Bewaarde items staan in de opslag van je iPhone (localStorage).

## Nederlandse vertaling

Titels, samenvattingen en releasenotes worden gratis vertaald via Google Translate (zonder sleutel). Lukt dat een keer niet, dan blijft dat item Engels.

## Op je iPhone

Open de Pages-link in **Safari** → deelknop → **Zet op beginscherm**. Gebruik daarna altijd het icoon op je beginscherm (die heeft z'n eigen opslag voor je bewaarde items).

## Bronnen aanpassen

Bewerk `sources.json`: YouTube-kanalen (channel id), subreddits, trefwoorden. Een channel id vind je in de paginabron van een kanaal (`"externalId":"UC..."`).

Handmatig een nieuwe editie maken: GitHub → Actions → *AI Nieuws samenstellen* → *Run workflow*.
