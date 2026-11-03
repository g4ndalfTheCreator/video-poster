/**
 * Browser profile: every signal available without a permission prompt. Collected asynchronously with
 * a ~300 ms budget; never blocks playback. Hashes use cyrb53 (no SubtleCrypto: plain-HTTP LAN pages).
 */
const hash = (s: string) => {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(36);
};
const safe = <T>(f: () => T): T | null => {
  try {
    return f();
  } catch {
    return null;
  }
};
const timeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

const FONTS =
  'Arial,Arial Black,Arial Narrow,Calibri,Cambria,Cambria Math,Candara,Comic Sans MS,Consolas,Constantia,Corbel,Courier New,Ebrima,Franklin Gothic Medium,Gabriola,Gadugi,Georgia,Impact,Ink Free,Javanese Text,Leelawadee UI,Lucida Console,Lucida Sans Unicode,Malgun Gothic,Marlett,Microsoft Himalaya,Microsoft JhengHei,Microsoft New Tai Lue,Microsoft PhagsPa,Microsoft Sans Serif,Microsoft Tai Le,Microsoft YaHei,Microsoft Yi Baiti,MingLiU-ExtB,Mongolian Baiti,MS Gothic,MV Boli,Myanmar Text,Nirmala UI,Palatino Linotype,Segoe MDL2 Assets,Segoe Print,Segoe Script,Segoe UI,Segoe UI Emoji,Segoe UI Historic,Segoe UI Symbol,SimSun,Sitka Small,Sylfaen,Symbol,Tahoma,Times New Roman,Trebuchet MS,Verdana,Webdings,Wingdings,Yu Gothic,American Typewriter,Andale Mono,Apple Chancery,Apple Color Emoji,Apple SD Gothic Neo,AppleGothic,Avenir,Avenir Next,Baskerville,Big Caslon,Brush Script MT,Chalkboard,Chalkboard SE,Charter,Cochin,Copperplate,Didot,Futura,Geneva,Gill Sans,Helvetica,Helvetica Neue,Herculanum,Hoefler Text,Lucida Grande,Marker Felt,Menlo,Monaco,Noteworthy,Optima,Papyrus,Phosphate,Rockwell,San Francisco,Savoye LET,SF Pro,Skia,Snell Roundhand,Trattatello,Zapfino,Cantarell,DejaVu Sans,DejaVu Sans Mono,DejaVu Serif,Droid Sans,Droid Sans Mono,Fira Sans,Fira Code,FreeMono,FreeSans,FreeSerif,Liberation Mono,Liberation Sans,Liberation Serif,Noto Color Emoji,Noto Mono,Noto Sans,Noto Serif,Open Sans,Oxygen,Roboto,Roboto Mono,Source Code Pro,Ubuntu,Ubuntu Mono,Inter,Lato,Montserrat,Poppins,Raleway,Source Sans Pro,Merriweather,Playfair Display,PT Sans,PT Serif,Garamond,Book Antiqua,Bookman Old Style,Century Gothic,Century Schoolbook,Agency FB,Algerian,Bahnschrift,Bodoni MT,Calisto MT,Castellar,Elephant,Forte,Gigi,Haettenschweiler,Harrington,Jokerman,Magneto,Onyx,Perpetua,Ravie,Stencil,Tw Cen MT,Wide Latin,Aptos'.split(
    ',',
  );

function fonts(): string[] {
  const c = document.createElement('canvas').getContext('2d');
  if (!c) return [];
  const t = 'mmmmmmmmmmlli10OQ';
  const base = ['monospace', 'sans-serif', 'serif'].map(
    (b) => ((c.font = `72px ${b}`), c.measureText(t).width),
  );
  return FONTS.filter((f) =>
    ['monospace', 'sans-serif', 'serif'].some(
      (b, i) => ((c.font = `72px '${f}',${b}`), c.measureText(t).width !== base[i]),
    ),
  );
}

function canvas(): string | null {
  const el = document.createElement('canvas');
  el.width = 240;
  el.height = 60;
  const c = el.getContext('2d');
  if (!c) return null;
  c.textBaseline = 'alphabetic';
  c.fillStyle = '#f60';
  c.fillRect(100, 1, 62, 20);
  c.fillStyle = '#069';
  c.font = '15px Arial';
  c.fillText('Cwm fjordbank glyphs vext quiz, 😃', 2, 15);
  c.fillStyle = 'rgba(102,204,0,0.7)';
  c.font = '18px Times';
  c.fillText('Cwm fjordbank glyphs vext quiz', 4, 45);
  c.globalCompositeOperation = 'multiply';
  c.beginPath();
  c.arc(50, 30, 20, 0, Math.PI * 2);
  c.fillStyle = 'rgb(255,0,255)';
  c.fill();
  return hash(el.toDataURL());
}

function webgl(): Record<string, unknown> {
  const gl = document.createElement('canvas').getContext('webgl') as WebGLRenderingContext | null;
  if (!gl) return {};
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const P = [
    'MAX_TEXTURE_SIZE',
    'MAX_VIEWPORT_DIMS',
    'MAX_RENDERBUFFER_SIZE',
    'MAX_VERTEX_ATTRIBS',
    'MAX_VERTEX_UNIFORM_VECTORS',
    'MAX_FRAGMENT_UNIFORM_VECTORS',
    'ALIASED_LINE_WIDTH_RANGE',
    'ALIASED_POINT_SIZE_RANGE',
    'SHADING_LANGUAGE_VERSION',
    'VERSION',
  ] as const;
  return {
    webglVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    webglRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    webglParams: hash(P.map((p) => String(gl.getParameter(gl[p]))).join('|')),
    webglExt: hash((gl.getSupportedExtensions() ?? []).join(',')),
  };
}

async function audio(): Promise<string | null> {
  const AC =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  if (!AC) return null;
  const ctx = new AC(1, 5000, 44100);
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = 10000;
  const k = ctx.createDynamicsCompressor();
  k.threshold.value = -50;
  k.knee.value = 40;
  k.ratio.value = 12;
  o.connect(k);
  k.connect(ctx.destination);
  o.start(0);
  const buf = await ctx.startRendering();
  const d = buf.getChannelData(0);
  let s = 0;
  for (let i = 4500; i < 5000; i++) s += Math.abs(d[i]!);
  return s.toString();
}

const mq = (q: string) => matchMedia(q).matches;

export async function collectFingerprint(): Promise<{
  signals: Record<string, unknown>;
  randomized: boolean;
}> {
  const n = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { getHighEntropyValues(h: string[]): Promise<Record<string, unknown>> };
    connection?: { type?: string; effectiveType?: string; rtt?: number; downlink?: number };
    globalPrivacyControl?: boolean;
  };
  const s: Record<string, unknown> = {
    ua: n.userAgent,
    platform: n.platform,
    languages: n.languages,
    hc: n.hardwareConcurrency,
    dm: n.deviceMemory,
    tp: n.maxTouchPoints,
    cookies: n.cookieEnabled,
    pdf: n.pdfViewerEnabled,
    webdriver: n.webdriver,
    dnt: n.doNotTrack,
    gpc: n.globalPrivacyControl,
    screen: [
      screen.width,
      screen.height,
      screen.availWidth,
      screen.availHeight,
      screen.pixelDepth,
      screen.orientation?.type,
    ],
    colorDepth: screen.colorDepth,
    dpr: devicePixelRatio,
    viewport: [innerWidth, innerHeight],
    media: [
      mq('(prefers-color-scheme: dark)'),
      mq('(prefers-reduced-motion: reduce)'),
      mq('(color-gamut: p3)'),
      mq('(dynamic-range: high)'),
      mq('(forced-colors: active)'),
      mq('(pointer: coarse)'),
      mq('(hover: hover)'),
    ]
      .map(Number)
      .join(''),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tzOffset: new Date().getTimezoneOffset(),
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    intl: [
      Intl.DateTimeFormat().resolvedOptions().calendar,
      Intl.NumberFormat().resolvedOptions().numberingSystem,
      new Date(0).toLocaleString(),
      (1234567.891).toLocaleString(),
    ].join('|'),
    connection: n.connection
      ? [n.connection.type, n.connection.effectiveType, n.connection.rtt, n.connection.downlink]
      : null,
    features: [
      'serviceWorker' in n,
      'bluetooth' in n,
      'usb' in n,
      'hid' in n,
      'serial' in n,
      'xr' in n,
      'gpu' in n,
      'share' in n,
      'wakeLock' in n,
      typeof SharedArrayBuffer,
      typeof WebAssembly,
      'BarcodeDetector' in window,
      'EyeDropper' in window,
    ]
      .map((x) => (x === true || x === 'function' || x === 'object' ? 1 : 0))
      .join(''),
    fonts: safe(fonts),
    ...safe(webgl),
    canvas: safe(canvas),
  };
  const v = document.createElement('video');
  s.codecs = [
    'video/mp4; codecs="avc1.42E01E"',
    'video/mp4; codecs="hvc1"',
    'video/webm; codecs="vp9"',
    'video/mp4; codecs="av01.0.05M.08"',
    'application/vnd.apple.mpegurl',
  ]
    .map((t) => v.canPlayType(t).slice(0, 1) || '-')
    .join('');
  const tasks: unknown[] = [
    audio().then((a) => (s.audio = a)),
    n.userAgentData
      ?.getHighEntropyValues([
        'platform',
        'platformVersion',
        'architecture',
        'bitness',
        'model',
        'fullVersionList',
      ])
      .then((h) => (s.uach = h)) ?? 0,
    navigator.mediaDevices
      ?.enumerateDevices()
      .then(
        (d) =>
          (s.mediaDevices = ['audioinput', 'audiooutput', 'videoinput'].map(
            (k) => d.filter((x) => x.kind === k).length,
          )),
      ) ?? 0,
    navigator.storage?.estimate().then((e) => (s.storageQuota = e.quota)) ?? 0,
    Promise.all(
      (['notifications', 'geolocation'] as PermissionName[]).map((p) =>
        navigator.permissions
          ?.query({ name: p })
          .then((r) => r.state)
          .catch(() => null),
      ),
    ).then((p) => (s.permissions = p)),
    Promise.all(
      [
        {
          type: 'file',
          video: {
            contentType: 'video/mp4; codecs="avc1.640028"',
            width: 1920,
            height: 1080,
            bitrate: 5e6,
            framerate: 30,
          },
        },
        {
          type: 'file',
          video: {
            contentType: 'video/mp4; codecs="hvc1.1.6.L120.90"',
            width: 1920,
            height: 1080,
            bitrate: 5e6,
            framerate: 30,
          },
        },
      ].map((c) =>
        navigator.mediaCapabilities
          ?.decodingInfo(c as MediaDecodingConfiguration)
          .then((r) => `${+r.supported}${+r.smooth}${+r.powerEfficient}`)
          .catch(() => '-'),
      ),
    ).then((r) => (s.decoding = r.join(','))),
  ];
  const voices = safe(() => speechSynthesis.getVoices());
  if (voices?.length) s.voices = hash(voices.map((x) => x.name).join(','));
  await timeout(Promise.all(tasks), 300);
  // Privacy browsers randomise canvas/audio per read: render twice and compare.
  const c2 = safe(canvas);
  const a2 = await timeout(audio(), 100);
  const randomized =
    (s.canvas !== null && c2 !== s.canvas) || (s.audio != null && a2 != null && a2 !== s.audio);
  return { signals: s, randomized };
}
