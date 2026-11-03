// Classic watch page bundle (/static/player.js)
import { boot } from './boot.js';
import { classicControls } from './controls.js';

boot((_cfg, p) => classicControls(p));
