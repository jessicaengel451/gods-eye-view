/**
 * Xbox / standard-gamepad camera control.
 *
 * Polls `navigator.getGamepads()` on every animation frame (independent of
 * Cesium's own render loop, so it keeps working while the scene is idle —
 * see renderGovernor.js) and drives the camera the same way a flight stick
 * would:
 *   - Left stick: pan (forward/back, strafe left/right).
 *   - Right stick: look (heading left/right, pitch up/down).
 *   - Right trigger: ascend. Left trigger: descend.
 *   - Bumpers (LB/RB): step to the previous/next curated location — the same
 *     cities the LOCATIONS panel's pills fly to.
 * Speeds scale with camera height so the feel stays consistent from a few
 * hundred metres up to orbit, the same trick the voice camera verbs use.
 *
 * Any active input is a manual-camera reflex, same as pointerdown/wheel: it
 * interrupts a running camera verb (see cameraVerbs.js) so the controller
 * always takes the camera back from an in-flight voice motion.
 */

import * as Cesium from 'cesium';
import { governorRequestRender } from './renderGovernor.js';
import { interruptCameraMotion } from './cameraVerbs.js';
import { CITY_POIS, flyToPresetLocation } from './locations.js';

const DEADZONE = 0.15;
const TRIGGER_THRESHOLD = 0.05;
const LOOK_DEG_S = 90;
const PAN_VIEW_FRACTION_S = 0.6;
const VERTICAL_VIEW_FRACTION_S = 0.5;
const PITCH_MIN = Cesium.Math.toRadians(-89);
const PITCH_MAX = Cesium.Math.toRadians(60);
/** Standard gamepad mapping button indices (Xbox: LB/RB, LT/RT). */
const BUTTON_LB = 4;
const BUTTON_RB = 5;
const BUTTON_LT = 6;
const BUTTON_RT = 7;

/**
 * Deadzone + quadratic response curve: kills stick noise near centre, keeps
 * fine control near it, and reaches full speed at full deflection.
 * @param {number} value Raw axis value, -1..1.
 * @param {number} [deadzone] Fraction of travel to ignore near centre.
 * @returns {number} Shaped value, -1..1.
 */
export function shapeAxis(value, deadzone = DEADZONE) {
  const v = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  const mag = Math.abs(v);
  if (mag < deadzone) return 0;
  const scaled = (mag - deadzone) / (1 - deadzone);
  return Math.sign(v) * scaled * scaled;
}

/** @returns {number} A button's analog value (0..1), digital buttons read as 0 or 1. */
export function buttonValue(pad, index) {
  const button = pad?.buttons?.[index];
  if (!button) return 0;
  return typeof button.value === 'number'
    ? button.value
    : button.pressed
      ? 1
      : 0;
}

function triggerValue(pad, index) {
  const value = buttonValue(pad, index);
  return value > TRIGGER_THRESHOLD ? value : 0;
}

/** @returns {boolean} Whether a button reads as held down right now. */
export function isButtonPressed(pad, index) {
  const button = pad?.buttons?.[index];
  if (!button) return false;
  return typeof button.pressed === 'boolean'
    ? button.pressed
    : buttonValue(pad, index) > 0.5;
}

/**
 * Step a wrapping location index by +1/-1. Pure, so the bumper-cycling logic
 * is unit-testable without a viewer or a real gamepad.
 * @param {number} currentIndex Current index, or -1 before any cycle.
 * @param {number} direction +1 (next) or -1 (previous).
 * @param {number} count Number of locations to cycle through.
 * @returns {number} The next index, wrapped into [0, count), or -1 when count is 0.
 */
export function nextLocationIndex(currentIndex, direction, count) {
  if (!(count > 0)) return -1;
  if (!Number.isInteger(currentIndex) || currentIndex < 0) {
    return direction < 0 ? count - 1 : 0;
  }
  return (((currentIndex + direction) % count) + count) % count;
}

/**
 * Read one gamepad's relevant sticks/triggers into shaped inputs.
 * @param {Gamepad|null|undefined} pad
 * @param {number} [deadzone]
 * @returns {{strafe: number, forward: number, lookX: number, lookY: number,
 *  vertical: number}|null} Null when the pad is absent or at rest.
 */
export function readGamepadInput(pad, deadzone = DEADZONE) {
  if (!pad) return null;
  const strafe = shapeAxis(pad.axes?.[0], deadzone);
  const forward = shapeAxis(pad.axes?.[1], deadzone);
  const lookX = shapeAxis(pad.axes?.[2], deadzone);
  const lookY = shapeAxis(pad.axes?.[3], deadzone);
  const vertical = triggerValue(pad, BUTTON_RT) - triggerValue(pad, BUTTON_LT);
  if (!strafe && !forward && !lookX && !lookY && !vertical) return null;
  return { strafe, forward, lookX, lookY, vertical };
}

/**
 * Pure step computation, free of Cesium's Camera class so it is
 * unit-testable without a viewer.
 * @param {{strafe:number,forward:number,lookX:number,lookY:number,vertical:number}} input
 * @param {{heightM: number, pitchRad: number}} camera Current camera pose.
 * @param {number} dt Seconds elapsed.
 * @returns {{moveForwardM:number, moveRightM:number, moveUpM:number,
 *  lookRightRad:number, pitchRad:number}} Deltas/targets to apply.
 */
export function gamepadCameraStep(input, { heightM, pitchRad }, dt) {
  const height = Math.max(50, Number.isFinite(heightM) ? heightM : 50);
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
  const panStep = height * PAN_VIEW_FRACTION_S * step;
  const vertStep = height * VERTICAL_VIEW_FRACTION_S * step;
  const lookStepRad = Cesium.Math.toRadians(LOOK_DEG_S) * step;
  const currentPitch = Number.isFinite(pitchRad) ? pitchRad : 0;
  const nextPitch = Math.min(
    PITCH_MAX,
    Math.max(PITCH_MIN, currentPitch - input.lookY * lookStepRad),
  );
  return {
    // Stick forward reads as a negative axis value on standard gamepads.
    moveForwardM: -input.forward * panStep,
    moveRightM: input.strafe * panStep,
    moveUpM: input.vertical * vertStep,
    lookRightRad: input.lookX * lookStepRad,
    pitchRad: nextPitch,
  };
}

function applyStep(cam, step) {
  if (step.moveForwardM > 0) cam.moveForward(step.moveForwardM);
  else if (step.moveForwardM < 0) cam.moveBackward(-step.moveForwardM);
  if (step.moveRightM > 0) cam.moveRight(step.moveRightM);
  else if (step.moveRightM < 0) cam.moveLeft(-step.moveRightM);
  if (step.moveUpM > 0) cam.moveUp(step.moveUpM);
  else if (step.moveUpM < 0) cam.moveDown(-step.moveUpM);
  if (step.lookRightRad > 0) cam.lookRight(step.lookRightRad);
  else if (step.lookRightRad < 0) cam.lookLeft(-step.lookRightRad);
  const pitchDelta = step.pitchRad - cam.pitch;
  if (pitchDelta > 1e-9) cam.lookUp(pitchDelta);
  else if (pitchDelta < -1e-9) cam.lookDown(-pitchDelta);
}

/**
 * Start polling gamepads and driving the viewer's camera. Safe to call once
 * per viewer lifetime; idempotent teardown via the returned disposer.
 * @param {Cesium.Viewer} viewer
 * @returns {Function} Disposer — stops polling.
 */
export function initGamepadCamera(viewer) {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) {
    return () => {};
  }
  let disposed = false;
  let lastMs = performance.now();
  let rafId = null;
  let lastLbPressed = false;
  let lastRbPressed = false;
  let locationIndex = -1;

  function cycleLocation(direction) {
    const cityIds = Object.keys(CITY_POIS);
    locationIndex = nextLocationIndex(locationIndex, direction, cityIds.length);
    if (locationIndex < 0) return;
    interruptCameraMotion('gamepad-input');
    flyToPresetLocation(viewer, cityIds[locationIndex]);
    governorRequestRender('gamepad-location');
  }

  function frame() {
    if (disposed) return;
    const nowMs = performance.now();
    const dt = Math.min(0.25, Math.max(0, (nowMs - lastMs) / 1000));
    lastMs = nowMs;
    if (!viewer.isDestroyed()) {
      const pads = navigator.getGamepads() || [];
      const pad = pads.find((candidate) => candidate);
      if (pad) {
        const lbPressed = isButtonPressed(pad, BUTTON_LB);
        const rbPressed = isButtonPressed(pad, BUTTON_RB);
        if (lbPressed && !lastLbPressed) cycleLocation(-1);
        if (rbPressed && !lastRbPressed) cycleLocation(1);
        lastLbPressed = lbPressed;
        lastRbPressed = rbPressed;

        const input = readGamepadInput(pad);
        if (input) {
          interruptCameraMotion('gamepad-input');
          const cam = viewer.camera;
          const step = gamepadCameraStep(
            input,
            { heightM: cam.positionCartographic?.height, pitchRad: cam.pitch },
            dt,
          );
          applyStep(cam, step);
          governorRequestRender('gamepad-input');
        }
      } else {
        lastLbPressed = false;
        lastRbPressed = false;
      }
    }
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  return function dispose() {
    disposed = true;
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
  };
}
