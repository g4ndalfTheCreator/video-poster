// hls.js ships no typings for its "light" entry; it has the same API as the full build.
declare module 'hls.js/light' {
  export * from 'hls.js';
  export { default } from 'hls.js';
}
