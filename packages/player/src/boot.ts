import { readConfig, type PageConfig } from './config.js';
import { Player } from './player.js';
import { startTelemetry } from './telemetry/index.js';

/** Shared bootstrap for both page bundles. */
export function boot(ui: (cfg: PageConfig, p: Player) => void): void {
  const run = () => {
    const cfg = readConfig();
    const video = document.getElementById('vs-video') as HTMLVideoElement | null;
    if (!cfg || !video) return;
    const player = new Player(video, cfg);
    if (cfg.telemetry === 'full') startTelemetry(cfg, player);
    ui(cfg, player);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
}
