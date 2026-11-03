import { readConfig } from './config.js';
import { Player } from './player.js';
import { startTelemetry } from './telemetry/index.js';

function boot() {
  const cfg = readConfig();
  const video = document.getElementById('vs-video') as HTMLVideoElement | null;
  if (!cfg || !video) return;
  const player = new Player(video, cfg);
  if (cfg.telemetry === 'full') startTelemetry(cfg, player);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
