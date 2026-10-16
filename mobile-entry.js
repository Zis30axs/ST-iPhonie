// Preserve the upstream extension lifecycle; the phone experiment is additive.
import * as upstream from './index.js';
import {installMobilePanel, removeMobilePanel} from './fish-mobile/panel.js';
export async function enable() { await upstream.enable(); installMobilePanel(); }
export async function disable() { removeMobilePanel(); await upstream.disable(); }
export const dispose = disable;
installMobilePanel();
