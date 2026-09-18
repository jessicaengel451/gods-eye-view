import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shapeAxis,
  buttonValue,
  isButtonPressed,
  nextLocationIndex,
  readGamepadInput,
  gamepadCameraStep,
} from './gamepadCamera.js';

test('shapeAxis kills noise inside the deadzone and reaches full deflection at the edge', () => {
  assert.equal(shapeAxis(0), 0);
  assert.equal(shapeAxis(0.1), 0); // inside default deadzone
  assert.equal(shapeAxis(1), 1);
  assert.equal(shapeAxis(-1), -1);
  assert.ok(shapeAxis(0.5) > 0 && shapeAxis(0.5) < 0.5); // quadratic curve, gentle near centre
});

test('shapeAxis clamps out-of-range and non-finite input', () => {
  assert.equal(shapeAxis(5), 1);
  assert.equal(shapeAxis(-5), -1);
  assert.equal(shapeAxis(NaN), 0);
  assert.equal(shapeAxis(undefined), 0);
});

test('buttonValue reads analog triggers and falls back to digital buttons', () => {
  assert.equal(buttonValue({ buttons: [{ value: 0.42 }] }, 0), 0.42);
  assert.equal(buttonValue({ buttons: [{ pressed: true }] }, 0), 1);
  assert.equal(buttonValue({ buttons: [{ pressed: false }] }, 0), 0);
  assert.equal(buttonValue({ buttons: [] }, 0), 0);
  assert.equal(buttonValue(null, 0), 0);
});

test('readGamepadInput returns null for a missing or resting pad', () => {
  assert.equal(readGamepadInput(null), null);
  assert.equal(
    readGamepadInput({ axes: [0, 0, 0, 0], buttons: [] }),
    null,
  );
});

test('readGamepadInput reports shaped sticks and the trigger difference', () => {
  const pad = {
    axes: [1, -1, 0.5, -0.5],
    buttons: Array(8).fill({ value: 0 }),
  };
  pad.buttons[7] = { value: 0.8 }; // RT
  pad.buttons[6] = { value: 0.2 }; // LT
  const input = readGamepadInput(pad);
  assert.ok(input);
  assert.equal(input.strafe, 1);
  assert.equal(input.forward, -1);
  assert.ok(input.lookX > 0);
  assert.ok(input.lookY < 0);
  assert.ok(input.vertical > 0); // ascend wins over descend
});

test('gamepadCameraStep converts a forward-pushed stick into forward motion', () => {
  const input = { strafe: 0, forward: -1, lookX: 0, lookY: 0, vertical: 0 };
  const step = gamepadCameraStep(input, { heightM: 1000, pitchRad: 0 }, 1);
  assert.ok(step.moveForwardM > 0);
  assert.equal(step.moveRightM, 0);
  assert.equal(step.moveUpM, 0);
});

test('gamepadCameraStep clamps pitch so looking up cannot flip past the ceiling', () => {
  const input = { strafe: 0, forward: 0, lookX: 0, lookY: -1, vertical: 0 };
  const step = gamepadCameraStep(
    input,
    { heightM: 1000, pitchRad: Math.PI / 3 },
    10,
  );
  assert.ok(step.pitchRad <= Math.PI / 3 + 1e-9);
});

test('isButtonPressed reads a digital pressed flag, or falls back to analog value', () => {
  assert.equal(isButtonPressed({ buttons: [{ pressed: true }] }, 0), true);
  assert.equal(isButtonPressed({ buttons: [{ pressed: false }] }, 0), false);
  assert.equal(isButtonPressed({ buttons: [{ value: 0.9 }] }, 0), true);
  assert.equal(isButtonPressed({ buttons: [{ value: 0.1 }] }, 0), false);
  assert.equal(isButtonPressed(null, 0), false);
});

test('nextLocationIndex wraps forward and backward through the location list', () => {
  assert.equal(nextLocationIndex(-1, 1, 3), 0); // first press starts at the first location
  assert.equal(nextLocationIndex(0, 1, 3), 1);
  assert.equal(nextLocationIndex(2, 1, 3), 0); // wraps forward past the end
  assert.equal(nextLocationIndex(0, -1, 3), 2); // wraps backward past the start
  assert.equal(nextLocationIndex(-1, -1, 3), 2);
});

test('nextLocationIndex is inert with no locations to cycle through', () => {
  assert.equal(nextLocationIndex(-1, 1, 0), -1);
});

test('gamepadCameraStep scales pan speed with camera height', () => {
  const input = { strafe: 1, forward: 0, lookX: 0, lookY: 0, vertical: 0 };
  const low = gamepadCameraStep(input, { heightM: 100, pitchRad: 0 }, 1);
  const high = gamepadCameraStep(input, { heightM: 10000, pitchRad: 0 }, 1);
  assert.ok(high.moveRightM > low.moveRightM);
});
