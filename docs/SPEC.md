# Lyhytvideopalvelu – tekninen speksi Claude Codelle

Nov 3, 2026 · @Whale

## Yleiskuva ja tavoitteet

Rakennetaan itse hostattava (on-prem) palvelu, joka jakaa lyhyitä videoita (esim. CV-esittelyvideo) yksilöllisillä linkeillä ja kertoo adminille tarkasti, kuka linkin avasi ja miten videota katsottiin. Speksi on kirjoitettu Claude Codelle: koodi, tunnisteet ja kommentit englanniksi, käyttöliittymän tekstit i18n-tiedostoista (fi + en).

**Ydinidea:** yksi video voi saada monta jakolinkkiä (esim. yksi per rekrytoija tai työpaikkahakemus). Telemetria kirjataan aina linkin tasolle, jolloin admin näkee vastaanottajakohtaisesti, avattiinko video ja kuinka pitkälle sitä katsottiin.

### Tavoitteet

1. Videon upload, automaattinen transkoodaus adaptiiviseksi HLS:ksi ja pikkukuvien generointi.
2. Julkinen katselusivu, joka aukeaa vain voimassa olevalla custom-linkillä (`https://<domain>/v/<slug>`).
3. Admin-paneeli videoiden, linkkien, liitteiden ja asetusten hallintaan.
4. Täysi katselutelemetria: istunnot, katseluaika, retentiokäyrä, kohtauskohtainen drop-off, laite, maa, referrer, linkkien esikatselut (bottien hakemat previewt).
5. Kaikki data omalla palvelimella: ei kolmannen osapuolen analytiikkaa, CDN:ää, fontteja tai skriptejä.

### Rajaukset (ei MVP:ssä)

- Ei julkista rekisteröitymistä: vain admin-käyttäjät, joita on muutama.
- Ei live-striimausta eikä pitkiä videoita (oletusraja 15 min ja 2 GB, konfiguroitava).
- Ei monivuokraajuutta (multi-tenancy); yksi asennus = yksi organisaatio.
- Ei DRM:ää; suojaus perustuu linkkien arvaamattomuuteen, allekirjoitettuihin media-URL:eihin ja valinnaiseen salasanaan.

## Arkkitehtuuri ja teknologiavalinnat

Neljä konttia (nginx, api, worker, PostgreSQL) yhdessä Docker Compose -pinossa; ei Redisiä, ei objektitallennusta, ei ulkoisia palveluita. Kaikki jonot ja telemetria ovat PostgreSQLissä, mikä pitää operoinnin yksinkertaisena muutaman käyttäjän on-prem-palvelussa.

&#91;embedded content: järjestelmäarkkitehtuuri · 4 palvelua Docker Composessa\]

nginx on ainoa julkinen komponentti: se välittää sivut ja API-kutsut api-palvelulle ja tarjoilee HLS-tiedostot suoraan levyltä, kun allekirjoitettu token on voimassa. Admin-reitit sallitaan oletuksena vain VPN- tai LAN-osoitteista.

| Osa | Valinta | Perustelu |
| --- | --- | --- |
| Kieli | TypeScript (strict), Node 22 LTS | Yksi kieli koko pinossa, jaetut tyypit |
| Monorepo | pnpm workspaces | `apps/api`, `apps/worker`, `apps/admin`, `packages/shared`, `packages/player` |
| Backend | Fastify 5 + zod (fastify-type-provider-zod) | Nopea, skeemavalidointi samoista zod-skeemoista kuin frontend |
| ORM / migraatiot | Drizzle ORM + drizzle-kit | Tyypitetty SQL, selkeät migraatiot |
| Tietokanta | PostgreSQL 16 | Metadata, jonot ja telemetria samassa; tapahtumataulu osioidaan kuukausittain |
| Jono | pg-boss | Postgres-pohjainen, ei Redisiä |
| Upload | tus-protokolla (@tus/server + Uppy adminissa) | Jatkettavat uploadit isoillekin tiedostoille |
| Transkoodaus | FFmpeg 7 + ffprobe workerissa | HLS-tikkaat, vain CPU (libx264) |
| Admin-UI | React 19 + Vite + TanStack Router/Query + shadcn/ui + Recharts | SPA, tarjoillaan nginxistä polusta `/admin` |
| Katselusivu | Fastifyn SSR-template + `packages/player` (hls.js, oma kevyt kontrollipalkki) | Nopea ensilataus, Open Graph -tagit linkin esikatseluun, ei React-riippuvuutta |
| Geo-IP | Paikallinen DB-IP Lite tai MaxMind GeoLite2 (.mmdb) | Maa, kaupunki ja ASN paikallisesti; RDAP ja PTR täydentävät IP:n omistajan selvitystä |
| UA-parsinta | ua-parser-js + isbot | Laite, selain, OS ja bottien tunnistus |
| Testit | Vitest (yksikkö), Playwright (e2e), Testcontainers (Postgres) | Hyväksymiskriteerit ajettavina testeinä |

Repon rakenne:

```
video-share/
  apps/api/        # Fastify: public pages, admin API, tus, telemetry ingest
  apps/worker/     # pg-boss consumers: transcode, rollups, notifications, retention
  apps/admin/      # React SPA
  packages/shared/ # zod schemas, event types, constants
  packages/player/ # player + telemetry SDK (bundled with esbuild)
  deploy/          # docker-compose.yml, nginx.conf, .env.example
  CLAUDE.md        # conventions for Claude Code
```

## Tietomalli

Keskeinen suhde on `video 1–n share_link 1–n view_session 1–n event`: jokainen katselu kuuluu aina tiettyyn linkkiin. Kaikki id:t ovat UUIDv7 (aikajärjestys), aikaleimat `timestamptz` UTC:nä, ja poistot ovat pehmeitä (`deleted_at`) paitsi GDPR-poistoissa.

### Sisältö ja hallinta

| Taulu | Tärkeimmät kentät | Huomiot |
| --- | --- | --- |
| `admin_users` | email, password\_hash (argon2id), totp\_secret, role (`owner`, `editor`, `viewer`), last\_login\_at | `viewer` näkee vain telemetrian |
| `admin_sessions` | user\_id, token\_hash, ip, user\_agent, expires\_at | Liukuva vanhentuminen 12 h, max 7 vrk |
| `videos` | title, description, status, duration\_ms, width, height, original\_path, original\_sha256, poster\_asset\_id, created\_by | status: `uploading`, `processing`, `ready`, `failed`, `archived` |
| `video_renditions` | video\_id, height, bitrate\_kbps, codec, playlist\_path, size\_bytes | Yksi rivi per HLS-tikas |
| `assets` | video\_id, kind (`poster`, `sprite`, `sprite_vtt`, `captions`, `attachment`), path, mime, size\_bytes, lang | Liite = esim. CV-PDF katselusivulla |
| `transcode_jobs` | video\_id, state, progress\_pct, ffmpeg\_log (tail 64 kB), error, started\_at, finished\_at | Edistyminen SSE:llä adminiin |
| `share_links` | video\_id, slug (uniikki), label, recipient\_name, recipient\_org, note, password\_hash, expires\_at, max\_sessions, is\_active, allow\_download, allow\_embed, notify\_on\_open, cta\_config (jsonb) | Ks. luku Julkinen katselusivu |
| `settings` | key, value (jsonb) | Brändäys, retentio, tietosuojateksti, ilmoituskanavat |
| `notification_channels` | kind (`email`, `ntfy`, `webhook`), config (jsonb, salattu), is\_active | Ilmoitus linkin avauksesta |
| `audit_log` | actor\_user\_id, action, entity, entity\_id, diff (jsonb), ip, created\_at | Kaikki admin-muutokset ja kirjautumiset |

### Telemetria

| Taulu | Tärkeimmät kentät | Huomiot |
| --- | --- | --- |
| `view_sessions` | id, link\_id, video\_id, visitor\_id, fingerprint\_id, started\_at, last\_seen\_at, ip (`inet`), ip\_trunc, ip\_intel\_id, visitor\_hash, country, region, city, device\_type, os, browser, browser\_version, screen\_w, screen\_h, lang, tz, referrer\_host, utm (jsonb), is\_bot, bot\_name, dnt, gpc | Yksi rivi per sivulataus; raaka IP säilytetään pysyvästi, `ip_trunc` jää |
| `events` | session\_id, seq, type, client\_ts, server\_ts, position\_ms, payload (jsonb) | Osioitu kuukausittain (`PARTITION BY RANGE (server_ts)`); raakadata, lyhyt retentio |
| `session_summaries` | session\_id, watch\_ms, unique\_watched\_ms, max\_position\_ms, completion\_pct, play\_count, seek\_count, rebuffer\_count, rebuffer\_ms, startup\_ms, quality\_switches, ended, played\_ranges (int4multirange tai jsonb), cta\_clicks, attachment\_downloads, exit\_reason | Päivitetään ingestissä inkrementaalisesti ja lopullisesti istunnon sulkeutuessa |
| `visitors` | id, label (adminin antama), first\_seen\_at, last\_seen\_at, session\_count, link\_count, merged\_into | Palaava katsoja selainprofiilin perusteella |
| `browser_fingerprints` | id, visitor\_id, fp\_hash, signals (jsonb), randomized, first\_seen\_at, last\_seen\_at, seen\_count | Indeksi `fp_hash`; signaalit poistetaan retentioajan jälkeen, hash jää |
| `ip_intel` | ip tai prefix (`cidr`), asn, as\_org, rdap\_netname, rdap\_cidr, rdap\_org, rdap\_org\_handle, rdap\_country, abuse\_email, ptr, ptr\_confirmed, network\_type, org\_guess, confidence, fetched\_at, expires\_at | Välimuisti 30 pv; GiST-indeksi `inet_ops` prefiksihakuja varten |
| `ip_org_overrides` | cidr, org\_label, note, created\_by, created\_at | Adminin käsin tekemät organisaatiomerkinnät, voittavat automaattisen arvauksen |
| `link_previews` | link\_id, fetched\_at, bot\_name, ip, ip\_intel\_id, country | LinkedInBot, Slackbot, Teams, WhatsApp jne.: kertoo että linkki jaettiin eteenpäin |
| `daily_rollups` | date, video\_id, link\_id, sessions, unique\_visitors, plays, watch\_ms, completions, avg\_completion\_pct, by\_country (jsonb), by\_device (jsonb), by\_referrer (jsonb), by\_network\_type (jsonb), by\_org (jsonb) | Pysyvä, kevyt; dashboardien pääasiallinen lähde |
| `retention_buckets` | video\_id, link\_id, bucket (0–99), viewers, rewatches | 1 % pätkät; retentiokäyrä ja uudelleenkatselun heatmap |
| segment\_fetches | session\_id, ts, rendition, segment\_index, status, bytes, request\_time\_ms, http\_version, tls\_version, ja4 | Palvelinpuolen katseluseuranta ilman suostumusta; osioitu kuukausittain, säilytetään pysyvästi, vanhat osiot arkistoskeemaan |

Indeksit vähintään: `share_links(slug)` uniikki, `view_sessions(link_id, started_at desc)`, `view_sessions(video_id, started_at desc)`, `events(session_id, seq)` jokaisessa osiossa, `daily_rollups(video_id, date)`.

## Videoputki: upload, transkoodaus, toisto

Video on katsottavissa vasta, kun worker on tuottanut koko HLS-tikkaan; originaali säilytetään muuttumattomana uudelleentranskoodausta varten.

1. **Upload:** admin vetää tiedoston Uppyyn → tus-upload polkuun `/api/admin/uploads` (chunk 8 MB, jatkuu katkon jälkeen). Raja `MAX_UPLOAD_BYTES` (oletus 2 GB). Tallennus `storage/originals/<video_id>/source.<ext>`, SHA-256 lasketaan streamina.
2. **Validointi:** worker ajaa `ffprobe -v error -show_streams -show_format -of json`. Hylätään, jos ei videostriimiä, kesto > `MAX_DURATION_S` (oletus 900) tai kontti/koodekki ei ole sallittu (mp4, mov, mkv, webm; h264, hevc, vp9, av1, prores). MIME-tyyppiin tai päätteeseen ei luoteta.
3. **Transkoodaus:** pg-boss-job `transcode` (concurrency 1, konfiguroitava). HLS, fMP4/CMAF-segmentit 4 s, keyframe joka 2 s, H.264 High + AAC-LC 128 kbps 48 kHz. Tikkaat eivät skaalaa ylöspäin:
   - 1080p 5 000 kbps, 720p 2 800 kbps, 480p 1 400 kbps, 360p 800 kbps
   - Pystyvideot (esim. puhelimella kuvattu) tunnistetaan ja skaalataan lyhyemmän sivun mukaan.
   - Vain CPU-transkoodaus (libx264, preset `medium`); GPU-kiihdytys ei kuulu toteutukseen.
   - Valinnainen: äänen normalisointi `loudnorm` (EBU R128, −16 LUFS), asetus per video.
4. **Kuvat:** poster-ruutu 10 %:n kohdalta (admin voi vaihtaa aikaleimaa tai ladata oman), sprite-arkki 1 kuva / 2 s 160 px leveä + WebVTT-tiedosto scrubbaus-esikatseluun.
5. **Valinnainen MP4-latausversio** 720p:nä, jos linkillä `allow_download`.
6. **Valmis:** `master.m3u8` + rendition-playlistit kansioon `storage/hls/<video_id>/<version>/`. `version` kasvaa jokaisella uudelleentranskoodauksella, jolloin vanhat linkit eivät hajoa kesken katselun. Status `ready`, admin saa SSE-tapahtuman.
7. **Virhe:** status `failed`, ffmpeg-login loppu tallennetaan, admin voi yrittää uudelleen. Jobit ovat idempotentteja (työhakemisto `tmp/<job_id>`, atominen `rename` lopuksi).

FFmpeg ajetaan omana prosessinaan ilman verkkoyhteyttä (worker-kontti `network_mode: none` -sivuprosessille tai erillinen kontti), CPU/muistirajat Composessa. Tekstitykset: admin voi ladata WebVTT-tiedoston per kieli; SRT muunnetaan WebVTT:ksi.

**Toisto:** hls.js Chrome/Firefox/Edge, natiivi HLS Safarissa/iOS:ssä. Media-URL:t ovat muotoa `/media/<video_id>/<version>/<file>?st=<hmac>&e=<exp>`; nginx tarkistaa ne `secure_link`-moduulilla (`secure_link_md5` tai HMAC-SHA256 njs:llä), token voimassa 6 h ja sidottu `video_id`:hen ja polkuun. Token uusitaan katselusivun API:sta, jos katselu jatkuu pidempään.

## Julkinen katselusivu ja custom-linkit

Linkki on muotoa `https://<PUBLIC_HOST>/v/<slug>`; virheellinen, vanhentunut tai poistettu slug palauttaa aina saman geneerisen 404-sivun samalla vasteajalla, jotta olemassaoloa ei voi päätellä.

### Slug-säännöt

- Oletus: satunnainen 12 merkin base62 (≈ 71 bittiä), generoitu `crypto.randomBytes`-pohjaisesti.
- Custom-slug sallittu: `^[a-z0-9](?:[a-z0-9-]{2,62}[a-z0-9])$`, varatut sanat estetty (`admin`, `api`, `media`, `t`, `health` …). Admin-UI varoittaa, jos custom-slug on helposti arvattava (esim. pelkkä nimi) ja ehdottaa satunnaista loppuosaa (`whale-cv-k3x9`).
- Slugin voi vaihtaa; vanha slug jää valinnaisesti 301-uudelleenohjaukseksi tai kuolee.

### Linkin asetukset

| Asetus | Toiminta |
| --- | --- |
| `label`, `recipient_name`, `recipient_org`, `note` | Vain adminille; näkyy telemetriassa (esim. "Yritys X / rekrytoija") |
| `expires_at` | Vanhentunut linkki → 404 |
| `max_sessions` | Katselukerrat yhteensä; ylitys → 404 (botit eivät kuluta) |
| `password_hash` | Salasanasivu ennen videota, argon2id, 5 yritystä / 15 min / IP |
| `is_active` | Pikakytkin linkin sulkemiseen |
| `allow_download` | Näyttää MP4-latausnapin |
| `allow_embed` | Sallii `/e/<slug>`-upotuksen; muuten `frame-ancestors 'none'` |
| `notify_on_open` | Ilmoitus ensimmäisestä ihmisen avaamasta istunnosta (ja valinnaisesti jokaisesta) |
| `cta_config` | 0–3 painiketta videon alle (esim. "Lataa CV", "Ota yhteyttä", LinkedIn); voi ohittaa videon oletuksen |

### Sivun sisältö

- Otsikko, kuvaus, poster, soitin, tekstitysvalinta, valinnaiset liitteet (esim. CV-PDF) ja CTA-painikkeet.
- Open Graph / Twitter Card -tagit (otsikko, kuvaus, poster-URL allekirjoitettuna, pitkä voimassaolo), jotta linkki näyttää hyvältä LinkedInissä, Teamsissa ja sähköpostissa. Bottien esikatseluhaut kirjataan `link_previews`-tauluun, eivät katseluiksi.
- `X-Robots-Tag: noindex, nofollow`, `<meta name="robots" content="noindex">`, `Referrer-Policy: strict-origin-when-cross-origin`.
- Pieni tietosuojaseloste-linkki alapalkissa (teksti adminin asetuksista); suostumusbanneria ei ole.
- Ei autoplay-ääntä; autoplay mykistettynä on asetus per video.
- Saavutettavuus: näppäimistöohjaus (välilyönti, nuolet, F, M, C), ARIA-labelit, tekstitykset, WCAG 2.2 AA -kontrastit.
- Suorituskyky: sivu + soitin + telemetria-SDK alle 120 kB gzip, LCP alle 1,5 s lähiverkossa, kaikki assetit samasta originista (ei CDN:ää, ei ulkoisia fontteja).

## Admin-paneeli

Admin on React-SPA polussa `/admin`, joka puhuu vain `/api/admin/*`-rajapinnalle; ensimmäinen käynnistys ohjaa luomaan `owner`-tunnuksen (bootstrap-token tulostetaan konsoliin), minkä jälkeen rekisteröityminen on suljettu.

### Näkymät

| Näkymä | Sisältö ja toiminnot |
| --- | --- |
| Kirjautuminen | Email + salasana + TOTP (pakollinen `owner`/`editor`), valinnainen OIDC (Authentik, Keycloak) env-muuttujilla |
| Kojelauta | KPI-kortit (30 pv): istunnot, uniikit katsojat, katseluaika, keskim. katsottu %, completion rate; "katsoo nyt" -lista; viimeisimmät avatut linkit; ilmoitukset (esim. linkki avattu ensimmäistä kertaa) |
| Videot | Taulukko: poster, otsikko, kesto, status, linkkien määrä, istunnot, keskim. katsottu %; haku, suodatus statuksella, arkistointi |
| Upload | Vedä ja pudota (Uppy), useampi tiedosto jonoon, edistymispalkki uploadille ja transkoodaukselle (SSE) |
| Videon tiedot | Metatiedot, poster-valinta aikajanalta, tekstitykset, liitteet, CTA-oletukset, uudelleentranskoodaus, esikatselusoitin; välilehdet Linkit ja Analytiikka |
| Linkit | Videon linkit taulukkona: label, vastaanottaja, slug, tila, vanhenee, istunnot, viimeksi avattu, maksimi katsottu %; luonti, muokkaus, kopioi-nappi, QR-koodi, sulje, poista |
| Linkin luonti | Pikalomake: label + vastaanottaja → satunnainen slug heti; laajennetut asetukset kokoontaitettuna. Massaluonti CSV:stä (label, recipient\_name, recipient\_org) |
| Analytiikka | Ks. Telemetria-luvun dashboardit; suodattimet aikaväli, video, linkki, maa, laite, "piilota botit" |
| Istunnot | Istuntolista ja yksittäisen istunnon aikajana (tapahtumat soittimen aikajanan päällä) |
| Asetukset | Brändäys (logo, värit, footer), tietosuojateksti, telemetrian taso, retentioajat, ilmoituskanavat, admin-käyttäjät ja roolit, API-tokenit |
| Audit-loki | Suodatettava lista admin-toiminnoista |
| Järjestelmä | Levytila, jono (odottavat/epäonnistuneet jobit), versio, terveystila, varmuuskopion viimeisin ajo |

### UX-vaatimukset

- Tumma ja vaalea teema, responsiivinen (toimii puhelimella linkin luontiin ja tilastojen katseluun).
- Kaikki listat palvelinpuolen sivutuksella ja lajittelulla, URL-parametreissa (jaettavat näkymät).
- Optimistinen UI linkin aktivoinnille/sulkemiselle; vahvistusdialogi poistoille.
- Suomi ja englanti (i18next), päivämäärät `Europe/Helsinki`-aikavyöhykkeellä, asetuksista vaihdettavissa.

## Telemetria: tapahtumamalli, keruu, aggregointi, dashboardit

Telemetria kerätään kolmessa kerroksessa: raakatapahtumat (90 pv), istuntoyhteenvedot (pysyvä, anonymisoitavissa) ja päivä-/retentiorollupit (pysyvä). Dashboardit lukevat ensisijaisesti rollupeja ja yhteenvetoja, raakatapahtumia vain istunnon aikajanaan.

### Periaatteet

- Kaikki keruu omaan palvelimeen, sama origin (`/t/v1/*`), joten mainosestot eivät katko dataa. Ainoat ulospäin lähtevät kutsut ovat IP-omistajan selvityksen RDAP- ja PTR-haut, ja ne voi kytkeä pois.
- Keruu on kaksikerroksinen: palvelinpuolen telemetria, selaimen JS-telemetria ja selainprofiili ovat kaikki aina päällä, eikä sovellus kerää suostumusta. Molemmat kirjoittavat samaan `session_id`:hen.
- Raaka IP-osoite tallennetaan jokaiselle istunnolle (`view_sessions.ip`, tyyppi `inet`) ja rikastetaan omistajatiedoilla. Rinnalle tallennetaan `ip_trunc` (IPv4 /24, IPv6 /48), jota käytetään aggregoinnissa; raaka IP säilytetään pysyvästi.
- Perusyksikkö on linkkikohtainen seuranta. Palaava katsoja tunnistetaan selainprofiilista, ja varalla (esim. satunnaistava selain) päiväkohtaisella `visitor_hash`-arvolla; evästeitä ei käytetä.
- Palvelin on totuuden lähde: asiakkaan aikaleimat ja arvot validoidaan ja rajataan, johdetut metriikat lasketaan palvelimella.

### Palvelinpuolen telemetria

Palvelin kerää kaiken, minkä selain lähettää joka tapauksessa sivun ja videon toistamiseksi. Tämä kerros toimii myös silloin, kun JS-telemetria estetään (mainosesto, NoScript) tai epäonnistuu, joten jokaisesta istunnosta saadaan vähintään linkkikohtainen katselukuva.

| Tieto | Miten saadaan ilman JS-telemetriaa |
| --- | --- |
| Linkin avaus, aika, istunto | Sivupyyntö `/v/:slug`; `session_id` luodaan palvelimella ja upotetaan media-, token- ja CTA-URL:eihin (ei tallennu laitteelle) |
| Raaka IP, omistaja, verkkotyyppi, sijainti | Pyynnön lähde-IP + `ip_enrich` |
| Selain, käyttöjärjestelmä, laite, kieli | User-Agent, Accept-Language ja matalan entropian Client Hints (`Sec-CH-UA`, `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform`), jotka selain lähettää oletuksena; korkean entropian vihjeitä ei pyydetä `Accept-CH`-otsakkeella |
| Mistä tultiin | `Referer`-otsake (domain) ja UTM-parametrit URL:ssä |
| Katsotut kohdat ja retentio | HLS-segmenttien hakuloki: jokainen 4 s segmentti per istunto → katsotut välit, kelaukset (hypyt segmenttijärjestyksessä), uudelleenkatselu (sama segmentti uudelleen) ja keskeytyskohta |
| Toistoaika ja tauot | Segmenttihakujen aikajana: haut pysähtyvät, kun puskuri on täynnä ja toisto pausella |
| Laatu ja kaista | Haetun renditionin taso ja siirtonopeus nginx-lokista (`$request_time`, `$bytes_sent`) |
| CTA-klikit ja lataukset | CTA-linkit kulkevat palvelimen kautta `/go/:session/:cta` (302), liitteet ja MP4 omista URL:eistaan |
| Linkin jakaminen eteenpäin | Esikatselubottien haut (`link_previews`) |
| Yhteysominaisuudet | HTTP-versio, TLS-versio ja ALPN nginxistä; valinnaisesti JA4-TLS-fingerprint (harmaa alue, ks. Tietosuoja) |
| Uniikit katsojat | `visitor_hash` päiväkohtaisella suolalla (IP + User-Agent + Accept-Language + link\_id) |

Segmenttipohjaisen arvion tarkkuus on noin yksi segmentti (4 s). Soitin hakee segmenttejä etukäteen, joten haettu ei ole sama kuin katsottu; siksi hls.js:n `maxBufferLength` asetetaan 10 sekuntiin, ja worker arvioi katsotun kohdan hakuaikajanasta vähentämällä puskurin pituuden. Viimeiset puskuroidut segmentit merkitään "haettu, ei varmasti katsottu". Safarin natiivi HLS puskuroi omalla logiikallaan, mikä heikentää tarkkuutta.

**JS-telemetria ja selainprofiili** ladataan aina sivun mukana ilman suostumusbanneria ja tarkentavat samaa istuntoa sekuntitasolle (tapahtumakatalogi ja selainprofiili alla).

### Asiakas-SDK (`packages/player/telemetry`)

- Katselusivun SSR upottaa `ingest_token`-arvon: HMAC(link\_id, session\_id, exp 24 h). Ilman validia tokenia tapahtumia ei hyväksytä.
- `session_id` = UUIDv7, luodaan palvelimella sivulatauksen yhteydessä (yksi istunto per sivulataus).
- Tapahtumat puskuroidaan ja lähetetään erissä `fetch(keepalive)`-kutsulla 10 s välein tai kun puskurissa on 20 tapahtumaa; `pagehide` ja `visibilitychange=hidden` → `navigator.sendBeacon`.
- Jokaisella tapahtumalla juokseva `seq`, jolla palvelin deduplikoi ja järjestää. Epäonnistuneet erät uudelleen eksponentiaalisella viiveellä, max 3 kertaa.
- Heartbeat 5 s välein toiston aikana: nykyinen positio ja `played`-välit (videoelementin `TimeRanges`) delta-muodossa edellisestä heartbeatista.

### Selainprofiili ja palaavan katsojan tunnistus

SDK kerää heti `page_view`-tapahtuman jälkeen kaikki ilman lupakehotetta saatavat selainsignaalit ja lähettää ne `fingerprint`-tapahtumana; keruu on asynkroninen, aikabudjetti 300 ms, eikä se koskaan viivästä toistoa. Toteutus on oma (`packages/player/fingerprint`), ei FingerprintJS:n BSL-lisensoitua versiota.

| Ryhmä | Signaalit |
| --- | --- |
| Navigator | userAgent, UA Client Hints (`getHighEntropyValues`: platform, platformVersion, architecture, bitness, model, fullVersionList), languages, hardwareConcurrency, deviceMemory, maxTouchPoints, cookieEnabled, pdfViewerEnabled, webdriver, doNotTrack, globalPrivacyControl |
| Näyttö | width, height, availWidth, availHeight, colorDepth, pixelDepth, devicePixelRatio, orientation, matchMedia-ominaisuudet (prefers-color-scheme, prefers-reduced-motion, color-gamut, dynamic-range, forced-colors, pointer, hover) |
| Lokaali | Intl-aikavyöhyke, UTC-offset, locale, calendar, numberingSystem, päivämäärä- ja numeromuotoilun tulosteet |
| Grafiikka | WebGL vendor ja renderer (`WEBGL_debug_renderer_info`), WebGL-parametrit ja -laajennukset (hash), WebGPU-adapterin tiedot jos saatavilla, canvas 2D -renderöinnin hash |
| Ääni | OfflineAudioContext-oskillaattorin hash, sampleRate, maxChannelCount |
| Fontit | Noin 150 fontin saatavuus tekstin leveysmittauksella |
| Media | `MediaCapabilities.decodingInfo` (h264, hevc, vp9, av1), `canPlayType`-tulokset, speechSynthesis-äänilistan hash, mediaDevices-laitteiden määrä tyypeittäin (ei nimiä) |
| Ominaisuudet | API-ominaisuuksien bittikartta, `storage.estimate`-kiintiö, permissions-tilat (notifications, geolocation) kyselemättä lupaa |
| Verkko | connection.type, effectiveType, rtt, downlink |

Ei kerätä mitään, mikä vaatii lupakehotteen (sijainti, kamera, mikrofoni), eikä leikepöytää tai näppäilyjä.

- **Laskenta palvelimella:** `fp_hash` = SHA-256 kanonisoidusta vakaasta osajoukosta (pois haihtuvat: viewport, verkko, tallennuskiintiö). Täysi signaali-JSON tallennetaan `browser_fingerprints`-tauluun.
- **Täsmäytys:** sama `fp_hash` → sama katsoja (`visitors`). Lisäksi sumea täsmäys: painotettu samankaltaisuus signaaliryhmittäin ≥ 0,9 ja sama ASN tai /24 30 päivän sisällä → "todennäköisesti sama katsoja", näytetään UI:ssa luottamustasona, ei varmana.
- **Satunnaistuksen tunnistus:** canvas ja audio renderöidään kahdesti; eroavat tulokset (Brave, Firefox `resistFingerprinting`, Tor Browser) → `randomized = true` ja täsmäys vain vakaiden signaalien perusteella.
- **Hallinta:** admin voi nimetä katsojan ("Yritys X:n rekrytoija"), yhdistää kaksi katsojaa tai erottaa väärin yhdistetyn istunnon.
- Keruu on aina päällä; suostumusta ei kysytä.

### IP-osoitteen omistajan selvitys

Jokaiselle uudelle IP:lle ajetaan `ip_enrich`-job, joka selvittää verkon omistajan ja luokittelee verkon; tulokset välimuistitetaan `ip_intel`-tauluun IP:n ja allokoidun prefiksin tasolla 30 päiväksi. Suurin osa etä- ja mobiilikatsojista näkyy vain operaattorina, joten UI näyttää aina luottamustason eikä esitä arvausta faktana.

1. **Sisäverkot:** RFC 1918, CGNAT 100.64.0.0/10, loopback, link-local ja IPv6 ULA luokitellaan `lan`-tyypiksi ilman ulkoisia hakuja (tärkeä LAN-testauksessa).
2. **Paikallinen tietokanta:** maa, alue, kaupunki, ASN ja AS-organisaatio mmdb-tiedostosta (DB-IP Lite tai IPinfo Lite tai GeoLite2 ASN), päivitys kuukausittain jobilla.
3. **Käänteinen DNS:** PTR-haku ja forward-confirmed tarkistus (FCrDNS) → hostname ja domain (esim. `*.yritys.fi` tai operaattorin nimeämiskuviot kuten dsl, cable, mobile). Haut omalla resolverilla, aikakatkaisu 2 s.
4. **RDAP:** kysely oikealle RIR:lle IANA-bootstrapin kautta (esim. RIPE NCC): verkon nimi, CIDR, omistajaorganisaatio ja sen handle, maa, abuse-yhteystieto, rekisteröintipäivät. Rate limit, välimuisti allokaation tasolla.
5. **Verkkotyypin luokittelu `network_type`:** `residential_isp`, `mobile`, `business_isp`, `corporate` (oma AS tai yritykselle rekisteröity allokaatio), `hosting_cloud` (ylläpidetty lista: AWS, Azure, GCP, Hetzner, OVH, DigitalOcean …), `security_proxy` (Zscaler, Netskope, Cisco Umbrella, Prisma Access, Cloudflare WARP: kertoo yrityskäyttäjästä vaikka yritys ei näy), `vpn` (tunnetut kaupalliset VPN-ASN:t), `tor` (exit-lista päivitetään tunnin välein), `edu`, `lan`, `unknown`.
6. **Organisaatioarvaus `org_guess` + `confidence`:** korkea, kun RDAP-allokaatio on rekisteröity muulle kuin operaattorille tai PTR on yrityksen domainissa; keskitaso `security_proxy`-verkoissa; matala kotiliittymissä ja mobiilissa (näytetään operaattori ja kaupunki).
7. **Käsin korjaus:** admin voi merkitä IP:n tai prefiksin organisaatiolle (`ip_org_overrides`), ja merkintä koskee myös tulevia istuntoja.

Asetukset `ip_intel.rdap_enabled` ja `ip_intel.ptr_enabled` (oletus päällä); pois kytkettynä käytetään vain paikallista tietokantaa.

### Tapahtumakatalogi

| Tyyppi | Milloin | Payload (lisäksi `position_ms`) |
| --- | --- | --- |
| `page_view` | Sivu renderöity ja SDK käynnissä; selainprofiili lähetetään perässä omana fingerprint-tapahtumanaan | viewport, screen, dpr, lang, tz, connection.effectiveType, referrer, utm |
| `player_ready` | Manifesti ladattu | startup\_ms (sivulataus → valmis), renditions |
| `play` / `pause` | Käyttäjä tai järjestelmä | source (`user`, `autoplay`, `system`) |
| `first_frame` | Ensimmäinen ruutu näkyy | ttff\_ms |
| `heartbeat` | 5 s välein toiston aikana | played\_delta \[\[from,to\]…\], rendition, bandwidth\_kbps, buffer\_ms, volume, muted, rate |
| `seek` | Kelaus | from\_ms, to\_ms |
| `quartile` | 25/50/75/100 % uniikista sisällöstä ensimmäistä kertaa | q |
| `ended` | Video loppuun | replay\_count |
| `rebuffer_start` / `rebuffer_end` | Puskurointi toiston aikana | duration\_ms |
| `quality_change` | ABR- tai käyttäjävaihto | from, to, auto |
| `captions_toggle` | Tekstitys päälle/pois | lang |
| `fullscreen` / `pip` | Tilan vaihto | enabled |
| `volume_change` | Mykistys/äänenvoimakkuus (debounce 1 s) | volume, muted |
| `visibility` | Välilehti piiloon/näkyviin | state |
| `cta_click` | CTA-painike | cta\_id, href\_host |
| `attachment_download` | Liitteen lataus | asset\_id |
| `video_download` | MP4-lataus | – |
| `error` | Soitin- tai verkkovirhe | code, fatal, message (max 200 merkkiä) |
| `session_end` | `pagehide` | exit\_reason (`closed`, `navigated`, `idle`) |

Palvelin tuottaa itse lisäksi `password_ok`/`password_fail`, `link_expired_hit`, `preview_fetch` ja `session_timeout` (ei tapahtumia 30 min).

### Ingest-putki

1. `POST /t/v1/events` (JSON-erä, max 64 kB, max 50 tapahtumaa) → nginx rate limit 30 r/min/IP.
2. Validoi `ingest_token` ja zod-skeema; tuntemattomat kentät pudotetaan, merkkijonot katkaistaan.
3. Deduplikointi `(session_id, seq)` ja `server_ts`-leima; yli 10 min tulevaisuuteen tai 24 h menneisyyteen olevat `client_ts`-arvot merkitään epäluotettaviksi.
4. Ensimmäisellä erällä istunto `view_sessions`-tauluun: raaka IP (selvitetty `TRUSTED_PROXIES`-säännöillä), `ip_trunc`, UA-parsinta ja bottitunnistus (isbot + headless-merkit: `navigator.webdriver`, puuttuvat näyttömitat, nolla vuorovaikutusta), maa, kaupunki ja ASN paikallisesta mmdb:stä heti, `visitor_hash`. `ip_enrich`-job jonoon, jos IP:tä ei ole välimuistissa.
5. `fingerprint`-tapahtuma: signaalit `browser_fingerprints`-tauluun, `fp_hash` lasketaan ja `match_visitor`-job liittää istunnon katsojaan.
6. Insert `events`-tauluun ja inkrementaalinen päivitys `session_summaries`-riville samassa transaktiossa (`played_ranges` yhdistetään välien unionina).
7. Ensimmäinen ihmisen `play` linkillä, jolla `notify_on_open` → pg-boss-job `notify` sähköpostiin (SMTP) ja ntfy:hin: "Linkki 'Yritys X' avattiin – Helsinki, desktop, verkko: Elisa (kotiliittymä), palaava katsoja: ei". Ilmoitus odottaa `ip_enrich`-jobia enintään 10 s. Toinen ilmoitus valinnaisesti istunnon päätyttyä yhteenvedolla.
8. Worker sulkee istunnot 30 min passiivisuuden jälkeen, laskee lopulliset arvot ja päivittää `daily_rollups`- ja `retention_buckets`-rivit (job 5 min välein + yöllinen täysi uudelleenlaskenta edelliselle päivälle).
9. Live-näkymä: aktiiviset istunnot (heartbeat < 15 s sitten) PostgreSQL `LISTEN/NOTIFY` → SSE adminiin.

**Palvelinpuolen putki:** nginx kirjoittaa JSON-access-lokin, jossa on `session_id` (purettu media-tokenista), polku, rendition, segmentin indeksi, tila, tavut, `$request_time`, HTTP- ja TLS-versio. Worker lukee lokia syslog-socketista, kirjoittaa rivit `segment_fetches`-tauluun ja päivittää `session_summaries`-rivin kentällä `source = server`. Kun JS-telemetria on käytössä, sen tarkemmat arvot korvaavat palvelinarvion (`source = client`), mutta molemmat säilytetään vertailua varten.

### Metriikoiden määritelmät

| Metriikka | Määritelmä |
| --- | --- |
| Istunto | Yksi sivulataus validilla linkillä, ei botti |
| Katselu (view) | Istunto, jossa toistoa on vähintään 2 s (`unique_watched_ms ≥ 2000`) |
| Uniikki katsoja | Erilliset `visitor_hash`-arvot päivässä, tai kun selainprofiili on saatavilla, erilliset visitors-rivit (toimii linkkien ja päivien yli) |
| Katseluaika | Toistettu aika yhteensä, uudelleenkatselut mukaan lukien |
| Uniikki katseluaika | `played_ranges`-unionin pituus |
| Katsottu % | uniikki katseluaika / videon kesto |
| Completion rate | Katselut, joissa katsottu % ≥ 95, / kaikki katselut |
| Retentio bucketissa b | Osuus katseluista, joiden `played_ranges` kattaa bucketin b (1 % kestosta) |
| Uudelleenkatselu bucketissa b | Kuinka monessa katselussa bucket toistettiin useammin kuin kerran |
| Startup time | Sivulataus → ensimmäinen ruutu (p50, p95) |
| Rebuffer ratio | rebuffer\_ms / (katseluaika + rebuffer\_ms) |

### Dashboardit

- **Yleiskatsaus:** KPI-kortit vertailuna edelliseen jaksoon; istunnot ja katselut päivittäin (viivakaavio); top-videot ja -linkit.
- **Video:** retentiokäyrä (0–100 %) poster-spritekuvilla x-akselilla; uudelleenkatselu-heatmap samalla akselilla; suurimmat pudotuskohdat listattuna aikaleimoineen (klikkaus avaa soittimen siihen kohtaan); laite-, maa- ja referrer-jakaumat; linkkivertailu taulukkona.
- **Linkki (vastaanottaja):** avattiinko, milloin ensimmäisen ja viimeisen kerran, istuntojen määrä, maksimi katsottu %, liitteiden lataukset ja CTA-klikit, esikatseluhaut (eli linkki jaettiin esim. Teamsissa), sijainti, laite, IP-osoite, verkon omistaja, verkkotyyppi ja luottamustaso per istunto sekä tieto, onko sama katsoja nähty muilla linkeillä.
- **Istunnon aikajana:** soittimen aikajana, jonka päälle piirretään toistetut välit, kelaukset, taukot ja puskuroinnit; tapahtumalista vieressä.
- **Laatu:** startup time p50/p95, rebuffer ratio, virheet tyypeittäin, renditionien käyttöosuudet, selainkohtaiset virheet.
- **Vienti:** CSV- ja JSON-vienti jokaisesta näkymästä; read-only API-token Grafanaa tai omaa raportointia varten (`/api/admin/analytics/*`).

### Datan laatu ja testattavuus

- Yksikkötestit välien unionille, retention laskennalle ja kvartiileille (myös kelaus taaksepäin, 2× nopeus, pystyvideo, keskeytynyt istunto).
- Playwright-testi, joka toistaa videon 0–30 %, kelaa 60 %:iin ja sulkee sivun; odotetut `session_summaries`-arvot tarkistetaan.
- Synteettisen datan generaattori (`pnpm seed:telemetry`) dashboardien kehittämiseen.

## Tietosuoja ja GDPR

Katsojat (esim. rekrytoijat) ovat rekisteröityjä, joten telemetria on henkilötietojen käsittelyä myös ilman evästeitä; järjestelmä suunnitellaan niin, että rekisterinpitäjä voi toimia lain mukaan, mutta oikeudellinen arvio (oikeusperuste, tasapainotesti, seloste) on käyttöönottajan tehtävä. Tämä luku on suunnitteluohje, ei oikeudellinen neuvo.

### Telemetriatasot (asetus `telemetry.level`)

| Taso | Mitä kerätään |
| --- | --- |
| `full` (oletus) | Palvelinpuolen telemetria + JS-tapahtumakatalogi sekuntitarkkuudella + selainprofiili ja palaavan katsojan tunnistus |
| `server` | Vain palvelinpuolen telemetria: raaka IP ja omistaja, otsakkeet, segmenttipohjainen katselu ja retentio, CTA-klikit, lataukset, esikatselut |
| `minimal` | Linkin avaus, segmenttipohjainen katsottu %, laitetyyppi, maa; IP vain katkaistuna, ei omistajaselvitystä |

Sovellus ei kerää suostumusta millään tasolla, eikä katselusivulla ole banneria.

Tiedossa oleva riski: EU:ssa sähköisen viestinnän palveluista annetun lain 205 § (ePrivacy-direktiivin 5(3) artikla) ja EDPB:n ohje 2/2023 edellyttävät suostumusta selaimesta skriptillä luettavalle tiedolle ja fingerprintingille. `full`-taso ilman suostumusta sopii siis lähiverkkotestaukseen, mutta julkisessa käytössä EU-katsojille se on todennäköisesti lainvastainen; silloin vaihtoehto on `server`-taso tai suostumuksen lisääminen myöhemmin. Tasoa voi vaihtaa asetuksista ilman koodimuutosta.

Harmaa alue: ohje voi kattaa myös passiivisesti lähetettyjen tietojen käytön seurantaan. Lähimpänä tätä ovat JA4-TLS-fingerprint ja `visitor_hash`, joten JA4 on oletuksena pois (`server_telemetry.ja4 = false`).

GDPR koskee silti kaikkea, myös palvelinpuolen keruuta: raaka IP, omistajaselvitys ja katseluhistoria ovat henkilötietoja. Suostumusta ei tarvita, kun perusteena on oikeutettu etu, mutta se edellyttää tasapainotestiä ja selostetta katsojille. Pysyvä säilytys on ristiriidassa säilytyksen rajoittamisen periaatteen kanssa (GDPR 5 art. 1 e), ellei sille ole kirjattua perustetta, joten tästä kannattaa tehdä tietoinen päätös ennen julkista käyttöä. Arvio on käyttöönottajan; Traficomin ja tietosuojavaltuutetun ohjeet kannattaa tarkistaa.

### Toteutettavat ominaisuudet

- Tietosuojaseloste-sivu `/privacy` (teksti asetuksista, oletuspohja fi + en), linkki jokaisen katselusivun alapalkissa. Pohja kuvaa palvelinpuolen keruun (IP, otsakkeet, segmenttihaut), omistajaselvityksen (RDAP, PTR), JS-telemetrian, selainprofiilin, käsittelyn perusteen ja säilytysajan.
- Do Not Track- ja Global Privacy Control -otsakkeet tallennetaan istuntoon (`dnt`, `gpc`), mutta ne eivät muuta keruuta.
- Säilytys: palvelinpuolen data säilytetään pysyvästi ilman automaattisia poistoja: `view_sessions` raaka IP mukaan lukien, `segment_fetches`, `session_summaries`, `link_previews`, `ip_intel` (rivit jäävät historiaksi, 30 pv TTL koskee vain uudelleenhakua) ja rollupit. JS-tapahtumat (`events`) säilytetään 90 pv ja profiilin signaalit 180 pv, minkä jälkeen jää `fp_hash`. Yli 12 kk vanhat kuukausiosiot siirretään arkistoskeemaan, jossa ne ovat edelleen kyseltävissä. Asetus `server_data.retention` (oletus `forever`) säilyy, jotta rajan voi ottaa käyttöön myöhemmin ilman koodimuutosta.
- Rekisteröidyn oikeudet: admin voi hakea istunnot linkin, ajan, IP-osoitteen, IP-prefiksin tai katsojan perusteella, viedä ne JSON-muodossa ja poistaa ne kokonaan (kova poisto `events`, `segment_fetches`, `view_sessions`, `session_summaries`, `browser_fingerprints`, `visitors`; rollupit lasketaan uudelleen). Vastustamisoikeus: IP tai prefiksi voidaan lisätä estolistalle, jolloin siitä tulevia istuntoja ei tallenneta.
- Linkin poisto kysyy, poistetaanko myös sen telemetria.
- Ei kolmansia osapuolia katselusivulla (CSP pakottaa tämän). Palvelimelta lähtevät vain RDAP-kyselyt RIR:lle ja PTR-haut omalle resolverille, mikä paljastaa niille kysytyn IP:n; molemmat voi kytkeä pois.
- Videot itse sisältävät lataajan henkilötietoja: originaalit ja HLS-tiedostot poistetaan kovalla poistolla, kun video poistetaan lopullisesti (roskakori 30 pv).

## Tietoturva

Julkinen hyökkäyspinta rajataan kolmeen reittiin (`/v`, `/media`, `/t`) ja admin eristetään verkkotasolla; kaikki muu on toissijaista suojausta.

| Alue | Vaatimus |
| --- | --- |
| Verkko | `/admin` ja `/api/admin` sallitaan vain `ADMIN_ALLOW_CIDRS`-listasta (oletus RFC1918 + WireGuard-verkko); vaihtoehtona erillinen `ADMIN_HOST`, jota ei julkaista internetiin |
| Autentikointi | argon2id (m=64 MB, t=3, p=1), TOTP pakollinen kirjoitusoikeuksille, kirjautumisen rate limit + lukitus 10 epäonnistumisen jälkeen 15 min, kirjautumiset audit-lokiin |
| Sessiot | Satunnainen 256-bittinen token, kannassa vain hash, eväste `HttpOnly; Secure; SameSite=Strict; Path=/`, CSRF-token muuttaville kutsuille |
| Valtuutus | Roolitarkistus jokaisessa reitissä Fastify-hookilla; testit, jotka varmistavat että `viewer` ei voi muuttaa mitään |
| Linkit | Satunnaiset slugit, yhtenäinen 404, slug-haun rate limit 60 r/min/IP, salasanayritysten rajoitus |
| Media | `secure_link`-allekirjoitetut URL:t, ei hakemistolistauksia, `Content-Type` palvelimen määräämä, originaalit eivät koskaan julkisesti saatavilla |
| Upload | Vain admin, koko- ja kestorajat, ffprobe-validointi, tiedostonimet generoidaan (käyttäjän nimeä ei käytetä polussa), FFmpeg ilman verkkoa ja resurssirajoin |
| HTTP-otsakkeet | CSP `default-src 'self'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'` (tai sallitut originit embedille), HSTS, `X-Content-Type-Options: nosniff`, `Permissions-Policy` minimiin |
| Ingest | Allekirjoitettu `ingest_token`, kokorajat, skeemavalidointi, rate limit; telemetria ei voi kirjoittaa muuhun kuin oman istuntonsa riveihin |
| Salaisuudet | `.env` / Docker secrets; ilmoituskanavien tunnukset salataan kantaan (libsodium secretbox, avain `APP_ENCRYPTION_KEY`) |
| Riippuvuudet | `pnpm audit` CI:ssä, lukitut versiot, CycloneDX-SBOM build-vaiheessa (`@cyclonedx/cyclonedx-npm`) jatkuvaa haavoittuvuusseurantaa varten |
| Kontit | Non-root-käyttäjä, read-only root FS (paitsi data- ja tmp-volyymit), `cap_drop: [ALL]`, `no-new-privileges` |
| IP- ja profiilidata | Raaka IP, PTR ja selainprofiilin signaalit näkyvät vain owner- ja editor-rooleille; viewer näkee maan, verkkotyypin ja organisaation. Jokainen haku IP:llä tai katsojalla kirjataan audit-lokiin. RDAP- ja PTR-vastaukset käsitellään epäluotettavana syötteenä (kokoraja, aikakatkaisu, ei HTML:ää UI:hin). |

## API-rajapinta

REST + JSON, skeemat zodista `packages/shared`-paketissa, OpenAPI 3.1 generoidaan automaattisesti (`/api/admin/openapi.json`, näkyy vain adminille). Virheet muodossa `{ error: { code, message, details? } }`.

### Julkinen

| Metodi | Polku | Kuvaus |
| --- | --- | --- |
| GET | `/v/:slug` | Katselusivu (SSR) tai salasanasivu |
| POST | `/v/:slug/unlock` | Salasanan tarkistus → lyhytikäinen eväste `link_unlock` |
| GET | `/e/:slug` | Upotettava soitin (jos `allow_embed`) |
| GET | `/api/public/links/:slug/playback` | Uusi media-token ja manifesti-URL |
| GET | `/api/public/links/:slug/attachments/:assetId` | Liitteen lataus (kirjataan tapahtumaksi) |
| POST | `/t/v1/events` | Telemetriaerä |
| POST | `/t/v1/beacon` | sendBeacon-versio (text/plain-body) |
| GET | `/media/...` | nginx tarjoilee suoraan, `secure_link` |
| GET | `/privacy`, `/healthz` | Tietosuojaseloste, terveystarkistus |

### Admin (`/api/admin`)

| Metodi | Polku | Kuvaus |
| --- | --- | --- |
| POST | `/auth/login`, `/auth/totp`, `/auth/logout` | Kirjautuminen |
| GET | `/me` | Nykyinen käyttäjä |
| POST, PATCH, HEAD | `/uploads` (tus) | Upload |
| GET, POST | `/videos` | Lista, luonti uploadista |
| GET, PATCH, DELETE | `/videos/:id` | Tiedot, muokkaus, poisto |
| POST | `/videos/:id/retranscode`, `/videos/:id/poster` | Uudelleentranskoodaus, posterin vaihto |
| GET, POST, DELETE | `/videos/:id/assets` | Tekstitykset ja liitteet |
| GET | `/videos/:id/events` (SSE) | Transkoodauksen edistyminen |
| GET, POST | `/videos/:id/links` | Linkit, luonti |
| POST | `/videos/:id/links/bulk` | Massaluonti CSV:stä |
| GET, PATCH, DELETE | `/links/:id` | Linkin hallinta |
| GET | `/analytics/overview?from&to` | KPI:t ja aikasarja |
| GET | `/analytics/videos/:id?from&to&link` | Retentio, jakaumat, pudotuskohdat |
| GET | `/analytics/links/:id` | Vastaanottajanäkymä |
| GET | `/analytics/sessions?filters` | Istuntolista |
| GET, DELETE | `/analytics/sessions/:id` | Istunnon aikajana, GDPR-poisto |
| GET | `/analytics/live` (SSE) | Katsoo nyt |
| GET | `/analytics/export?format=csv\|json` | Vienti |
| GET, PUT | `/settings` | Asetukset |
| GET, POST, PATCH, DELETE | `/users`, `/notification-channels`, `/api-tokens` | Hallinta |
| GET | `/audit-log`, `/system` | Audit-loki, järjestelmän tila |

## Deploy ja operointi on-prem

Ensisijainen jakelumuoto on `deploy/docker-compose.yml`, joka käynnistyy yhdellä `docker compose up -d` -komennolla tyhjälle Linux-palvelimelle tai VM:lle; NixOS-moduuli on erillinen jatkovaihe.

- **Palvelut:** `nginx` (portit 80/443), `api`, `worker` (skaalattavissa `--scale worker=N`), `postgres:16` (ei julkaistua porttia), valinnainen `certbot` tai ACME nginxin ulkopuolella. Yksi Docker-image api:lle ja workerille, eri `command`.
- **Volyymit:** `/srv/video-share/media` (originaalit, HLS, kuvat; suositus oma ZFS-datasetti, `recordsize=1M`, `compression=off` mediaosiolle), `/srv/video-share/pg`, `/srv/video-share/geoip`.
- **Konfiguraatio env-muuttujilla:** `PUBLIC_HOST`, `ADMIN_HOST`, `ADMIN_ALLOW_CIDRS`, `DATABASE_URL`, `MEDIA_ROOT`, `MEDIA_SIGNING_KEY`, `INGEST_SIGNING_KEY`, `APP_ENCRYPTION_KEY`, `MAX_UPLOAD_BYTES`, `MAX_DURATION_S`, `TRANSCODE_CONCURRENCY`, `SMTP_*`, `OIDC_*`. `.env.example` dokumentoi jokaisen; puuttuva pakollinen arvo kaataa käynnistyksen selkeällä virheellä.
- **Julkaisu:** päätetään myöhemmin, eikä toteutus saa olettaa tiettyä tapaa. MVP:n tavoite on testaus lähiverkossa: nginx kuuntelee LAN-osoitteessa, TLS paikallisen CA:n varmenteella (mkcert tai step-ca) tai pelkkä HTTP kehitystilassa, ja PUBLIC\_HOST voi olla LAN-nimi tai IP. Myöhempi internet-julkaisu ei saa vaatia koodimuutoksia; nginx-konfiguraatio luottaa `X-Forwarded-For`-arvoon vain `TRUSTED_PROXIES`-listalta (muuten geo-IP ja rate limit menevät väärin).
- **Migraatiot:** api ajaa Drizzle-migraatiot käynnistyksessä advisory lockin alla; tapahtumataulun osiot luodaan 3 kk eteenpäin yöllisellä jobilla.
- **Varmuuskopiot:** yöllinen `pg_dump -Fc` mediavolyymille, mediaan ZFS-snapshotit tai restic. Palautusohje `deploy/RESTORE.md` ja testi, joka palauttaa dumpin tyhjään kantaan.
- **Palvelun oma monitorointi:** `/metrics` Prometheus-formaatissa (vain sisäverkosta): HTTP-latenssit, ingest-tapahtumat/s, jonon pituus, transkoodauksen kesto, levytila. Rakenteinen JSON-loki (pino), ei henkilötietoja lokissa (IP katkaistu, tokenit maskattu). Tämä on erillään katsojatelemetriasta.
- **Päivitys:** `docker compose pull && docker compose up -d`; semver-tagit, CHANGELOG, migraatiot vain eteenpäin.
- **Mitoitus (arvio):** 2 vCPU / 4 GB RAM riittää api:lle, workerille ja Postgresille pienellä käytöllä; 2 min 1080p-videon CPU-transkoodaus kestää tyypillisesti muutaman minuutin. Levyä noin 2–3× originaalin koko.

## Toteutusvaiheet ja hyväksymiskriteerit Claude Codelle

Toteuta vaiheet järjestyksessä; jokainen vaihe on valmis vasta, kun sen hyväksymiskriteerit ovat ajettavina testeinä vihreinä ja `docker compose up` toimii puhtaalta pöydältä.

### Työskentelyohjeet

- Lue tämä speksi ja luo ensin `CLAUDE.md` (konventiot, komennot, hakemistot) ja `docs/DECISIONS.md`, johon kirjataan jokainen tästä speksistä poikkeava päätös perusteluineen.
- TypeScript `strict`, ESLint + Prettier, ei `any`-tyyppejä ilman kommenttia. Jaetut tyypit ja skeemat vain `packages/shared`-paketissa.
- Jokainen tietokantamuutos migraationa; ei käsin ajettavia SQL-skriptejä.
- Pienet commitit vaiheittain (Conventional Commits). Älä lisää ulkoisia SaaS-riippuvuuksia, CDN-linkkejä tai telemetriaa kolmansille osapuolille.
- Kun speksi on epäselvä, valitse yksinkertaisin turvallinen ratkaisu, kirjaa se `DECISIONS.md`-tiedostoon ja jatka.

### Vaiheet

1. **M0 Runko:** monorepo, Compose (nginx, api, worker, postgres), migraatiot, `/healthz`, CI (lint, typecheck, test).
   - Hyväksyntä: `pnpm test` ja `docker compose up` vihreät; `/healthz` palauttaa 200 ja kannan tilan.
2. **M1 Admin-auth:** bootstrap, kirjautuminen, TOTP, sessiot, roolit, audit-loki, CIDR-rajaus.
   - Hyväksyntä: e2e-testi kirjautumisesta TOTP:lla; `viewer` saa 403 kaikista muuttavista kutsuista; admin-reitti estetty ulkopuolisesta IP:stä.
3. **M2 Videoputki:** tus-upload, ffprobe-validointi, HLS-tikkaat, poster, sprite, SSE-edistyminen, uudelleenyritys.
   - Hyväksyntä: testivideo (`fixtures/sample-1080p.mp4`, 30 s) on tilassa `ready` ja kaikki 4 renditionia ovat olemassa; virheellinen tiedosto saa tilan `failed` ja virheviestin.
4. **M3 Linkit ja katselusivu:** slugit, linkkiasetukset, salasana, vanheneminen, allekirjoitetut media-URL:t, OG-tagit, soitin, liitteet, CTA.
   - Hyväksyntä: Playwright toistaa videon Chromiumissa ja WebKitissä; vanhentunut ja olematon slug antavat identtisen 404:n; media-URL ilman tokenia tai vanhentuneella tokenilla saa 403:n.
5. **M4 Telemetrian keruu:** SDK, ingest, bottitunnistus, geo-IP, istuntoyhteenvedot, ilmoitus linkin avauksesta.
   - Hyväksyntä: JS estettynä toisto 0–50 % tuottaa segmenttilokista katsotun osuuden ±8 s tarkkuudella, eikä selain lähetä yhtään telemetriapyyntöä; JS:n kanssa Playwright-skenaario (toisto 0–30 %, kelaus 60 %:iin, toisto 70 %:iin, sivun sulku) tuottaa `unique_watched_ms` ±1 s tarkkuudella ja oikeat kvartiilit; LinkedInBot-UA kirjautuu `link_previews`-tauluun eikä istunnoksi; ntfy- ja sähköposti-ilmoitus lähtee kerran; 10.0.0.0/8-osoite luokitellaan lan-tyypiksi ilman ulkoisia hakuja; julkinen testi-IP saa ASN-, RDAP- ja PTR-tiedot välimuistiin; sama selain kahdella eri linkillä liitetään samaan katsojaan.
6. **M5 Aggregointi ja dashboardit:** rollupit, retentio, kaikki dashboard-näkymät, live-näkymä, vienti.
   - Hyväksyntä: seed-datalla dashboardit latautuvat alle 500 ms (100 000 istuntoa); rollupien uudelleenlaskenta tuottaa samat luvut kuin raakadatasta laskettu kysely.
7. **M6 Tietosuoja ja kovennus:** telemetriatasot, `DNT/GPC-kirjaus`, retentiojobit, GDPR-haku/vienti/poisto, CSP ja muut otsakkeet, konttien kovennus.
   - Hyväksyntä: `minimal`-tasolla ei tallennu raakaa IP:tä eikä selainprofiilia; retentiojob poistaa vanhentuneen osion; securityheaders-tyyppinen tarkistus läpäisee (A); katselusivu ei tee yhtään pyyntöä ulkoiseen originiin.
8. **M7 Operointi:** varmuuskopio- ja palautusohjeet, `/metrics`, päivitysdokumentaatio, README asennusohjeella. Valinnainen: NixOS-moduuli (`services.video-share`).

### Avoimet kysymykset

- Domain ja julkaisutapa: porttiohjaus vai olemassa oleva reverse proxy / tunneli?
- Tarvitaanko `extended`-taso (palaavan katsojan tunnistus) ollenkaan, vai riittääkö linkkikohtainen seuranta?
- Mitkä ilmoituskanavat ensin: sähköposti, ntfy vai Matrix?
- Onko GPU-kiihdytetty transkoodaus tarpeen, vai riittääkö CPU lyhyille videoille?

Päätökset 3.11.2026:

- Julkaisutapa päätetään myöhemmin; toteutuksen tavoite on testaus lähiverkossa.
- Linkkikohtainen seuranta on perusyksikkö; palaava katsoja tunnistetaan selainprofiilista ja kaikki ilman lupakehotetta saatavat selainsignaalit kerätään. Raaka IP tallennetaan ja sen omistaja pyritään selvittämään.
- Ilmoituskanavat: ntfy ja sähköposti.
- Transkoodaus vain CPU:lla.

Lisäpäätökset: kaikki mahdollinen telemetria kerätään, palvelinpuolen data säilytetään pysyvästi, eikä sovellus kerää suostumusta (JS-telemetria ja selainprofiili aina päällä).
