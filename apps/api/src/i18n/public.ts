/** UI strings of the public watch page (fi + en). */
export const publicStrings = {
  fi: {
    notFoundTitle: 'Sivua ei löydy',
    notFoundBody: 'Linkki on virheellinen tai se ei ole enää voimassa.',
    passwordTitle: 'Salasana vaaditaan',
    passwordPrompt: 'Tämä video on suojattu salasanalla.',
    password: 'Salasana',
    open: 'Avaa',
    wrongPassword: 'Väärä salasana.',
    tooManyAttempts: 'Liian monta yritystä. Yritä myöhemmin uudelleen.',
    attachments: 'Liitteet',
    download: 'Lataa video (MP4)',
    privacy: 'Tietosuoja',
    privacyTitle: 'Tietosuojaseloste',
    play: 'Toista',
    pause: 'Tauko',
    mute: 'Mykistä',
    unmute: 'Poista mykistys',
    volume: 'Äänenvoimakkuus',
    seek: 'Aikajana',
    fullscreen: 'Koko näyttö',
    exitFullscreen: 'Poistu koko näytöstä',
    captions: 'Tekstitys',
    captionsOff: 'Ei tekstitystä',
    quality: 'Laatu',
    auto: 'Automaattinen',
    pip: 'Kuva kuvassa',
    error: 'Videota ei voitu toistaa. Lataa sivu uudelleen.',
    noscript: 'Selaimesi ei tue videon toistoa ilman JavaScriptiä. Voit katsoa videon Safarilla tai ottaa JavaScriptin käyttöön.',
  },
  en: {
    notFoundTitle: 'Page not found',
    notFoundBody: 'The link is invalid or no longer available.',
    passwordTitle: 'Password required',
    passwordPrompt: 'This video is password protected.',
    password: 'Password',
    open: 'Open',
    wrongPassword: 'Wrong password.',
    tooManyAttempts: 'Too many attempts. Please try again later.',
    attachments: 'Attachments',
    download: 'Download video (MP4)',
    privacy: 'Privacy',
    privacyTitle: 'Privacy notice',
    play: 'Play',
    pause: 'Pause',
    mute: 'Mute',
    unmute: 'Unmute',
    volume: 'Volume',
    seek: 'Seek',
    fullscreen: 'Full screen',
    exitFullscreen: 'Exit full screen',
    captions: 'Captions',
    captionsOff: 'Captions off',
    quality: 'Quality',
    auto: 'Auto',
    pip: 'Picture in picture',
    error: 'The video could not be played. Please reload the page.',
    noscript: 'Your browser cannot play this video without JavaScript. Use Safari or enable JavaScript.',
  },
} as const;

export type Lang = keyof typeof publicStrings;
export type PublicStrings = (typeof publicStrings)[Lang];

/** Picks fi/en from ?lang, Accept-Language or the configured default. */
export function pickLang(acceptLanguage: string | undefined, queryLang: unknown, fallback: Lang): Lang {
  if (queryLang === 'fi' || queryLang === 'en') return queryLang;
  const prefs = (acceptLanguage ?? '')
    .split(',')
    .map((p) => {
      const [tag, q] = p.trim().split(';q=');
      return { tag: (tag ?? '').toLowerCase(), q: q ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);
  for (const p of prefs) {
    if (p.tag.startsWith('fi')) return 'fi';
    if (p.tag.startsWith('en')) return 'en';
  }
  return fallback;
}

export const DEFAULT_PRIVACY = {
  fi: `Tämä palvelu jakaa videoita yksilöllisillä linkeillä. Kun avaat linkin, palvelin tallentaa:

- IP-osoitteesi ja sen perusteella selvitetyn verkon omistajan (paikallinen GeoIP-tietokanta, RDAP-haku alueelliseen internetrekisteriin ja käänteinen DNS-haku), maan ja kaupungin
- selaimen lähettämät tiedot: User-Agent, kieli, Client Hints, viittaava sivusto ja UTM-parametrit, Do Not Track- ja Global Privacy Control -asetukset
- videon katselun palvelimelta haettujen videosegmenttien perusteella
- painikkeiden klikkaukset ja liitteiden lataukset

Lisäksi sivu lähettää selaimesta tarkempaa katselutietoa (toisto, tauot, kelaukset, laatu) sekä selainprofiilin (näyttö, aikavyöhyke, grafiikka- ja ääniominaisuudet, fontit), jonka avulla sama katsoja tunnistetaan eri käyntikerroilla. Evästeitä ei käytetä seurantaan.

Käsittelyn tarkoitus on kertoa videon lähettäjälle, avattiinko linkki ja miten videota katsottiin. Tietoja ei luovuteta kolmansille osapuolille. Palvelinpuolen tiedot säilytetään toistaiseksi, selaimen tapahtumat 90 päivää ja selainprofiilin tiedot 180 päivää.

Voit pyytää tietojesi poistoa ottamalla yhteyttä videon lähettäjään.`,
  en: `This service shares videos through individual links. When you open a link, the server records:

- your IP address and the network owner derived from it (local GeoIP database, an RDAP query to the regional internet registry and a reverse DNS lookup), country and city
- information sent by your browser: User-Agent, language, Client Hints, referring site and UTM parameters, Do Not Track and Global Privacy Control settings
- how the video was watched, based on the video segments fetched from the server
- button clicks and attachment downloads

In addition, the page sends more detailed viewing data from the browser (play, pause, seeking, quality) and a browser profile (screen, time zone, graphics and audio capabilities, fonts) used to recognise the same viewer across visits. Cookies are not used for tracking.

The purpose is to tell the sender of the video whether the link was opened and how the video was watched. The data is not disclosed to third parties. Server-side data is kept indefinitely, browser events for 90 days and browser profile data for 180 days.

To have your data deleted, contact the sender of the video.`,
};
