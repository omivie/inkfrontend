/**
 * mobile-viewports — the phone box every probe in scripts/ measures at
 * ===================================================================
 *
 * ERR-280 · backend handoff `mobile-atc-dead-zone-FE-handoff-sep2026.md`
 *
 * WHAT WAS INVISIBLY WRONG WITHOUT THIS FILE
 * ------------------------------------------
 * Eight probes hand-wrote `const PHONE = { width: 390, height: 844 }` with a
 * comment saying "iPhone 13/14". 390x844 is the iPhone 13's PHYSICAL SCREEN.
 * It is not its viewport. Playwright knows the difference:
 *
 *     node -e "const {devices}=require('playwright');
 *              console.log(devices['iPhone 13'].viewport)"
 *     { width: 390, height: 664 }
 *
 * The missing 180px is Safari's own chrome — the URL bar at the top and the
 * toolbar at the bottom. So every mobile probe in this repo was measuring
 * 180px of screen that no iPhone user can see, and 180px is larger than the
 * consent banner (148px on a phone) whose overlaps those probes exist to
 * catch. At 844 the sticky Add-to-Cart bar and the consent banner do not
 * collide; at 664 they do. That is exactly how a dead zone stayed invisible
 * to a probe written to find it (ERR-280), and it is the same family as
 * ERR-238/239/240: A PROBE'S EMULATION IS PART OF ITS MEASUREMENT.
 *
 * WHY 844 IS STILL HERE AND STILL NAMED
 * -------------------------------------
 * Every number recorded in errors.md before 2026-09-22 was taken at 844 —
 * ERR-224's checkout fold, ERR-233's banner collision, ERR-238's three fixed
 * bars, ERR-276's CLS run. Deleting the constant would not make those readings
 * wrong; it would make them UNCOMPARABLE, with nothing in the tree saying why
 * a re-run prints a different number. So the old box keeps a name that states
 * what it actually is, and a probe that wants to reproduce a historical figure
 * asks for it out loud.
 *
 * `PHONE` is the default for new measurement. `PHONE_SCREEN_844` is for
 * reproducing a pre-2026-09-22 reading, and for nothing else.
 */

import { devices } from 'playwright';

/**
 * The usable viewport of an iPhone 13/13 Pro/14, straight from Playwright's
 * own device registry rather than retyped — a constant copied by hand is a
 * measurement someone declined to take, and this is the copy that was wrong.
 *
 * Frozen so a probe cannot mutate the shared box for the ones that run after
 * it in the same process.
 */
export const PHONE = Object.freeze({ ...devices['iPhone 13'].viewport });

/**
 * The iPhone 13's physical screen, which is what this repo used to call a
 * viewport. Use ONLY to reproduce a measurement recorded before 2026-09-22,
 * and say in the output that that is what you are doing.
 */
export const PHONE_SCREEN_844 = Object.freeze({ width: 390, height: 844 });

/** iOS Safari 17, for chromium runs that emulate iOS rather than run WebKit. */
export const IPHONE_UA = devices['iPhone 13'].userAgent;

/** Playwright's own scale factor for the device, not a guess. */
export const PHONE_SCALE = devices['iPhone 13'].deviceScaleFactor;

/**
 * One line a probe can print so the reader never has to guess which box a
 * number was taken in. Probes that skip this are how 844 survived in eight
 * files for four months.
 */
export function describeViewport(v) {
    if (v.width === PHONE_SCREEN_844.width && v.height === PHONE_SCREEN_844.height) {
        return `${v.width}x${v.height} (iPhone 13 PHYSICAL SCREEN — 180px taller than the real viewport, historical only)`;
    }
    if (v.width === PHONE.width && v.height === PHONE.height) {
        return `${v.width}x${v.height} (playwright devices['iPhone 13'].viewport — usable area after Safari chrome)`;
    }
    return `${v.width}x${v.height}`;
}
