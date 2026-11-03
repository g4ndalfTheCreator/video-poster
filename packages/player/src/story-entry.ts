// Story page bundle (/static/story.js)
import { boot } from './boot.js';
import { startStory } from './story.js';

boot((cfg, p) => startStory(cfg, p));
